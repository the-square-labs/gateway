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

// CredentialsWithHook is Credentials that also hands each client connection's
// raw side to dialed once its handshake succeeded (a relay lane keeps the
// socket beneath it to renew it).
func CredentialsWithHook(inner credentials.TransportCredentials, dialed func(*Conn)) credentials.TransportCredentials {
	return batchedCredentials{TransportCredentials: inner, dialed: dialed}
}

type batchedCredentials struct {
	credentials.TransportCredentials
	dialed func(*Conn)
}

func (c batchedCredentials) ClientHandshake(ctx context.Context, authority string, raw net.Conn) (net.Conn, credentials.AuthInfo, error) {
	below := Below(raw)
	conn, info, err := c.TransportCredentials.ClientHandshake(ctx, authority, below)
	if err != nil {
		return nil, nil, err
	}
	if c.dialed != nil {
		c.dialed(below)
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
	return batchedCredentials{TransportCredentials: c.TransportCredentials.Clone(), dialed: c.dialed}
}
