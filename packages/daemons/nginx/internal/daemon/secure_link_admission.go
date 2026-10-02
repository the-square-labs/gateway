package daemon

import (
	"errors"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"time"
)

// secureLinkSetupLimit bounds the connections of one listener manager that
// were accepted but have not reached their relay tunnel yet (authorizing,
// waiting for a lane, opening the tunnel). Established connections do not
// count: nginx bounds those itself.
const secureLinkSetupLimit = 1024

const (
	// secureLinkAuthorizeTimeout bounds a peer check.
	secureLinkAuthorizeTimeout = 2 * time.Second
	// secureLinkFirstByteWait bounds the wait for a connection's first bytes
	// before it is handed on anyway (a peer that speaks second).
	secureLinkFirstByteWait = 2 * time.Second
)

// setupLimiter is a non-blocking counting limiter.
type setupLimiter struct {
	inFlight atomic.Int64
	// limit overrides secureLinkSetupLimit when positive (tests).
	limit atomic.Int64
}

func (l *setupLimiter) tryAcquire() bool {
	limit := l.limit.Load()
	if limit <= 0 {
		limit = secureLinkSetupLimit
	}
	if l.inFlight.Add(1) > limit {
		l.inFlight.Add(-1)
		return false
	}
	return true
}

// releaseOnce returns a function that releases one acquired slot, once.
func (l *setupLimiter) releaseOnce() func() {
	var once sync.Once
	return func() { once.Do(func() { l.inFlight.Add(-1) }) }
}

// secureLinkEstablished tells the accept side that a connection reached its
// relay tunnel: it no longer counts against the setup limit, and a stopping
// daemon no longer waits for it to get there (HandOverSecureLinks).
func secureLinkEstablished(connection net.Conn) {
	tracked, ok := connection.(*trackedConn)
	if !ok {
		return
	}
	tracked.opened.Store(true)
	if tracked.established != nil {
		tracked.established()
	}
}

// awaitFirstBytes waits up to wait for the peer's first bytes and keeps them
// for the opener. It reports false when the peer closed or failed before
// sending anything; a peer that sends nothing within wait is handed on.
func awaitFirstBytes(connection *trackedConn, wait time.Duration) bool {
	if err := connection.Conn.SetReadDeadline(time.Now().Add(wait)); err != nil {
		return true
	}
	buffer := make([]byte, 4096)
	n, err := connection.Conn.Read(buffer)
	_ = connection.Conn.SetReadDeadline(time.Time{})
	if n > 0 {
		connection.pending = buffer[:n]
		connection.lastRead.Store(time.Now().UnixNano())
		return true
	}
	return err != nil && errors.Is(err, os.ErrDeadlineExceeded)
}
