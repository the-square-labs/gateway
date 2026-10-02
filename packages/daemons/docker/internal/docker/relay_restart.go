package docker

import (
	"net"
	"sync"
	"sync/atomic"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

// A graceful restart of this daemon (service restart, update) must look like
// a short hold to the traffic it serves, not like a member that died (B-13,
// rc20pre3: 1.9-4.1 s of 502 on the HA routes of the restarting holder while
// its standbys refused too). Before the process stops, every serving
// registration is renewed RESTARTING on the relays that understand it: they
// keep the registration until the next process registers, answer new tunnels
// "restarting" (nginx daemons retry and hold the connection) and report the
// holder's endpoint RESTARTING (nginx keeps the member socket). The process
// then lets the requests it serves finish and closes tunnels idle between
// requests, so nginx reconnects them into the hold.

const (
	// restartAnnounceWait bounds the wait for the relays to confirm the
	// announcement.
	restartAnnounceWait = 500 * time.Millisecond
	// restartDrainLimit bounds the wait for requests in flight: the next
	// process starts only after this one exited, and held requests wait.
	restartDrainLimit = time.Second
	restartIdleQuiet  = 100 * time.Millisecond
	restartDrainTick  = 20 * time.Millisecond
	// endpointRestartCapability is the relay capability that keeps a
	// restarting endpoint's registration (relay broker.EndpointRestartCapability).
	endpointRestartCapability = "endpoint_restart_v1"
)

// AnnounceRestart implements lifecycle.RestartAnnouncerPlugin. The link sockets go to the next process first, so
// the connections workloads open from here on wait in their backlog instead of reaching a process that stops
// (link_listener_handover.go); the link connections in the middle of a request finish with the Secure Link tunnels.
func (p *DockerPlugin) AnnounceRestart() {
	if handed := p.suspendLinkListeners(); handed > 0 {
		p.logger.Info("handing link sockets over to the next daemon process", "sockets", handed)
	}
	acks := p.announceRestartToRelays()
	deadline := time.After(restartAnnounceWait)
	for _, ack := range acks {
		select {
		case <-ack:
		case <-deadline:
			p.logger.Warn("relays did not confirm the restart announcement in time", "announced", len(acks))
			goto drain
		}
	}
drain:
	if len(acks) > 0 {
		p.logger.Info("announced the restart to the relays", "registrations", len(acks))
		// The next process takes over the registrations the relays hold for it without waiting for Gateway.
		if err := writeRestartMarker(p.cfg.StateDir, time.Now()); err != nil {
			p.logger.Warn("could not record the restart announcement; the next process waits for Gateway before it registers", "error", err)
		}
	}
	links := make(chan int, 1)
	go func() { links <- p.linkFlows.drain(restartDrainLimit) }()
	p.proxyTunnels.drain(restartDrainLimit)
	if busy := <-links; busy > 0 {
		p.logger.Info("link connections still busy when the restart drain ended are cut", "connections", busy)
	}
}

// announceRestartToRelays renews every serving registration RESTARTING on
// relays that support it and returns the channels closed once each relay
// confirmed. Registrations are frozen from here on.
func (p *DockerPlugin) announceRestartToRelays() []<-chan struct{} {
	p.restartAnnounced.Store(true)
	p.relayTunnelMu.Lock()
	routers := make([]*relayTunnelRouter, 0, len(p.relayTunnels))
	for _, router := range p.relayTunnels {
		if router != nil {
			routers = append(routers, router)
		}
	}
	p.relayTunnelMu.Unlock()
	var acks []<-chan struct{}
	for _, router := range routers {
		router.mu.Lock()
		for _, registration := range router.registrations {
			if !registrationServes(registration.state) || !relaySupportsRestart(registration.latest) {
				continue
			}
			registration.state = relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_RESTARTING
			registration.restartAck = make(chan struct{})
			acks = append(acks, registration.restartAck)
			queueLatestRelayGrant(registration.renew, relayRegistrationUpdate{assignment: registration.latest, state: registration.state})
		}
		router.mu.Unlock()
	}
	return acks
}

func registrationServes(state relayv1.EndpointServingState) bool {
	return state == relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING ||
		state == relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_UNSPECIFIED
}

// relaySupportsRestart reports a registration on a relay that keeps a
// restarting endpoint: any other relay would read RESTARTING as DORMANT and
// cut the tunnels at once.
func relaySupportsRestart(assignment *pb.RelayGrantAssignment) bool {
	candidates := assignment.GetCandidates()
	if len(candidates) != 1 {
		return false
	}
	for _, capability := range candidates[0].GetCapabilities() {
		if capability == endpointRestartCapability {
			return true
		}
	}
	return false
}

// proxyTunnelSet tracks the Secure Link tunnels this daemon serves.
type proxyTunnelSet struct {
	mu      sync.Mutex
	tunnels map[*drainConn]func()
}

func (s *proxyTunnelSet) add(connection *drainConn, cancel func()) func() {
	s.mu.Lock()
	if s.tunnels == nil {
		s.tunnels = map[*drainConn]func(){}
	}
	s.tunnels[connection] = cancel
	s.mu.Unlock()
	return func() {
		s.mu.Lock()
		delete(s.tunnels, connection)
		s.mu.Unlock()
	}
}

// drain waits up to limit for the tunnels serving a request, closing every
// tunnel as soon as it is idle between requests.
func (s *proxyTunnelSet) drain(limit time.Duration) {
	s.drainWhere(func(*drainConn) bool { return true }, limit, restartDrainTick)
}

// drainWhere drains the tunnels match selects like drain, and reports how
// many were still busy when limit ran out.
func (s *proxyTunnelSet) drainWhere(match func(*drainConn) bool, limit, tick time.Duration) int {
	deadline := time.Now().Add(limit)
	for {
		now := time.Now()
		busy := 0
		s.mu.Lock()
		for connection, cancel := range s.tunnels {
			if !match(connection) {
				continue
			}
			if connection.idle(now, restartIdleQuiet) {
				cancel()
				delete(s.tunnels, connection)
				continue
			}
			busy++
		}
		s.mu.Unlock()
		if busy == 0 || !now.Before(deadline) {
			return busy
		}
		time.Sleep(tick)
	}
}

// drainConn is the connection to the workload behind a Secure Link tunnel. It
// records when a request last went in (Write) and an answer last came out
// (Read).
type drainConn struct {
	net.Conn
	opened    int64
	lastWrite atomic.Int64
	lastRead  atomic.Int64
}

func newDrainConn(connection net.Conn) *drainConn {
	return &drainConn{Conn: connection, opened: time.Now().UnixNano()}
}

func (c *drainConn) Read(buffer []byte) (int, error) {
	n, err := c.Conn.Read(buffer)
	if n > 0 {
		c.lastRead.Store(time.Now().UnixNano())
	}
	return n, err
}

func (c *drainConn) Write(buffer []byte) (int, error) {
	n, err := c.Conn.Write(buffer)
	if n > 0 {
		c.lastWrite.Store(time.Now().UnixNano())
	}
	return n, err
}

// CloseWrite passes a half-close on to the workload.
func (c *drainConn) CloseWrite() error {
	if closer, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return closer.CloseWrite()
	}
	return nil
}

// idle reports a tunnel whose last request was answered and that carried no
// byte for quiet; a tunnel that has not carried a request yet counts as idle
// once it has been open for quiet.
func (c *drainConn) idle(now time.Time, quiet time.Duration) bool {
	read, write := c.lastRead.Load(), c.lastWrite.Load()
	last := max(read, write, c.opened)
	if now.UnixNano()-last < quiet.Nanoseconds() {
		return false
	}
	return write == 0 || read >= write
}
