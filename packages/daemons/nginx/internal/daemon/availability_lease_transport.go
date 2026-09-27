package daemon

import (
	"context"
	"sync"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
)

// availabilityLeaseTransport implements availabilitylease.Transport, fanning
// outgoing frames out to every relay Coordinate stream this node currently
// holds: one per relay transport, D3.
type availabilityLeaseTransport struct {
	mu     sync.Mutex
	routes map[string]func(*relayv1.CoordinationFrame)
}

func newAvailabilityLeaseTransport() *availabilityLeaseTransport {
	return &availabilityLeaseTransport{routes: map[string]func(*relayv1.CoordinationFrame){}}
}

func (t *availabilityLeaseTransport) Send(frame *relayv1.CoordinationFrame) {
	t.mu.Lock()
	routes := make([]func(*relayv1.CoordinationFrame), 0, len(t.routes))
	for _, send := range t.routes {
		routes = append(routes, send)
	}
	t.mu.Unlock()
	for _, send := range routes {
		send(frame)
	}
}

func (t *availabilityLeaseTransport) attach(relayID string, send func(*relayv1.CoordinationFrame)) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.routes[relayID] = send
}

func (t *availabilityLeaseTransport) detach(relayID string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.routes, relayID)
}

// runForTarget drives this node's Coordinate stream and this relay's
// WatchLeaseGates stream over one of the daemon's existing relay transports
// (D3): the nginx daemon already dials every relay target for Secure Link
// tunnel lanes, and reuses one of those connections here instead of opening a
// new one. Only one lane per relay target actually leads coordination for
// that target; extra lanes to the same relay no-op.
func (c *availabilityLeaseCoordinator) runForTarget(ctx context.Context, conn *grpc.ClientConn, relayID string) {
	if relayID == "" || !c.claim(relayID) {
		return
	}
	defer c.release(relayID)
	client := relayv1.NewTunnelBrokerClient(conn)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); c.runCoordinate(ctx, client, relayID) }()
	go func() { defer wg.Done(); c.runWatchLeaseGates(ctx, client, relayID) }()
	wg.Wait()
}

func (c *availabilityLeaseCoordinator) claim(relayID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.leading[relayID] {
		return false
	}
	c.leading[relayID] = true
	return true
}

func (c *availabilityLeaseCoordinator) release(relayID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.leading, relayID)
}

// runCoordinate keeps one Coordinate stream to relayID open for the life of
// ctx, feeding every received frame to the Node and attaching this stream as
// an outgoing route for as long as it stays up.
func (c *availabilityLeaseCoordinator) runCoordinate(ctx context.Context, client relayv1.TunnelBrokerClient, relayID string) {
	for ctx.Err() == nil {
		node := c.currentNode()
		if node == nil {
			if !sleepContext(ctx, availabilityLeaseReconnectDelay) {
				return
			}
			continue
		}
		stream, err := client.Coordinate(ctx)
		if err != nil {
			c.logf("availability lease coordinate stream to relay %s failed: %v", relayID, err)
			if !sleepContext(ctx, availabilityLeaseReconnectDelay) {
				return
			}
			continue
		}
		c.transport.attach(relayID, func(frame *relayv1.CoordinationFrame) { _ = stream.Send(frame) })
		for {
			frame, recvErr := stream.Recv()
			if recvErr != nil {
				break
			}
			if err := node.ReceiveFrame(frame); err != nil {
				c.logf("availability lease frame from relay %s rejected: %v", relayID, err)
			}
		}
		c.transport.detach(relayID)
		if ctx.Err() != nil {
			return
		}
		if !sleepContext(ctx, availabilityLeaseReconnectDelay) {
			return
		}
	}
}

// runWatchLeaseGates keeps one WatchLeaseGates stream from relayID open for
// the life of ctx, updating the Secure Link gate tracker on every snapshot
// (D8, A8). On a broken stream it does not clear that relay's views: they
// simply age out on their own TTL (ha-t2-report.md section 3).
func (c *availabilityLeaseCoordinator) runWatchLeaseGates(ctx context.Context, client relayv1.TunnelBrokerClient, relayID string) {
	for ctx.Err() == nil {
		stream, err := client.WatchLeaseGates(ctx, &relayv1.LeaseGateWatchRequest{})
		if err != nil {
			c.logf("availability lease gate watch to relay %s failed: %v", relayID, err)
			if !sleepContext(ctx, availabilityLeaseReconnectDelay) {
				return
			}
			continue
		}
		for {
			snapshot, recvErr := stream.Recv()
			if recvErr != nil {
				break
			}
			c.gates.apply(relayID, snapshot, time.Now())
			c.reconcileSockets()
		}
		if ctx.Err() != nil {
			return
		}
		if !sleepContext(ctx, availabilityLeaseReconnectDelay) {
			return
		}
	}
}

func sleepContext(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
