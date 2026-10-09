//go:build linux

package docker

import (
	"context"
	"net"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/handover/handovertest"
	"github.com/wiolett-industries/gateway/daemon-shared/relayresume"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
)

// useTestKeeper makes handovers of this test go through keeper, as updates.
func useTestKeeper(t *testing.T, keeper *handovertest.Keeper) {
	previousKeeper, previousExit := handoverKeeper, exitingForUpdate
	handoverKeeper, exitingForUpdate = keeper, func() bool { return true }
	t.Cleanup(func() { handoverKeeper, exitingForUpdate = previousKeeper, previousExit })
}

// update hands plugin's connections to a new daemon process of the same node:
// the old one hands over and stops (its relay registrations and lanes end),
// the new one takes the connections over in Init's order (before its relay
// lanes start) and connects to the relays.
func (pair *streamPair) update(t *testing.T, keeper *handovertest.Keeper, old *DockerPlugin, bundle *pb.SyncRelayGrantsCommand) *DockerPlugin {
	t.Helper()
	result := old.handOverConnections()
	if !result.Committed || result.HandedOver == 0 || len(result.Cut) > 0 {
		t.Fatalf("handover: %+v", result)
	}
	for _, cancel := range pair.cancels[old] {
		cancel()
	}
	if err := keeper.Restart(); err != nil {
		t.Fatal(err)
	}
	next := pair.newDaemon(bundle)
	next.cfg.StateDir = t.TempDir()
	next.cfg.Docker.Mode = old.cfg.Docker.Mode
	next.endpointDialer = func(ctx context.Context, _ *pb.RelayGrantAssignment) (dialedEndpoint, error) {
		pair.dials.Add(1)
		conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", pair.backend.Addr().String())
		return dialedEndpoint{conn: conn}, err
	}
	next.restoreHandover()
	if keeper.Kept() != 0 {
		t.Fatalf("the keeper still holds %d descriptors after the restore", keeper.Kept())
	}
	for id := range pair.relays {
		pair.connect(next, id)
	}
	return next
}

// An update of the target daemon (the endpoint of a container link) keeps the
// stream: the bytes in flight both ways arrive exactly once, without a second
// dial of the backend.
func TestLiveHandoverKeepsStreamAcrossTargetUpdate(t *testing.T) {
	keeper := handovertest.NewKeeper()
	useTestKeeper(t, keeper)
	pair := newStreamPair(t, true, true)
	app, tunnel := pair.open()
	waitFor(t, "the stream to open", func() bool { return tunnel.session.State() == relayresume.StateOpen })
	_, targetBundle := testBundles(1, map[string]string{"relay-a": "active", "relay-b": "active"}, true, true)
	echoThrough(t, app, 8<<20, func() {
		pair.target = pair.update(t, keeper, pair.target, targetBundle)
	})
	if pair.dials.Load() != 1 {
		t.Fatalf("backend dialed %d times", pair.dials.Load())
	}
	if stats := pair.source.relayStreamStats(); stats.GetCutTotal() != 0 {
		t.Fatalf("source stats %+v", stats)
	}
}

// An update of the source daemon (the workload's side of the link) keeps the
// stream the same way.
func TestLiveHandoverKeepsStreamAcrossSourceUpdate(t *testing.T) {
	keeper := handovertest.NewKeeper()
	useTestKeeper(t, keeper)
	pair := newStreamPair(t, true, true)
	app, tunnel := pair.open()
	waitFor(t, "the stream to open", func() bool { return tunnel.session.State() == relayresume.StateOpen })
	sourceBundle, _ := testBundles(1, map[string]string{"relay-a": "active", "relay-b": "active"}, true, true)
	echoThrough(t, app, 8<<20, func() {
		pair.source = pair.update(t, keeper, pair.source, sourceBundle)
	})
	if pair.dials.Load() != 1 {
		t.Fatalf("backend dialed %d times", pair.dials.Load())
	}
	report := pair.source.updateConnections()
	if !report.GetHandoverAvailable() {
		t.Fatalf("report %+v", report)
	}
}

// A database link served on a storage node: its endpoint (not a connector
// ingress) keeps the stream across an update too.
func TestLiveHandoverKeepsDatabaseLinkAcrossTargetUpdate(t *testing.T) {
	keeper := handovertest.NewKeeper()
	useTestKeeper(t, keeper)
	kinds := routeKinds{connect: linkKindManagedDatabaseBinding, endpoint: "managed_database"}
	pair := newStreamPairFor(t, kinds, true, true)
	app, tunnel := pair.open()
	waitFor(t, "the stream to open", func() bool { return tunnel.session.State() == relayresume.StateOpen })
	_, targetBundle := testBundlesFor(kinds, 1, map[string]string{"relay-a": "active", "relay-b": "active"}, true, true)
	echoThrough(t, app, 4<<20, func() {
		pair.target = pair.update(t, keeper, pair.target, targetBundle)
	})
	if pair.dials.Load() != 1 {
		t.Fatalf("backend dialed %d times", pair.dials.Load())
	}
}

// A restart that is no update (a stop, a launcher that crashed and the unit started again) leaves the relay stream cut
// total, the streams its exit cuts included, to the next process (stand rc.7 O-5: the counter started at zero again
// and the cut was recorded nowhere).
func TestRestartCarriesTheRelayStreamCutTotal(t *testing.T) {
	useTestKeeper(t, handovertest.NewKeeper())
	stateDir := t.TempDir()
	previous := NewDockerPlugin(&config.Config{})
	previous.cfg.StateDir = stateDir
	previous.relayStreams().sources.CarryCut(4)
	previous.beginStreamExit()
	previous.Shutdown()
	next := NewDockerPlugin(&config.Config{})
	next.cfg.StateDir = stateDir
	next.restoreHandover()
	if cut := next.relayStreamStats().GetCutTotal(); cut != 4 {
		t.Fatalf("cut total %d after the restart, want the previous process's 4", cut)
	}
	again := NewDockerPlugin(&config.Config{})
	again.cfg.StateDir = stateDir
	again.restoreHandover()
	if stats := again.relayStreamStats(); stats.GetCutTotal() != 0 {
		t.Fatalf("the totals were carried twice: %+v", stats)
	}
}
