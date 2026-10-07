package lifecycle

import (
	"context"
	"net"
	"slices"
	"sync"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/connector"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/connectivity"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
)

const relayLatencyProbeTimeout = 5 * time.Second

// RelayLatencyTargetPlugin names the pool relays to measure beyond those the
// daemon holds transports to, so Gateway learns about nearer relays it has
// not assigned yet.
type RelayLatencyTargetPlugin interface {
	RelayLatencyTargets() []RelayTunnelTarget
}

// relayTransports holds the open lanes of each relay target; latency probes
// run on them instead of opening connections.
type relayTransports struct {
	mu    sync.Mutex
	conns map[string][]*grpc.ClientConn
}

var liveRelayTransports = &relayTransports{conns: map[string][]*grpc.ClientConn{}}

func (t *relayTransports) add(relayInstanceID string, conn *grpc.ClientConn) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.conns[relayInstanceID] = append(t.conns[relayInstanceID], conn)
}

// remove forgets the lanes in conns; lanes of the target opened since stay.
func (t *relayTransports) remove(relayInstanceID string, conns []*grpc.ClientConn) {
	t.mu.Lock()
	defer t.mu.Unlock()
	kept := slices.DeleteFunc(t.conns[relayInstanceID], func(conn *grpc.ClientConn) bool { return slices.Contains(conns, conn) })
	if len(kept) == 0 {
		delete(t.conns, relayInstanceID)
		return
	}
	t.conns[relayInstanceID] = kept
}

func (t *relayTransports) get(relayInstanceID string) []*grpc.ClientConn {
	t.mu.Lock()
	defer t.mu.Unlock()
	return slices.Clone(t.conns[relayInstanceID])
}

// runRelayLatencyProbes measures the round trip to every relay each
// interval and feeds relaybridge.Latency, which tunnel selection and the
// health report read.
func runRelayLatencyProbes(ctx context.Context, conn *connector.Connector, plugin RelayPoolTunnelPlugin) {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		targets, laneTargets := relayLatencyTargets(plugin)
		probeRelayLatencies(ctx, targets, laneTargets, liveRelayTransports, conn.Address, relaybridge.Latency)
		timer.Reset(relaybridge.LatencySampleInterval)
	}
}

// relayLatencyTargets lists the relays to measure and, apart, the ones this daemon keeps lanes to.
func relayLatencyTargets(plugin RelayPoolTunnelPlugin) ([]RelayTunnelTarget, map[string]bool) {
	byID := map[string]RelayTunnelTarget{}
	if extra, ok := plugin.(RelayLatencyTargetPlugin); ok {
		for _, target := range extra.RelayLatencyTargets() {
			byID[target.ID] = target
		}
	}
	laneTargets := map[string]bool{}
	for _, target := range plugin.RelayTunnelTargets() {
		byID[target.ID] = target
		laneTargets[target.ID] = true
	}
	result := make([]RelayTunnelTarget, 0, len(byID))
	for _, target := range byID {
		if target.ID != "" {
			result = append(result, target)
		}
	}
	return result, laneTargets
}

// probeRelayLatencies takes one sample per relay: the shortest RPC round trip
// on its open lanes for a relay this daemon keeps lanes to (laneTargets), else
// a TCP handshake to the relay (or to Gateway, whose host runs a relay without
// its own address). A lane relay whose lanes are down, missing or do not
// answer gets no sample and ages out: a TCP handshake answered by a relay this
// node cannot use (its TLS or gRPC failing) kept a fresh, short round trip in
// Gateway's placement. The shortest of the lanes is the one least held up
// behind this node's own tunnel data.
func probeRelayLatencies(ctx context.Context, targets []RelayTunnelTarget, laneTargets map[string]bool, transports *relayTransports, controlAddress string, tracker *relaybridge.LatencyTracker) {
	var wg sync.WaitGroup
	for _, target := range targets {
		wg.Add(1)
		go func(target RelayTunnelTarget) {
			defer wg.Done()
			probeCtx, cancel := context.WithTimeout(ctx, relayLatencyProbeTimeout)
			defer cancel()
			if lanes := transports.get(target.ID); len(lanes) > 0 || laneTargets[target.ID] {
				if rtt, ok := lanesRoundTrip(probeCtx, lanes); ok {
					tracker.Observe(target.ID, rtt)
				}
				return
			}
			addresses := target.Addresses
			if len(addresses) == 0 && controlAddress != "" {
				addresses = []string{controlAddress}
			}
			for _, address := range addresses {
				if rtt, ok := dialRoundTrip(probeCtx, address); ok {
					tracker.Observe(target.ID, rtt)
					return
				}
			}
		}(target)
	}
	wg.Wait()
}

// lanesRoundTrip is the shortest transportRoundTrip of the lanes, measured at once.
func lanesRoundTrip(ctx context.Context, lanes []*grpc.ClientConn) (time.Duration, bool) {
	results := make(chan time.Duration, len(lanes))
	for _, lane := range lanes {
		go func() {
			rtt, ok := transportRoundTrip(ctx, lane)
			if !ok {
				rtt = 0
			}
			results <- rtt
		}()
	}
	var best time.Duration
	for range lanes {
		if rtt := <-results; rtt > 0 && (best == 0 || rtt < best) {
			best = rtt
		}
	}
	return best, best > 0
}

// transportRoundTrip times one unary RPC on an established transport. The
// relay answers the standard health check (or rejects it as unimplemented)
// without doing work, so any answer from it is one network round trip.
func transportRoundTrip(ctx context.Context, conn *grpc.ClientConn) (time.Duration, bool) {
	if conn.GetState() != connectivity.Ready {
		return 0, false
	}
	started := time.Now()
	_, err := healthpb.NewHealthClient(conn).Check(ctx, &healthpb.HealthCheckRequest{})
	elapsed := time.Since(started)
	switch status.Code(err) {
	case codes.OK, codes.Unimplemented, codes.NotFound, codes.PermissionDenied, codes.Unauthenticated:
		return elapsed, true
	default:
		return 0, false
	}
}

// dialRoundTrip times a TCP handshake, which takes one round trip. The name
// is resolved first so DNS time is not counted.
func dialRoundTrip(ctx context.Context, address string) (time.Duration, bool) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return 0, false
	}
	if net.ParseIP(host) == nil {
		resolved, lookupErr := net.DefaultResolver.LookupHost(ctx, host)
		if lookupErr != nil || len(resolved) == 0 {
			return 0, false
		}
		host = resolved[0]
	}
	var dialer net.Dialer
	started := time.Now()
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, port))
	if err != nil {
		return 0, false
	}
	elapsed := time.Since(started)
	_ = conn.Close()
	return elapsed, true
}
