//go:build !linux

package docker

import (
	"errors"
	"net"
	"net/netip"
	"os"
)

// The boot step that opens database link listeners before Docker needs IP_FREEBIND (Linux).
func bindFreeListener(netip.Addr, uint16) (*os.File, error) {
	return nil, errors.New("database link listeners open before Docker on Linux only")
}

func linkListenerPeerAllowed(*net.UnixConn, string) bool { return false }
