package main

import (
	"errors"
	"net"
	"net/netip"
	"sync/atomic"
)

// ingressPeer is the only address the ingress listeners accept: the management network's gateway, from which the
// daemon dials. The connector joins many networks, and Linux accepts a packet for any of its addresses on any of
// them: a workload able to route (NET_ADMIN) on a link or target network could otherwise reach the ingress listeners,
// and through them other links' targets. Unset (a v1 request of an older daemon), every peer is accepted as before.
type ingressPeer struct {
	address atomic.Pointer[netip.Addr]
}

// set records the peer of a v2 request ("" in a v1 request: none).
func (p *ingressPeer) set(value string) error {
	if value == "" {
		p.address.Store(nil)
		return nil
	}
	address, err := netip.ParseAddr(value)
	if err != nil || address.IsUnspecified() || address.IsMulticast() {
		return errors.New("invalid secure-link ingress peer")
	}
	address = address.Unmap()
	p.address.Store(&address)
	return nil
}

func (p *ingressPeer) allows(remote net.Addr) bool {
	if p == nil {
		return true
	}
	allowed := p.address.Load()
	if allowed == nil {
		return true
	}
	tcp, ok := remote.(*net.TCPAddr)
	if !ok {
		return false
	}
	address, ok := netip.AddrFromSlice(tcp.IP)
	return ok && address.Unmap() == *allowed
}
