package docker

import (
	"context"
	"slices"
	"sync"
	"sync/atomic"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
)

// relaySourceLane is one transport to a relay that source tunnels open on. The relay pool opens several lanes per
// relay (the bundle's data lanes); the first carries the endpoint registrations and their incoming tunnels, and source
// tunnels go to the least busy connected lane, as the nginx daemon's do: one lane no longer carries every database,
// storage, egress and backup stream of the node, and one lane that drops leaves the relay usable through the others.
type relaySourceLane struct {
	conn   *grpc.ClientConn
	client relayv1.TunnelBrokerClient
	active atomic.Int64
}

func (l *relaySourceLane) connected() bool {
	return l.conn == nil || l.conn.GetState() == connectivity.Ready
}

// tunnelContext is the context of one tunnel on the lane: the lane counts it until its cancel runs (once).
func (l *relaySourceLane) tunnelContext(parent context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(parent)
	var release sync.Once
	return ctx, func() {
		cancel()
		release.Do(func() { l.active.Add(-1) })
	}
}

// addLane adds another lane of the relay for source tunnels.
func (r *relayTunnelRouter) addLane(conn *grpc.ClientConn) *relaySourceLane {
	lane := &relaySourceLane{conn: conn, client: relayv1.NewTunnelBrokerClient(conn)}
	r.lanesMu.Lock()
	defer r.lanesMu.Unlock()
	r.extraLanes = append(r.extraLanes, lane)
	return lane
}

// removeLane takes a lane whose connection ended out of selection; its open tunnels end with the connection.
func (r *relayTunnelRouter) removeLane(lane *relaySourceLane) {
	r.lanesMu.Lock()
	defer r.lanesMu.Unlock()
	r.extraLanes = slices.DeleteFunc(r.extraLanes, func(current *relaySourceLane) bool { return current == lane })
}

func (r *relayTunnelRouter) extraLaneConnected() bool {
	r.lanesMu.Lock()
	defer r.lanesMu.Unlock()
	for _, lane := range r.extraLanes {
		if lane.connected() {
			return true
		}
	}
	return false
}

// sourceLane picks the lane for a new source tunnel and counts the tunnel on it: the least busy connected lane, or
// the least busy lane while none is connected.
func (r *relayTunnelRouter) sourceLane() *relaySourceLane {
	r.lanesMu.Lock()
	defer r.lanesMu.Unlock()
	if r.primaryLane == nil {
		r.primaryLane = &relaySourceLane{conn: r.conn, client: r.client}
	}
	selected := r.primaryLane
	selectedConnected := selected.connected()
	for _, lane := range r.extraLanes {
		connected := lane.connected()
		if (connected && !selectedConnected) || (connected == selectedConnected && lane.active.Load() < selected.active.Load()) {
			selected, selectedConnected = lane, connected
		}
	}
	selected.active.Add(1)
	return selected
}
