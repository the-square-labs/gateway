package lifecycle

import (
	"context"
	"net"
	"sync"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/connector"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/connectivity"
	healthpb "google.golang.org/grpc/health/grpc_health_v1"
	"google.golang.org/grpc/status"
)

const relayLatencyProbeTimeout = 5 * time.Second

// RelayLatencyTargetPlugin names the pool relays to measure beyond those the
// daemon holds transports to, so Gateway learns about nearer relays it has
// not assigned yet.
type RelayLatencyTargetPlugin interface {
	RelayLatencyTargets() []RelayTunnelTarget
}

// relayTransports holds one open transport per relay target; latency probes
// run on it instead of opening connections.
type relayTransports struct {
	mu    sync.Mutex
	conns map[string]*grpc.ClientConn
}

var liveRelayTransports = &relayTransports{conns: map[string]*grpc.ClientConn{}}

func (t *relayTransports) set(relayInstanceID string, conn *grpc.ClientConn) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.conns[relayInstanceID] = conn
}

func (t *relayTransports) clear(relayInstanceID string, conn *grpc.ClientConn) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.conns[relayInstanceID] == conn {
		delete(t.conns, relayInstanceID)
	}
}

func (t *relayTransports) get(relayInstanceID string) *grpc.ClientConn {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.conns[relayInstanceID]
}

// runRelayLatencyProbes measures the round trip to every relay each
// interval and feeds relaybridge.Latency, which tunnel selection and the
// health report read.
func runRelayLatencyProbes(ctx context.Context, conn *connector.Connector, plugin RelayPoolTunnelPlugin) {
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		probeRelayLatencies(ctx, relayLatencyTargets(plugin), liveRelayTransports, conn.Address, relaybridge.Latency)
		timer.Reset(relaybridge.LatencySampleInterval)
	}
}

func relayLatencyTargets(plugin RelayPoolTunnelPlugin) []RelayTunnelTarget {
	byID := map[string]RelayTunnelTarget{}
	if extra, ok := plugin.(RelayLatencyTargetPlugin); ok {
		for _, target := range extra.RelayLatencyTargets() {
			byID[target.ID] = target
		}
	}
	for _, target := range plugin.RelayTunnelTargets() {
		byID[target.ID] = target
	}
	result := make([]RelayTunnelTarget, 0, len(byID))
	for _, target := range byID {
		if target.ID != "" {
			result = append(result, target)
		}
	}
	return result
}

// probeRelayLatencies takes one sample per relay: an RPC round trip on the
// open transport when there is one, else a TCP handshake to the relay (or to
// Gateway, whose host runs a relay without its own address).
func probeRelayLatencies(ctx context.Context, targets []RelayTunnelTarget, transports *relayTransports, controlAddress string, tracker *relaybridge.LatencyTracker) {
	var wg sync.WaitGroup
	for _, target := range targets {
		wg.Add(1)
		go func(target RelayTunnelTarget) {
			defer wg.Done()
			probeCtx, cancel := context.WithTimeout(ctx, relayLatencyProbeTimeout)
			defer cancel()
			if transport := transports.get(target.ID); transport != nil {
				if rtt, ok := transportRoundTrip(probeCtx, transport); ok {
					tracker.Observe(target.ID, rtt)
					return
				}
			}
			addresses := target.Addresses
			if len(addresses) == 0 && controlAddress != "" {
				addresses = []string{controlAddress}
			}
			for _, address := range addresses {
				if rtt, ok := dialRoundTrip(probeCtx, address); ok {
					tracker.Observe(target.ID, rtt)
					return
				}
			}
		}(target)
	}
	wg.Wait()
}

// transportRoundTrip times one unary RPC on an established transport. The
// relay answers the standard health check (or rejects it as unimplemented)
// without doing work, so any answer from it is one network round trip.
func transportRoundTrip(ctx context.Context, conn *grpc.ClientConn) (time.Duration, bool) {
	if conn.GetState() != connectivity.Ready {
		return 0, false
	}
	started := time.Now()
	_, err := healthpb.NewHealthClient(conn).Check(ctx, &healthpb.HealthCheckRequest{})
	elapsed := time.Since(started)
	switch status.Code(err) {
	case codes.OK, codes.Unimplemented, codes.NotFound, codes.PermissionDenied, codes.Unauthenticated:
		return elapsed, true
	default:
		return 0, false
	}
}

// dialRoundTrip times a TCP handshake, which takes one round trip. The name
// is resolved first so DNS time is not counted.
func dialRoundTrip(ctx context.Context, address string) (time.Duration, bool) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return 0, false
	}
	if net.ParseIP(host) == nil {
		resolved, lookupErr := net.DefaultResolver.LookupHost(ctx, host)
		if lookupErr != nil || len(resolved) == 0 {
			return 0, false
		}
		host = resolved[0]
	}
	var dialer net.Dialer
	started := time.Now()
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(host, port))
	if err != nil {
		return 0, false
	}
	elapsed := time.Since(started)
	_ = conn.Close()
	return elapsed, true
}
