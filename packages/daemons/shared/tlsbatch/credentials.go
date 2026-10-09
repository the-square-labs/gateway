package tlsbatch

import (
	"context"
	"net"

	"google.golang.org/grpc/credentials"
)

// Credentials makes the connections of TLS transport credentials send each
// Write's records in one write (see the package comment).
func Credentials(inner credentials.TransportCredentials) credentials.TransportCredentials {
	return batchedCredentials{TransportCredentials: inner}
}

type batchedCredentials struct {
	credentials.TransportCredentials
}

func (c batchedCredentials) ClientHandshake(ctx context.Context, authority string, raw net.Conn) (net.Conn, credentials.AuthInfo, error) {
	below := Below(raw)
	conn, info, err := c.TransportCredentials.ClientHandshake(ctx, authority, below)
	if err != nil {
		return nil, nil, err
	}
	return Above(conn, below), info, nil
}

func (c batchedCredentials) ServerHandshake(raw net.Conn) (net.Conn, credentials.AuthInfo, error) {
	below := Below(raw)
	conn, info, err := c.TransportCredentials.ServerHandshake(below)
	if err != nil {
		return nil, nil, err
	}
	return Above(conn, below), info, nil
}

func (c batchedCredentials) Clone() credentials.TransportCredentials {
	return batchedCredentials{TransportCredentials: c.TransportCredentials.Clone()}
}
