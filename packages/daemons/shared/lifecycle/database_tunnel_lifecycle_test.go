package lifecycle

import (
	"context"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"google.golang.org/grpc"
)

type blockingDatabaseTunnelPlugin struct {
	starts atomic.Int32
	ended  chan int32
}

func (p *blockingDatabaseTunnelPlugin) RunDatabaseTunnel(ctx context.Context, _ *grpc.ClientConn, _ string) {
	start := p.starts.Add(1)
	<-ctx.Done()
	p.ended <- start
}

func TestProcessDatabaseTunnelIgnoresControlSessionCancellation(t *testing.T) {
	processCtx, cancelProcess := context.WithCancel(context.Background())
	defer cancelProcess()
	plugin := &blockingDatabaseTunnelPlugin{ended: make(chan int32, 2)}
	identityChanged := make(chan struct{}, 1)
	var connections atomic.Int32
	connect := func(context.Context) (*grpc.ClientConn, error) {
		connections.Add(1)
		return nil, nil
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	go runProcessDatabaseTunnel(processCtx, connect, plugin, "node-1", identityChanged, logger)

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

func TestProcessDatabaseTunnelReconnectsAfterCredentialRotation(t *testing.T) {
	processCtx, cancelProcess := context.WithCancel(context.Background())
	defer cancelProcess()
	plugin := &blockingDatabaseTunnelPlugin{ended: make(chan int32, 2)}
	identityChanged := make(chan struct{}, 1)
	var connections atomic.Int32
	connect := func(context.Context) (*grpc.ClientConn, error) {
		connections.Add(1)
		return nil, nil
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	go runProcessDatabaseTunnel(processCtx, connect, plugin, "node-1", identityChanged, logger)

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
