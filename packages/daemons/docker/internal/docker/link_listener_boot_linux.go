package docker

import (
	"net"
	"net/netip"
	"os"
	"syscall"

	"golang.org/x/sys/unix"
)

// bindFreeListener opens a listening TCP socket on address and port with IP_FREEBIND: at boot the address belongs to
// a Docker bridge that does not exist yet.
func bindFreeListener(address netip.Addr, port uint16) (*os.File, error) {
	fd, err := unix.Socket(unix.AF_INET, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, unix.IPPROTO_TCP)
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*os.File, error) {
		_ = unix.Close(fd)
		return nil, err
	}
	if err := unix.SetsockoptInt(fd, unix.SOL_SOCKET, unix.SO_REUSEADDR, 1); err != nil {
		return fail(err)
	}
	if err := unix.SetsockoptInt(fd, unix.IPPROTO_IP, unix.IP_FREEBIND, 1); err != nil {
		return fail(err)
	}
	if err := unix.Bind(fd, &unix.SockaddrInet4{Port: int(port), Addr: address.As4()}); err != nil {
		return fail(err)
	}
	if err := unix.Listen(fd, syscall.SOMAXCONN); err != nil {
		return fail(err)
	}
	return os.NewFile(uintptr(fd), hostListenerKeepName(address, port)), nil
}

// linkListenerPeerAllowed admits root and the owner of the handover directory (the daemon) to the handover.
func linkListenerPeerAllowed(connection *net.UnixConn, directory string) bool {
	raw, err := connection.SyscallConn()
	if err != nil {
		return false
	}
	var credentials *unix.Ucred
	var credentialsErr error
	if err := raw.Control(func(fd uintptr) {
		credentials, credentialsErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil || credentialsErr != nil {
		return false
	}
	if credentials.Uid == 0 {
		return true
	}
	info, err := os.Stat(directory)
	if err != nil {
		return false
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	return ok && owner.Uid == credentials.Uid
}
