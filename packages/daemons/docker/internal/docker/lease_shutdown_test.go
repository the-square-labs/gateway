package docker

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/leasefence"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/lease"
)

// leaseForShutdownTest wires a real lease runtime (in-memory store) into plugin, as initAvailabilityLease does.
func leaseForShutdownTest(t *testing.T, plugin *DockerPlugin) *leaseIntegration {
	t.Helper()
	integration := &leaseIntegration{plugin: plugin, serving: map[string]bool{}}
	runtime, err := lease.New(lease.Options{
		NodeID: "node-1", Signer: availabilitylease.ECDSASigner{Key: e2eKey()}, Store: availabilitylease.NewMemoryStore(),
		Engine: &e2eEngine{}, Fence: &e2eFence{records: map[string]leasefence.Record{}}, Endpoints: integration, Placements: integration,
		Logger: e2eDiscard(),
	})
	if err != nil {
		t.Fatal(err)
	}
	integration.runtime = runtime
	integration.ctx, integration.cancel = context.WithCancel(context.Background())
	t.Cleanup(integration.cancel)
	plugin.lease = integration
	return integration
}

// At exit the lease's goroutines finish what they write before the process goes: a lane in the middle of a frame
// delivery (which writes the acceptor store) completes it, and nothing writes afterwards.
func TestShutdownWaitsForTheLeaseToFinishItsWrites(t *testing.T) {
	plugin := &DockerPlugin{logger: e2eDiscard()}
	integration := leaseForShutdownTest(t, plugin)
	directory := t.TempDir()
	var wrote atomic.Bool
	integration.goWorker(func(ctx context.Context) {
		<-ctx.Done()
		time.Sleep(100 * time.Millisecond) // the frame in delivery
		_ = os.WriteFile(filepath.Join(directory, "acceptor.json"), []byte("{}"), 0o600)
		wrote.Store(true)
	})

	started := time.Now()
	plugin.Shutdown()

	if !wrote.Load() {
		t.Fatal("Shutdown returned while the lease still wrote its state")
	}
	if elapsed := time.Since(started); elapsed >= leaseShutdownWait {
		t.Fatalf("Shutdown took %s", elapsed)
	}
}

// A lease operation that does not end (a hung dockerd call) does not hold the exit longer than the deadline.
func TestShutdownGivesUpOnTheLeaseAfterTheDeadline(t *testing.T) {
	previous := leaseShutdownWait
	leaseShutdownWait = 200 * time.Millisecond
	t.Cleanup(func() { leaseShutdownWait = previous })
	var out bytes.Buffer
	var outMu sync.Mutex
	plugin := &DockerPlugin{logger: slog.New(slog.NewTextHandler(writerFunc(func(p []byte) (int, error) {
		outMu.Lock()
		defer outMu.Unlock()
		return out.Write(p)
	}), nil))}
	integration := leaseForShutdownTest(t, plugin)
	release := make(chan struct{})
	integration.goWorker(func(context.Context) { <-release })
	t.Cleanup(func() { close(release) })

	started := time.Now()
	plugin.Shutdown()

	if elapsed := time.Since(started); elapsed < leaseShutdownWait || elapsed > leaseShutdownWait+time.Second {
		t.Fatalf("Shutdown took %s, want about %s", elapsed, leaseShutdownWait)
	}
	outMu.Lock()
	defer outMu.Unlock()
	if !strings.Contains(out.String(), `level=WARN msg="availability lease did not stop in time; exiting with its work in flight" waited=200ms`) {
		t.Fatalf("log = %s", out.String())
	}
}

type writerFunc func([]byte) (int, error)

func (f writerFunc) Write(p []byte) (int, error) { return f(p) }

// The lifecycle announces a restart (AnnounceRestart) before it cancels Run and calls Shutdown. The goodbye to the
// relays must not stop the lease (its lanes still carry lease frames while the relays hold the traffic); Shutdown
// then stops it.
func TestRestartSaysGoodbyeToTheRelaysBeforeTheLeaseStops(t *testing.T) {
	plugin := &DockerPlugin{logger: e2eDiscard()}
	renew := make(chan relayRegistrationUpdate, 1)
	plugin.relayTunnels = map[string]*relayTunnelRouter{"relay-1": {plugin: plugin, targetID: "relay-1", registrations: map[string]*relayEndpointRegistration{
		fenceEndpointID: {renew: renew, state: relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING, latest: &pb.RelayGrantAssignment{
			Role: "endpoint", EndpointId: fenceEndpointID,
			Candidates: []*pb.RelayDataCandidate{{RelayInstanceId: "relay-1", Capabilities: []string{endpointRestartCapability}}},
		}},
	}}}
	integration := leaseForShutdownTest(t, plugin)
	var mu sync.Mutex
	var order []string
	record := func(event string) {
		mu.Lock()
		order = append(order, event)
		mu.Unlock()
	}
	integration.goWorker(func(ctx context.Context) {
		<-ctx.Done()
		record("lease stopped")
	})

	plugin.AnnounceRestart() // the relay does not confirm here: it waits restartAnnounceWait, then drains
	select {
	case update := <-renew:
		if update.state != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_RESTARTING {
			t.Fatalf("goodbye state = %v", update.state)
		}
		record("goodbye")
	default:
		t.Fatal("no RESTARTING renewal was queued for the relay")
	}
	if integration.ctx.Err() != nil {
		t.Fatal("announcing the restart stopped the lease")
	}
	plugin.Shutdown()

	mu.Lock()
	defer mu.Unlock()
	if strings.Join(order, ", ") != "goodbye, lease stopped" {
		t.Fatalf("order = %v", order)
	}
}

func TestShutdownWithoutLeaseReturnsAtOnce(t *testing.T) {
	plugin := &DockerPlugin{logger: e2eDiscard()}
	if !plugin.stopAvailabilityLease(time.Millisecond) {
		t.Fatal("a daemon without lease runtime must stop at once")
	}
}
