package docker

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/connector"
	"github.com/wiolett-industries/gateway/daemon-shared/slowstart"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func testLaneRouter(extra int) (*relayTunnelRouter, []*relaySourceLane) {
	router := &relayTunnelRouter{plugin: &DockerPlugin{logger: slog.New(slog.NewTextHandler(io.Discard, nil))}}
	router.primaryLane = &relaySourceLane{}
	lanes := make([]*relaySourceLane, extra)
	for i := range lanes {
		lanes[i] = &relaySourceLane{socket: &connector.LaneSocket{}}
		lanes[i].origin = lanes[i]
	}
	router.extraLanes = lanes
	return router, lanes
}

// Tunnels go to the extra lanes, whose connections can be replaced; the
// primary lane takes them only while no extra lane is connected.
func TestSourceLanePrefersExtraLanes(t *testing.T) {
	router, lanes := testLaneRouter(2)
	lanes[0].active.Store(1)
	if got := router.sourceLane(); got != lanes[1] {
		t.Fatal("the least busy extra lane was not picked")
	}
	if got := router.sourceLane(); got == router.primaryLane {
		t.Fatal("the primary lane took a tunnel while extra lanes were connected")
	}
	router.extraLanes = nil
	if got := router.sourceLane(); got != router.primaryLane {
		t.Fatal("without extra lanes a tunnel did not go to the primary lane")
	}
}

// A lane is rotated when its own sending side collapsed, when the relay says
// its side did, or when its round trip under bulk data grew far beyond the
// one it learned on; not for a round trip measured on small writes.
func TestLaneRotateReason(t *testing.T) {
	ms := func(d int) uint32 { return uint32(d * 1000) }
	lane := &relaySourceLane{}
	state := func(sent, received uint64, rttMs, rcvRTTMs int) slowstart.State {
		return slowstart.State{SlowStartThreshold: slowstart.InfiniteThreshold, BytesAcked: sent, BytesReceived: received,
			RTTUs: ms(rttMs), RcvRTTUs: ms(rcvRTTMs)}
	}
	if why := laneRotateReason(lane, state(1000, 1000, 1, 1), true); why != "" {
		t.Fatalf("first look: %q", why)
	}
	// A LAN download: the lane learns the receiver's 1 ms, not its own 40 ms (delayed acks of its small writes).
	if why := laneRotateReason(lane, state(2000, 1000+laneBulkBytes, 40, 1), true); why != "" || lane.bulkRTT != time.Millisecond {
		t.Fatalf("LAN bulk: %q, learned %v", why, lane.bulkRTT)
	}
	// Small writes with a 60 ms round trip: nothing.
	if why := laneRotateReason(lane, state(3000, 2000+laneBulkBytes, 60, 60), true); why != "" {
		t.Fatalf("small writes: %q", why)
	}
	// A download at 60 ms: the round trip grew.
	if why := laneRotateReason(lane, state(4000, 2000+3*laneBulkBytes, 90, 60), true); why != "round_trip_grew" {
		t.Fatalf("bulk after the round trip grew: %q", why)
	}
	upload := &relaySourceLane{}
	laneRotateReason(upload, state(1000, 1000, 1, 0), true)
	laneRotateReason(upload, state(1000+laneBulkBytes, 1000, 1, 0), true)
	if why := laneRotateReason(upload, state(1000+3*laneBulkBytes, 1000, 60, 0), true); why != "round_trip_grew" {
		t.Fatalf("upload after the round trip grew: %q", why)
	}
	collapsed := slowstart.State{SlowStartThreshold: 7, RTTUs: ms(60)}
	if why := laneRotateReason(&relaySourceLane{}, collapsed, true); why != "collapsed" {
		t.Fatalf("collapsed sender: %q", why)
	}
	lan := slowstart.State{SlowStartThreshold: 7, RTTUs: ms(1)}
	if why := laneRotateReason(&relaySourceLane{}, lan, true); why != "" {
		t.Fatalf("a small threshold on a LAN: %q", why)
	}
	hinted := &relaySourceLane{}
	hinted.hinted.Store(true)
	if why := laneRotateReason(hinted, slowstart.State{}, false); why != "relay_collapsed" {
		t.Fatalf("relay's word: %q", why)
	}
}

// A rotation puts the new connection in the lane's place, keeps the old one
// out of selection until its tunnels ended, and closes only connections the
// router dialled; a lane rotates at most once per laneRotateEvery.
func TestRotateLaneReplacesTheConnection(t *testing.T) {
	router, lanes := testLaneRouter(1)
	old := lanes[0]
	old.conn = newTestConn(t)
	old.active.Store(1)
	dialled := 0
	laneDialers.Store(old.conn, func(context.Context) (*grpc.ClientConn, error) {
		dialled++
		return newTestConn(t), nil
	})
	t.Cleanup(func() { laneDialers.Delete(old.conn) })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	router.rotating = true
	router.rotateLane(ctx, old, "collapsed", time.Now())
	if dialled != 1 || router.rotating {
		t.Fatalf("dialled %d, rotating %v", dialled, router.rotating)
	}
	replacement := router.extraLanes[0]
	if replacement == old || !replacement.rotated || replacement.origin != old || !old.retiring {
		t.Fatal("the old connection was not replaced")
	}
	if len(router.extraLanes) != 1 {
		t.Fatal("the old connection stayed selectable next to its replacement")
	}
	router.closeEmptyRetiringLanes()
	if len(router.retiringLanes) != 1 {
		t.Fatal("a retiring lane with a tunnel was dropped")
	}
	old.active.Store(0)
	router.closeEmptyRetiringLanes()
	if len(router.retiringLanes) != 0 || old.conn.GetState().String() == "SHUTDOWN" {
		t.Fatalf("retiring %d, pool connection %v (the pool owns it)", len(router.retiringLanes), old.conn.GetState())
	}
	// The replacement collapses too, at once: its slot rotated a moment ago.
	now := time.Now()
	router.laneRotatedAt = map[*relaySourceLane]time.Time{old: now}
	replacement.hinted.Store(true)
	if lane, _ := router.laneToRotate(now.Add(laneRotateSpacing)); lane != nil {
		t.Fatal("a lane rotated twice within laneRotateEvery")
	}
	router.removeLane(old)
	if len(router.extraLanes) != 0 || replacement.conn.GetState().String() != "SHUTDOWN" {
		t.Fatal("removing the pool lane left its replacement open")
	}
}

func newTestConn(t *testing.T) *grpc.ClientConn {
	t.Helper()
	conn, err := grpc.NewClient("passthrough:///127.0.0.1:1", grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}
