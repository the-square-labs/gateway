package listenerkeep

import (
	"errors"
	"net"
	"time"

	"golang.org/x/sys/unix"
)

// flushChannel waits until the peer of a datagram channel dequeued everything
// sent on it: the kernel charges each queued datagram to its sender until the
// receiver takes it (SIOCOUTQ).
func flushChannel(channel *net.UnixConn, timeout time.Duration) error {
	raw, err := channel.SyscallConn()
	if err != nil {
		return err
	}
	deadline := time.Now().Add(timeout)
	for {
		queued := 0
		var ioctlErr error
		if err := raw.Control(func(fd uintptr) {
			queued, ioctlErr = unix.IoctlGetInt(int(fd), unix.SIOCOUTQ)
		}); err != nil {
			return err
		}
		if ioctlErr != nil {
			return ioctlErr
		}
		if queued == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("the listener keeper did not take the messages in time")
		}
		time.Sleep(2 * time.Millisecond)
	}
}
