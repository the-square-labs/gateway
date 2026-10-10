//go:build !linux

package main

import (
	"errors"
	"net"
)

// samePeerUser: connectors run on Linux only; elsewhere a takeover is refused.
func samePeerUser(*net.UnixConn) error {
	return errors.New("session handover needs Linux")
}
