package main

import (
	"context"
	"net"
	"syscall"

	"golang.org/x/sys/unix"
)

// listenReusePort listens with SO_REUSEPORT: a replacement connector in the same network namespace (the anchor's)
// binds the egress address while the connector it replaces still serves it, and the kernel spreads new connections
// over both until the previous one stops accepting. Both run as the same user, as the kernel requires.
func listenReusePort(address string) (net.Listener, error) {
	config := net.ListenConfig{Control: func(_, _ string, raw syscall.RawConn) error {
		var socketErr error
		if err := raw.Control(func(fd uintptr) {
			socketErr = unix.SetsockoptInt(int(fd), unix.SOL_SOCKET, unix.SO_REUSEPORT, 1)
		}); err != nil {
			return err
		}
		return socketErr
	}}
	return config.Listen(context.Background(), "tcp4", address)
}
