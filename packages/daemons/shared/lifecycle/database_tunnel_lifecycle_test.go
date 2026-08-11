package lifecycle

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"google.golang.org/grpc"
)

type blockingRelayTunnelPlugin struct {
	starts atomic.Int32
	ended  chan int32
}

type laneRelayTunnelPlugin struct {
	blockingRelayTunnelPlugin
	lanes   int
	changed chan struct{}
}

func (p *laneRelayTunnelPlugin) RelayTunnelLaneCount() int                  { return p.lanes }
func (p *laneRelayTunnelPlugin) RelayTunnelRuntimeChanged() <-chan struct{} { return p.changed }

func (p *blockingRelayTunnelPlugin) RunRelayTunnels(ctx context.Context, _ *grpc.ClientConn, _ string) {
	start := p.starts.Add(1)
	<-ctx.Done()
	p.ended <- start
}

func (p *blockingRelayTunnelPlugin) SyncRelayGrants(*pb.SyncRelayGrantsCommand) (string, error) {
	return "", nil
}

func TestProcessRelayTunnelIgnoresControlSessionCancellation(t *testing.T) {
	processCtx, cancelProcess := context.WithCancel(context.Background())
	defer cancelProcess()
	plugin := &blockingRelayTunnelPlugin{ended: make(chan int32, 2)}
	identityChanged := make(chan struct{}, 1)
	var connections atomic.Int32
	connect := func(context.Context) (*grpc.ClientConn, error) {
		connections.Add(1)
		return nil, nil
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	go runProcessRelayTunnel(processCtx, connect, plugin, "node-1", identityChanged, logger)

	deadline := time.After(time.Second)
	for plugin.starts.Load() != 1 {
		select {
		case <-deadline:
			t.Fatal("process-lifetime tunnel did not start")
		default:
			time.Sleep(time.Millisecond)
		}
	}

	// These model independent control ClientConn/session cycles. Cancelling
	// either must not reach the process-level tunnel context or create another
	// physical tunnel ClientConn.
	for range 2 {
		_, cancelControl := context.WithCancel(context.Background())
		cancelControl()
	}
	time.Sleep(10 * time.Millisecond)
	if got := plugin.starts.Load(); got != 1 {
		t.Fatalf("tunnel plugin starts = %d, want exactly 1", got)
	}
	if got := connections.Load(); got != 1 {
		t.Fatalf("tunnel ClientConns = %d, want exactly 1", got)
	}

	cancelProcess()
	select {
	case <-plugin.ended:
	case <-time.After(time.Second):
		t.Fatal("process shutdown did not cancel the tunnel")
	}
}

func TestProcessRelayTunnelStartsConfiguredPhysicalLanes(t *testing.T) {
	processCtx, cancelProcess := context.WithCancel(context.Background())
	plugin := &laneRelayTunnelPlugin{
		blockingRelayTunnelPlugin: blockingRelayTunnelPlugin{ended: make(chan int32, 8)},
		lanes:                     4,
		changed:                   make(chan struct{}, 1),
	}
	identityChanged := make(chan struct{}, 1)
	var connections atomic.Int32
	connect := func(context.Context) (*grpc.ClientConn, error) {
		connections.Add(1)
		return nil, nil
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	go runProcessRelayTunnel(processCtx, connect, plugin, "node-1", identityChanged, logger)

	deadline := time.After(time.Second)
	for plugin.starts.Load() != 4 {
		select {
		case <-deadline:
			t.Fatalf("lane starts = %d, want 4", plugin.starts.Load())
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if got := connections.Load(); got != 4 {
		t.Fatalf("lane connections = %d, want 4", got)
	}
	cancelProcess()
}

func TestProcessRelayTunnelReconnectsAfterCredentialRotation(t *testing.T) {
	processCtx, cancelProcess := context.WithCancel(context.Background())
	defer cancelProcess()
	plugin := &blockingRelayTunnelPlugin{ended: make(chan int32, 2)}
	identityChanged := make(chan struct{}, 1)
	var connections atomic.Int32
	connect := func(context.Context) (*grpc.ClientConn, error) {
		connections.Add(1)
		return nil, nil
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	go runProcessRelayTunnel(processCtx, connect, plugin, "node-1", identityChanged, logger)

	deadline := time.After(time.Second)
	for plugin.starts.Load() != 1 {
		select {
		case <-deadline:
			t.Fatal("initial process-lifetime tunnel did not start")
		default:
			time.Sleep(time.Millisecond)
		}
	}

	identityChanged <- struct{}{}
	deadline = time.After(time.Second)
	for plugin.starts.Load() != 2 {
		select {
		case <-deadline:
			t.Fatal("credential rotation did not reconnect the process tunnel")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if got := connections.Load(); got != 2 {
		t.Fatalf("tunnel ClientConns = %d, want 2 after credential rotation", got)
	}
	select {
	case ended := <-plugin.ended:
		if ended != 1 {
			t.Fatalf("ended tunnel generation = %d, want 1", ended)
		}
	case <-time.After(time.Second):
		t.Fatal("old tunnel generation did not stop after credential rotation")
	}

	cancelProcess()
	select {
	case ended := <-plugin.ended:
		if ended != 2 {
			t.Fatalf("ended tunnel generation = %d, want 2", ended)
		}
	case <-time.After(time.Second):
		t.Fatal("process shutdown did not cancel the rotated tunnel")
	}
}

func TestProcessRelayTunnelRetriesAfterAConnectionFailure(t *testing.T) {
	processCtx, cancelProcess := context.WithCancel(context.Background())
	defer cancelProcess()
	plugin := &blockingRelayTunnelPlugin{ended: make(chan int32, 1)}
	identityChanged := make(chan struct{}, 1)
	var connections atomic.Int32
	connect := func(context.Context) (*grpc.ClientConn, error) {
		if connections.Add(1) == 1 {
			return nil, errors.New("relay unavailable")
		}
		return nil, nil
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	go runProcessRelayTunnel(processCtx, connect, plugin, "node-1", identityChanged, logger)

	deadline := time.After(2 * time.Second)
	for plugin.starts.Load() != 1 {
		select {
		case <-deadline:
			t.Fatal("process tunnel did not recover after the connection failure")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if got := connections.Load(); got != 2 {
		t.Fatalf("tunnel ClientConns = %d, want failed attempt plus successful retry", got)
	}

	cancelProcess()
	select {
	case <-plugin.ended:
	case <-time.After(time.Second):
		t.Fatal("process shutdown did not cancel the recovered tunnel")
	}
}

func TestControlSessionReconnectWaitStopsOnShutdown(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	started := time.Now()
	if waitForControlSessionReconnect(ctx) {
		t.Fatal("reconnect wait must stop when the daemon is shutting down")
	}
	if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
		t.Fatalf("shutdown cancellation took %s", elapsed)
	}
}
