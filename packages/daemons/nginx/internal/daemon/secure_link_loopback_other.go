//go:build !linux

package daemon

import (
	"errors"
	"net"
)

func resetSocket(connection net.Conn) error {
	return setSocketLinger(connection, 0)
}

func secureLinkLoopbackPeerUID(net.Conn) (int, error) {
	return 0, errors.New("secure-link loopback peer credentials require Linux")
}
