package main

import (
	"fmt"
	"net"
	"os"

	"golang.org/x/sys/unix"
)

// samePeerUser refuses a takeover peer that is not a connector of this node: another process of the same user.
func samePeerUser(connection *net.UnixConn) error {
	raw, err := connection.SyscallConn()
	if err != nil {
		return err
	}
	var credentials *unix.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		credentials, credErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return err
	}
	if credErr != nil {
		return fmt.Errorf("read the takeover peer: %w", credErr)
	}
	if int(credentials.Uid) != os.Getuid() {
		return fmt.Errorf("the takeover peer runs as uid %d, not as this connector's %d", credentials.Uid, os.Getuid())
	}
	return nil
}
