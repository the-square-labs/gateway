package daemon

import (
	"context"
	"io"
	"log/slog"
	"net"
	"sync/atomic"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

// scriptedBroker answers OpenTunnel with the error of each attempt in turn, then with Ready.
type scriptedBroker struct {
	relayv1.UnimplementedTunnelBrokerServer
	errors   []error
	attempts atomic.Int32
}

func (b *scriptedBroker) OpenTunnel(stream grpc.BidiStreamingServer[relayv1.TunnelFrame, relayv1.TunnelFrame]) error {
	if _, err := stream.Recv(); err != nil {
		return err
	}
	attempt := int(b.attempts.Add(1)) - 1
	if attempt < len(b.errors) && b.errors[attempt] != nil {
		return b.errors[attempt]
	}
	return stream.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Ready{Ready: &relayv1.TunnelReady{MaxFrameBytes: 64 * 1024}}})
}

func relayOpenPlugin(t *testing.T, broker *scriptedBroker, availabilityMember bool) *NginxPlugin {
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
	grants, err := newRelayGrantStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := grants.sync(&pb.SyncRelayGrantsCommand{PolicyRevision: 1, GeneratedAtUnixMs: 1, Grants: []*pb.RelayGrantAssignment{{
		Role: "connect", OwnerKind: proxySecureLinkOwnerKind, OwnerId: "link-1", Grant: &pb.RelaySignedGrant{KeyId: "k", Payload: []byte("p")},
	}}}); err != nil {
		t.Fatal(err)
	}
	links := &sourceLinkManager{bindings: map[string]*sourceLinkBinding{}}
	if availabilityMember {
		links.bindings["link-1"] = &sourceLinkBinding{availabilityPolicyID: "policy-1"}
	}
	return &NginxPlugin{
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		relayGrants:  grants,
		secureLinks:  links,
		relayTunnels: []*nginxRelayTunnel{{ctx: context.Background(), client: relayv1.NewTunnelBrokerClient(conn), targetID: relaybridge.LegacyTargetID}},
	}
}

func openThroughRelay(plugin *NginxPlugin) time.Duration {
	client, server := net.Pipe()
	_ = client.Close()
	started := time.Now()
	plugin.openSecureLink(proxySecureLinkOwnerKind, "proxy secure-link", "link-1", server)
	return time.Since(started)
}

func notRegistered() error {
	return status.Error(codes.Unavailable, "target endpoint is not registered")
}

// TestSecureLinkWaitsForATargetThatIsRegisteringAgain is C-3 / N-9: while a relay or the target's daemon restarts,
// a new connection waits for the target instead of failing (502) at once.
func TestSecureLinkWaitsForATargetThatIsRegisteringAgain(t *testing.T) {
	previous := secureLinkTransientRetry
	secureLinkTransientRetry = 20 * time.Millisecond
	t.Cleanup(func() { secureLinkTransientRetry = previous })
	broker := &scriptedBroker{errors: []error{notRegistered(), status.Error(codes.Unavailable, "connection error: connection refused"), notRegistered()}}
	plugin := relayOpenPlugin(t, broker, false)

	elapsed := openThroughRelay(plugin)

	if got := broker.attempts.Load(); got != 4 {
		t.Fatalf("attempts = %d, want the three transient failures and then the opened tunnel", got)
	}
	if elapsed >= secureLinkTransientWait {
		t.Fatalf("took %s", elapsed)
	}
	if active := plugin.relayTunnels[0].active.Load(); active != 0 {
		t.Fatalf("lane active count = %d after the attempts", active)
	}
}

func TestSecureLinkFailsAtOnceOnFinalRefusals(t *testing.T) {
	for name, refusal := range map[string]error{
		"lease gate closed": status.Error(codes.FailedPrecondition, "availability lease gate closed: no own accept"),
		"dormant member":    status.Error(codes.Unavailable, "target endpoint is dormant"),
		"session limit":     status.Error(codes.ResourceExhausted, "route session limit reached"),
	} {
		t.Run(name, func(t *testing.T) {
			broker := &scriptedBroker{errors: []error{refusal, nil}}
			plugin := relayOpenPlugin(t, broker, false)
			openThroughRelay(plugin)
			if got := broker.attempts.Load(); got != 1 {
				t.Fatalf("attempts = %d, a final refusal must not be retried", got)
			}
		})
	}
}

// TestAvailabilityMemberLinkNeverWaits: nginx retries the next member of the availability upstream at once.
func TestAvailabilityMemberLinkNeverWaits(t *testing.T) {
	broker := &scriptedBroker{errors: []error{notRegistered(), nil}}
	plugin := relayOpenPlugin(t, broker, true)
	openThroughRelay(plugin)
	if got := broker.attempts.Load(); got != 1 {
		t.Fatalf("attempts = %d, an availability member link must fail over at once", got)
	}
}

func TestSecureLinkGivesUpAfterTheTransientWait(t *testing.T) {
	previousWait, previousRetry := secureLinkTransientWait, secureLinkTransientRetry
	secureLinkTransientWait, secureLinkTransientRetry = 300*time.Millisecond, 20*time.Millisecond
	t.Cleanup(func() { secureLinkTransientWait, secureLinkTransientRetry = previousWait, previousRetry })
	errors := make([]error, 1000)
	for i := range errors {
		errors[i] = notRegistered()
	}
	broker := &scriptedBroker{errors: errors}
	plugin := relayOpenPlugin(t, broker, false)

	elapsed := openThroughRelay(plugin)

	if elapsed < 200*time.Millisecond || elapsed > 2*time.Second {
		t.Fatalf("gave up after %s, want about the transient wait", elapsed)
	}
	if got := broker.attempts.Load(); got < 3 {
		t.Fatalf("attempts = %d", got)
	}
}
