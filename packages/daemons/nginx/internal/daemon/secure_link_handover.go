package daemon

import (
	"net"
	"sync/atomic"
	"time"
)

// A restart or update of the nginx daemon hands its Secure Link sockets over
// to the next daemon process instead of closing them (B-13). The listener
// keeper (the daemon launcher, and systemd's file descriptor store) holds a
// copy of every listening socket, so the socket keeps accepting connections
// into its backlog while no daemon process runs; the next process adopts it
// and serves them.
//
// The next process can only start once this one exited (systemctl restart
// stops the unit before it starts it again), so the stopping process keeps
// accepting while it lets the requests it serves finish and closes the
// connections that sit idle between requests. It stops accepting only at the
// end, gives the requests it accepted last a short moment, and exits: a new
// connection waits in the backlog for the restart itself, not for the drain
// as well (X1-9b: 1.7 s and two client timeouts at 50 rps).

const (
	// secureLinkHandoverDrain bounds how long a stopping daemon keeps serving
	// and accepting while the requests in flight finish.
	secureLinkHandoverDrain = 1500 * time.Millisecond
	// secureLinkHandoverFinish bounds the wait for the requests accepted just
	// before the sockets were handed over; new connections queue meanwhile.
	secureLinkHandoverFinish = 300 * time.Millisecond
	// secureLinkIdleQuiet is how long a served connection must have carried no
	// byte, with no request left unanswered, to count as idle between
	// requests.
	secureLinkIdleQuiet = 100 * time.Millisecond
	secureLinkDrainTick = 20 * time.Millisecond
)

// trackedConn records when bytes last moved in each direction, so a stopping
// daemon can tell a connection serving a request from one idle between
// requests.
type trackedConn struct {
	net.Conn
	accepted  int64
	lastRead  atomic.Int64
	lastWrite atomic.Int64
	// pending holds bytes read before the opener took over (awaitFirstBytes).
	pending []byte
	// established releases the connection's setup slot (secureLinkEstablished).
	established func()
}

func newTrackedConn(connection net.Conn) net.Conn {
	return &trackedConn{Conn: connection, accepted: time.Now().UnixNano()}
}

func (c *trackedConn) Read(buffer []byte) (int, error) {
	if len(c.pending) > 0 {
		n := copy(buffer, c.pending)
		c.pending = c.pending[n:]
		return n, nil
	}
	n, err := c.Conn.Read(buffer)
	if n > 0 {
		c.lastRead.Store(time.Now().UnixNano())
	}
	return n, err
}

func (c *trackedConn) Write(buffer []byte) (int, error) {
	n, err := c.Conn.Write(buffer)
	if n > 0 {
		c.lastWrite.Store(time.Now().UnixNano())
	}
	return n, err
}

// CloseWrite passes a relay half-close on to nginx.
func (c *trackedConn) CloseWrite() error {
	if closer, ok := c.Conn.(interface{ CloseWrite() error }); ok {
		return closer.CloseWrite()
	}
	return nil
}

// idle reports a connection that answered its last request and carried no
// byte for quiet: nginx keeps it for its next request. A connection not served
// yet, or with a request read after the last answer, or still moving bytes,
// is busy.
func (c *trackedConn) idle(now time.Time, quiet time.Duration) bool {
	read, write := c.lastRead.Load(), c.lastWrite.Load()
	if write == 0 || read > write {
		return false
	}
	return now.UnixNano()-write >= quiet.Nanoseconds()
}

// keptListeners counts the Unix listeners this process kept for its
// successor.
func (m *sourceLinkManager) keptListeners() int {
	if m == nil {
		return 0
	}
	m.mu.Lock()
	bindings := make([]*sourceLinkBinding, 0, len(m.bindings))
	for _, binding := range m.bindings {
		bindings = append(bindings, binding)
	}
	m.mu.Unlock()
	kept := 0
	for _, binding := range bindings {
		binding.leaseMu.Lock()
		if binding.unix != nil && binding.keptName != "" {
			kept++
		}
		binding.leaseMu.Unlock()
	}
	return kept
}

// suspendForHandover stops accepting on every Unix listener this process kept
// for its successor, without closing the sockets themselves, and reports how
// many it handed over. Listeners that are not kept keep accepting: closing
// them would only refuse connections earlier. Nothing creates a socket at a
// path afterwards (listenUnixSocket), so the successor finds the kept ones.
func (m *sourceLinkManager) suspendForHandover() int {
	if m == nil {
		return 0
	}
	m.suspended.Store(true)
	m.mu.Lock()
	bindings := make([]*sourceLinkBinding, 0, len(m.bindings))
	for _, binding := range m.bindings {
		bindings = append(bindings, binding)
	}
	m.mu.Unlock()
	handed := 0
	for _, binding := range bindings {
		binding.leaseMu.Lock()
		if binding.unix != nil && binding.keptName != "" {
			if unixListener, ok := binding.unix.(*net.UnixListener); ok {
				unixListener.SetUnlinkOnClose(false)
			}
			// Only this process's descriptor closes; the keeper's copies keep
			// the socket, and its backlog, alive for the successor.
			_ = binding.unix.Close()
			binding.unix = nil
			handed++
		}
		binding.leaseMu.Unlock()
	}
	return handed
}

// drainForHandover waits, up to limit, for the requests this process is
// serving, closing each connection as soon as it is idle between requests.
func (m *sourceLinkManager) drainForHandover(limit time.Duration) {
	if m == nil {
		return
	}
	deadline := time.Now().Add(limit)
	for {
		now := time.Now()
		busy := 0
		m.mu.Lock()
		bindings := make([]*sourceLinkBinding, 0, len(m.bindings))
		for _, binding := range m.bindings {
			bindings = append(bindings, binding)
		}
		m.mu.Unlock()
		for _, binding := range bindings {
			binding.activeMu.Lock()
			for connection := range binding.active {
				tracked, ok := connection.(*trackedConn)
				if ok && tracked.idle(now, secureLinkIdleQuiet) {
					_ = connection.Close()
					continue
				}
				busy++
			}
			binding.activeMu.Unlock()
		}
		if busy == 0 || !now.Before(deadline) {
			return
		}
		time.Sleep(secureLinkDrainTick)
	}
}

// HandOverSecureLinks runs when the daemon is asked to stop or exits for an
// update, before it disconnects from Gateway and the relays: the requests in
// flight finish on this process, which keeps accepting meanwhile, and then the
// Secure Link sockets go to the next daemon process. Without a listener keeper
// nothing changes: the sockets close with the process.
func (p *NginxPlugin) HandOverSecureLinks() {
	p.handoverOnce.Do(func() {
		if p.secureLinks.keptListeners()+p.registryLinks.keptListeners() == 0 {
			return
		}
		drain := func(limit time.Duration) {
			done := make(chan struct{})
			go func() {
				p.registryLinks.drainForHandover(limit)
				close(done)
			}()
			p.secureLinks.drainForHandover(limit)
			<-done
		}
		drain(secureLinkHandoverDrain)
		handed := p.secureLinks.suspendForHandover() + p.registryLinks.suspendForHandover()
		if p.logger != nil {
			p.logger.Info("handing Secure Link sockets over to the next daemon process", "sockets", handed)
		}
		drain(secureLinkHandoverFinish)
	})
}

// AnnounceRestart implements lifecycle.RestartAnnouncerPlugin: a daemon that
// exits for its staged update hands its sockets over the same way.
func (p *NginxPlugin) AnnounceRestart() {
	p.HandOverSecureLinks()
}
