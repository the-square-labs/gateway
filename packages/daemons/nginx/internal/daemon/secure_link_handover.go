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
// and serves them. Stopping, this process only stops accepting, lets the
// requests it is serving finish, and closes connections that sit idle between
// requests (nginx reconnects them into the backlog).

const (
	// secureLinkHandoverDrain bounds how long a stopping daemon waits for the
	// requests it is serving; the next process starts only after it exits,
	// and new connections wait in the backlog meanwhile.
	secureLinkHandoverDrain = 1500 * time.Millisecond
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
}

func newTrackedConn(connection net.Conn) net.Conn {
	return &trackedConn{Conn: connection, accepted: time.Now().UnixNano()}
}

func (c *trackedConn) Read(buffer []byte) (int, error) {
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

// HandOverSecureLinks runs when the daemon is asked to stop, before it
// disconnects from Gateway and the relays: the Secure Link sockets go to the
// next daemon process, and the requests in flight finish on this one. Without
// a listener keeper nothing changes: the sockets close with the process.
func (p *NginxPlugin) HandOverSecureLinks() {
	handed := p.secureLinks.suspendForHandover() + p.registryLinks.suspendForHandover()
	if handed == 0 {
		return
	}
	if p.logger != nil {
		p.logger.Info("handing Secure Link sockets over to the next daemon process", "sockets", handed)
	}
	done := make(chan struct{})
	go func() {
		p.registryLinks.drainForHandover(secureLinkHandoverDrain)
		close(done)
	}()
	p.secureLinks.drainForHandover(secureLinkHandoverDrain)
	<-done
}
