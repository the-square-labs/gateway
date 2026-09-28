package daemon

import (
	"bytes"
	"log/slog"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

func startTunnelBroker(t *testing.T, broker relayv1.TunnelBrokerServer) *grpc.ClientConn {
	t.Helper()
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
	return conn
}

// switchBroker refuses every attempt with the current error, or opens the tunnel while it is nil.
type switchBroker struct {
	relayv1.UnimplementedTunnelBrokerServer
	mu       sync.Mutex
	refusal  error
	attempts atomic.Int32
}

func (b *switchBroker) set(err error) {
	b.mu.Lock()
	b.refusal = err
	b.mu.Unlock()
}

func (b *switchBroker) OpenTunnel(stream grpc.BidiStreamingServer[relayv1.TunnelFrame, relayv1.TunnelFrame]) error {
	if _, err := stream.Recv(); err != nil {
		return err
	}
	b.attempts.Add(1)
	b.mu.Lock()
	refusal := b.refusal
	b.mu.Unlock()
	if refusal != nil {
		return refusal
	}
	return stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Ready{Ready: &relayv1.TunnelReady{MaxFrameBytes: 64 * 1024}}})
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) lines() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	text := strings.TrimSpace(b.buf.String())
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

func outcomeLogPlugin(t *testing.T) (*NginxPlugin, *switchBroker, *syncBuffer) {
	t.Helper()
	broker := &switchBroker{}
	plugin := relayOpenPlugin(t, &scriptedBroker{}, false)
	// Same lane setup as relayOpenPlugin, answered by the switchable broker instead.
	plugin.relayTunnels[0].client = relayv1.NewTunnelBrokerClient(startTunnelBroker(t, broker))
	out := &syncBuffer{}
	plugin.logger = slog.New(slog.NewTextHandler(out, &slog.HandlerOptions{Level: slog.LevelInfo}))
	return plugin, broker, out
}

// L-1: while the target of a route is down, every request of the route is held up to 3 s and retried every 150 ms.
// That logged about 20 WARN lines per failed request (~2k per 5 min for one route at 0.6 req/s). Now the outage is one
// WARN line with the last attempt's reason, and its end one INFO line with the counts.
func TestSecureLinkOutageIsLoggedPerStateChangeNotPerAttempt(t *testing.T) {
	previousWait, previousRetry := secureLinkTransientWait, secureLinkTransientRetry
	secureLinkTransientWait, secureLinkTransientRetry = 150*time.Millisecond, 10*time.Millisecond
	t.Cleanup(func() { secureLinkTransientWait, secureLinkTransientRetry = previousWait, previousRetry })
	plugin, broker, out := outcomeLogPlugin(t)

	broker.set(notRegistered())
	for i := 0; i < 4; i++ {
		openThroughRelay(plugin)
	}
	if attempts := broker.attempts.Load(); attempts < 20 {
		t.Fatalf("attempts = %d, want the hold to retry within each request", attempts)
	}
	broker.set(nil)
	openThroughRelay(plugin)
	openThroughRelay(plugin)

	got := out.lines()
	if len(got) != 2 {
		t.Fatalf("logged %d lines, want the failing and the recovered line:\n%s", len(got), strings.Join(got, "\n"))
	}
	if !strings.Contains(got[0], `level=WARN msg="proxy secure-link connections failing" link_id=link-1 relay_instance_id=`) ||
		!strings.Contains(got[0], `stage=ready error="rpc error: code = Unavailable desc = target endpoint is not registered"`) {
		t.Fatalf("failing line = %s", got[0])
	}
	if !strings.Contains(got[1], `level=INFO msg="proxy secure-link connections recovered" link_id=link-1 failed=4 retried=0`) {
		t.Fatalf("recovered line = %s", got[1])
	}
}

// A hold that ends in an opened tunnel (relay or target restart) is one INFO line at its start and one at its end.
func TestSecureLinkHoldIsLoggedOncePerEpisode(t *testing.T) {
	previous := secureLinkTransientRetry
	secureLinkTransientRetry = 10 * time.Millisecond
	t.Cleanup(func() { secureLinkTransientRetry = previous })
	plugin, broker, out := outcomeLogPlugin(t)

	for i := 0; i < 3; i++ {
		broker.set(notRegistered())
		go func() {
			time.Sleep(40 * time.Millisecond)
			broker.set(nil)
		}()
		openThroughRelay(plugin)
	}
	openThroughRelay(plugin)

	got := out.lines()
	if len(got) != 2 {
		t.Fatalf("logged %d lines:\n%s", len(got), strings.Join(got, "\n"))
	}
	if !strings.Contains(got[0], `level=INFO msg="proxy secure-link connections succeed only after retries" link_id=link-1`) ||
		!strings.Contains(got[0], "failed_attempts=") {
		t.Fatalf("hold line = %s", got[0])
	}
	if !strings.Contains(got[1], `msg="proxy secure-link connections recovered" link_id=link-1 failed=0 retried=3`) {
		t.Fatalf("recovered line = %s", got[1])
	}
}

func TestHealthySecureLinkLogsNothing(t *testing.T) {
	plugin, _, out := outcomeLogPlugin(t)
	for i := 0; i < 3; i++ {
		openThroughRelay(plugin)
	}
	if got := out.lines(); len(got) != 0 {
		t.Fatalf("logged:\n%s", strings.Join(got, "\n"))
	}
}
