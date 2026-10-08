//go:build !linux

package listenerkeep

import (
	"net"
	"time"
)

// flushChannel cannot see the channel's queue outside Linux: it waits a moment.
func flushChannel(_ *net.UnixConn, timeout time.Duration) error {
	time.Sleep(min(timeout, 50*time.Millisecond))
	return nil
}
