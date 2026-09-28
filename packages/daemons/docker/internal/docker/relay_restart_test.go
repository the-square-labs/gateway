package docker

import (
	"context"
	"io"
	"log/slog"
	"net"
	"sync"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	dockerconfig "github.com/wiolett-industries/gateway/docker-daemon/internal/config"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// statesBroker records the serving state of every register and renew frame and confirms each.
type statesBroker struct {
	relayv1.UnimplementedTunnelBrokerServer
	mu     sync.Mutex
	states []relayv1.EndpointServingState
}

func (b *statesBroker) RegisterEndpoint(stream grpc.BidiStreamingServer[relayv1.EndpointControl, relayv1.EndpointControl]) error {
	for {
		message, err := stream.Recv()
		if err != nil {
			return err
		}
		state := message.GetRegister().GetState()
		if renew := message.GetRenew(); renew != nil {
			state = renew.GetState()
		}
		b.mu.Lock()
		b.states = append(b.states, state)
		b.mu.Unlock()
		if err := stream.Send(&relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Registered{Registered: &relayv1.EndpointRegistered{EndpointId: fenceEndpointID}}}); err != nil {
			return err
		}
	}
}

func (b *statesBroker) seen() []relayv1.EndpointServingState {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]relayv1.EndpointServingState(nil), b.states...)
}

func restartTestRouter(t *testing.T, plugin *DockerPlugin, targetID string) (*relayTunnelRouter, *statesBroker) {
	t.Helper()
	broker := &statesBroker{}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	server := grpc.NewServer()
	relayv1.RegisterTunnelBrokerServer(server, broker)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)
	conn, err := grpc.NewClient(listener.Addr().String(), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	router := &relayTunnelRouter{plugin: plugin, ctx: ctx, client: relayv1.NewTunnelBrokerClient(conn), targetID: targetID,
		registrations: map[string]*relayEndpointRegistration{}, transportReady: make(chan struct{})}
	plugin.relayTunnelMu.Lock()
	if plugin.relayTunnels == nil {
		plugin.relayTunnels = map[string]*relayTunnelRouter{}
	}
	plugin.relayTunnels[targetID] = router
	plugin.relayTunnelMu.Unlock()
	return router, broker
}

func waitStates(t *testing.T, broker *statesBroker, want int) []relayv1.EndpointServingState {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if seen := broker.seen(); len(seen) >= want {
			return seen
		}
		if time.Now().After(deadline) {
			t.Fatalf("relay saw %v, want %d frames", broker.seen(), want)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// B-13: stopping gracefully, the daemon renews its serving registrations RESTARTING on the relays that keep a
// restarting endpoint, waits for them to confirm, and freezes its registrations. A relay without the capability is
// left alone (it would read RESTARTING as dormant and cut the tunnels at once).
func TestAnnounceRestartRenewsServingRegistrationsOnCapableRelays(t *testing.T) {
	store, err := newRelayGrantStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	plugin := &DockerPlugin{cfg: &dockerconfig.Config{}, logger: slog.New(slog.NewTextHandler(io.Discard, nil)), relayGrants: store, memberReadiness: newMemberReadiness()}
	capable, capableBroker := restartTestRouter(t, plugin, "relay-capable")
	older, olderBroker := restartTestRouter(t, plugin, "relay-older")
	candidate := func(relay string, capabilities ...string) *pb.RelayDataCandidate {
		return &pb.RelayDataCandidate{RelayInstanceId: relay, AssignmentGeneration: 3, AssignmentState: "active",
			Capabilities: append([]string{relaybridge.PoolCapability}, capabilities...), Grant: &pb.RelaySignedGrant{KeyId: "key", Payload: []byte(relay)}}
	}
	if err := store.sync(&pb.SyncRelayGrantsCommand{PolicyRevision: 1, Grants: []*pb.RelayGrantAssignment{{
		Role: "endpoint", OwnerKind: proxySecureLinkOwnerKind, OwnerId: fenceEndpointID, EndpointId: fenceEndpointID, SchemaVersion: 2,
		Candidates: []*pb.RelayDataCandidate{candidate("relay-capable", endpointRestartCapability), candidate("relay-older")},
	}}}); err != nil {
		t.Fatal(err)
	}
	capable.reconcileRegistrations()
	older.reconcileRegistrations()
	waitStates(t, capableBroker, 1)
	waitStates(t, olderBroker, 1)
	// Registered is confirmed asynchronously; wait until both registrations are ready.
	deadline := time.Now().Add(5 * time.Second)
	for {
		ready := true
		for _, router := range []*relayTunnelRouter{capable, older} {
			router.mu.Lock()
			for _, registration := range router.registrations {
				ready = ready && registration.ready.Load()
			}
			router.mu.Unlock()
		}
		if ready {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("registrations did not become ready")
		}
		time.Sleep(10 * time.Millisecond)
	}

	started := time.Now()
	plugin.AnnounceRestart()
	if elapsed := time.Since(started); elapsed >= restartAnnounceWait {
		t.Fatalf("announcing took %s: the relay's confirmation was not awaited", elapsed)
	}
	seen := waitStates(t, capableBroker, 2)
	if seen[len(seen)-1] != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_RESTARTING {
		t.Fatalf("capable relay saw %v", seen)
	}
	time.Sleep(100 * time.Millisecond)
	if seen := olderBroker.seen(); len(seen) != 1 {
		t.Fatalf("a relay without the capability was renewed: %v", seen)
	}
	// Frozen: nothing is renewed or registered any more.
	if cancelled := capable.reconcileRegistrations(); cancelled != nil {
		t.Fatalf("reconcile after the announcement cancelled %d registrations", len(cancelled))
	}
	time.Sleep(50 * time.Millisecond)
	if seen := capableBroker.seen(); len(seen) != 2 {
		t.Fatalf("frames after the announcement: %v", seen)
	}
}

func TestRestartDrainClosesIdleTunnelsAndWaitsForRequests(t *testing.T) {
	var set proxyTunnelSet
	pipe := func() *drainConn {
		local, remote := net.Pipe()
		t.Cleanup(func() { _ = local.Close(); _ = remote.Close() })
		return newDrainConn(local)
	}
	now := time.Now()
	idle := pipe()
	idle.lastWrite.Store(now.Add(-time.Second).UnixNano())
	idle.lastRead.Store(now.Add(-900 * time.Millisecond).UnixNano())
	waiting := pipe()
	waiting.lastRead.Store(now.Add(-time.Second).UnixNano())
	waiting.lastWrite.Store(now.Add(-500 * time.Millisecond).UnixNano())
	var idleClosed, waitingClosed bool
	var mu sync.Mutex
	set.add(idle, func() { mu.Lock(); idleClosed = true; mu.Unlock() })
	release := set.add(waiting, func() { mu.Lock(); waitingClosed = true; mu.Unlock() })

	started := time.Now()
	set.drain(300 * time.Millisecond)
	if elapsed := time.Since(started); elapsed < 250*time.Millisecond {
		t.Fatalf("drain returned after %s with a request unanswered", elapsed)
	}
	mu.Lock()
	if !idleClosed || waitingClosed {
		t.Fatalf("idle closed=%v, waiting closed=%v", idleClosed, waitingClosed)
	}
	mu.Unlock()

	// Once the answer went out, the tunnel is idle and the next drain ends at once.
	waiting.lastRead.Store(time.Now().Add(-200 * time.Millisecond).UnixNano())
	started = time.Now()
	set.drain(time.Second)
	if elapsed := time.Since(started); elapsed > 200*time.Millisecond {
		t.Fatalf("drain of idle tunnels took %s", elapsed)
	}
	release()

	fresh := newDrainConn(nil)
	if fresh.idle(time.Now(), restartIdleQuiet) {
		t.Fatal("a tunnel just opened, whose request is on its way, counted as idle")
	}
}
