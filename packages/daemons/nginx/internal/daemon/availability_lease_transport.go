package daemon

import (
	"context"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
)

// runForTarget watches one relay's lease gate views for the life of ctx, over
// one of the daemon's existing relay transports (the nginx daemon already
// dials every relay target for Secure Link tunnel lanes, and reuses one of
// those connections here instead of opening a new one). nginx daemons are
// observers only (A18-A20): they never vote, so this is the only lease RPC
// they use. Only one lane per relay target actually watches it; extra lanes
// to the same relay no-op.
func (c *availabilityLeaseCoordinator) runForTarget(ctx context.Context, conn *grpc.ClientConn, relayID string) {
	if relayID == "" || !c.claimWatch(relayID) {
		return
	}
	defer c.releaseWatch(relayID)
	client := relayv1.NewTunnelBrokerClient(conn)
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

func (c *availabilityLeaseCoordinator) claimWatch(relayID string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.watched[relayID] {
		return false
	}
	c.watched[relayID] = true
	return true
}

func (c *availabilityLeaseCoordinator) releaseWatch(relayID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.watched, relayID)
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
