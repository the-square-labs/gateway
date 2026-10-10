//go:build !linux

package handover

import "net"

// splicer is Linux only: elsewhere a pipe copies through its buffers.
type splicer struct{}

func newSplicer(net.Conn, net.Conn) *splicer { return nil }

func (*splicer) run(*[]byte) error { return nil }

func (*splicer) close() {}
