package docker

import (
	"bytes"
	"context"
	"log/slog"
	"net"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

const outcomeLinkID = "44444444-4444-4444-8444-444444444444"

// acceptBroker answers AcceptTunnel with Ready and closes the tunnel, or fails it while failing is set.
type acceptBroker struct {
	relayv1.UnimplementedTunnelBrokerServer
	failing atomic.Bool
}

func (b *acceptBroker) AcceptTunnel(stream grpc.BidiStreamingServer[relayv1.TunnelFrame, relayv1.TunnelFrame]) error {
	if _, err := stream.Recv(); err != nil {
		return err
	}
	if b.failing.Load() {
		return status.Error(codes.Unavailable, "accept token expired")
	}
	return stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Ready{Ready: &relayv1.TunnelReady{MaxFrameBytes: 64 * 1024}}})
}

type lockedBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *lockedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *lockedBuffer) lines() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	text := strings.TrimSpace(b.buf.String())
	if text == "" {
		return nil
	}
	return strings.Split(text, "\n")
}

// outcomeRouter is a relay router whose endpoint forwards the Secure Link outcomeLinkID to a local TCP target.
func outcomeRouter(t *testing.T, broker *acceptBroker) (*relayTunnelRouter, *lockedBuffer) {
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

	target, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = target.Close() })
	go func() {
		for {
			connection, err := target.Accept()
			if err != nil {
				return
			}
			_ = connection.Close()
		}
	}()

	router := fenceTestRouter(t, "relay-1")
	out := &lockedBuffer{}
	router.plugin.logger = slog.New(slog.NewTextHandler(out, &slog.HandlerOptions{Level: slog.LevelInfo}))
	router.plugin.memberReadiness = newMemberReadiness()
	router.plugin.secureLinks = &dockerSecureLinkManager{
		managementIP: "127.0.0.1",
		bindings: map[string]dockerSecureLinkBinding{outcomeLinkID: {
			port: uint16(target.Addr().(*net.TCPAddr).Port), targetContainer: "app", targetNetwork: "app-net", targetHost: "127.0.0.1",
		}},
		resolveTargetForDial: func(context.Context, string, string, string, bool) (string, string, error) {
			return "127.0.0.1", "app-net", nil
		},
	}
	router.client = relayv1.NewTunnelBrokerClient(conn)
	return router, out
}

func acceptOutcomeTunnel(router *relayTunnelRouter) {
	assignment := &pb.RelayGrantAssignment{Role: "endpoint", OwnerKind: proxySecureLinkOwnerKind, OwnerId: outcomeLinkID, EndpointId: fenceEndpointID}
	router.acceptIncoming(context.Background(), assignment, incomingFor("route-1", 1))
}

// L-1: while a relay path or a workload is down, every request through the endpoint fails here. One WARN line when
// it starts failing, one INFO line with the count when a tunnel works again, nothing per request.
func TestIncomingTunnelFailuresAreLoggedPerStateChange(t *testing.T) {
	broker := &acceptBroker{}
	router, out := outcomeRouter(t, broker)

	acceptOutcomeTunnel(router)
	if got := out.lines(); len(got) != 0 {
		t.Fatalf("a working tunnel logged:\n%s", strings.Join(got, "\n"))
	}
	broker.failing.Store(true)
	for i := 0; i < 30; i++ {
		acceptOutcomeTunnel(router)
	}
	broker.failing.Store(false)
	acceptOutcomeTunnel(router)
	acceptOutcomeTunnel(router)

	got := out.lines()
	if len(got) != 2 {
		t.Fatalf("logged %d lines, want failing and recovered:\n%s", len(got), strings.Join(got, "\n"))
	}
	if !strings.Contains(got[0], `level=WARN msg="relay endpoint tunnels failing" owner_id=`+outcomeLinkID+` owner_kind=proxy_host_secure_link relay_instance_id=relay-1 stage=ready`) ||
		!strings.Contains(got[0], "accept token expired") {
		t.Fatalf("failing line = %s", got[0])
	}
	if !strings.Contains(got[1], `level=INFO msg="relay endpoint tunnels recovered" owner_id=`+outcomeLinkID+` failed=30 retried=0`) {
		t.Fatalf("recovered line = %s", got[1])
	}
}

// A source that keeps opening a revoked route through a stale relay is refused on every attempt: one WARN line.
func TestRevokedRouteRefusalsAreLoggedOnce(t *testing.T) {
	router := fenceTestRouter(t, "relay-1")
	out := &lockedBuffer{}
	router.plugin.logger = slog.New(slog.NewTextHandler(out, &slog.HandlerOptions{Level: slog.LevelInfo}))
	syncFences(t, router, 1, staleRelayFence("relay-1"))
	assignment := fenceEndpointAssignment("relay-1")
	assignment.OwnerId = outcomeLinkID

	for i := 0; i < 20; i++ {
		if _, refusal := router.admitIncoming(assignment, incomingFor("revoked-route", 1), func() {}); refusal == "" {
			t.Fatal("revoked route admitted")
		}
	}

	got := out.lines()
	if len(got) != 1 || !strings.Contains(got[0], `level=WARN msg="relay endpoint tunnels on revoked routes failing" owner_id=`+outcomeLinkID+` relay_instance_id=relay-1`) ||
		!strings.Contains(got[0], "route_id=revoked-route") {
		t.Fatalf("logged:\n%s", strings.Join(got, "\n"))
	}
}
