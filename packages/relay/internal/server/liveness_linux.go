//go:build linux

package server

import (
	"errors"
	"net"
	"syscall"
	"time"
)

// tcpUserTimeout is TCP_USER_TIMEOUT from linux/tcp.h.
const tcpUserTimeout = 0x12

// setAckTimeout bounds how long data sent on a TCP connection may stay
// unacknowledged before the kernel closes the connection.
func setAckTimeout(connection net.Conn, timeout time.Duration) error {
	tcp, ok := tcpConn(connection)
	if !ok {
		return errors.New("not a TCP connection")
	}
	raw, err := tcp.SyscallConn()
	if err != nil {
		return err
	}
	var setErr error
	if err := raw.Control(func(fd uintptr) {
		setErr = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, tcpUserTimeout, int(timeout.Milliseconds()))
	}); err != nil {
		return err
	}
	return setErr
}

func ackTimeout(connection net.Conn) (time.Duration, error) {
	tcp, ok := tcpConn(connection)
	if !ok {
		return 0, errors.New("not a TCP connection")
	}
	raw, err := tcp.SyscallConn()
	if err != nil {
		return 0, err
	}
	var value int
	var getErr error
	if err := raw.Control(func(fd uintptr) {
		value, getErr = syscall.GetsockoptInt(int(fd), syscall.IPPROTO_TCP, tcpUserTimeout)
	}); err != nil {
		return 0, err
	}
	return time.Duration(value) * time.Millisecond, getErr
}
