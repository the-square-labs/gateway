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

// TestAvailabilityMemberLinkWaitsForALaneAfterARestart is B-13: right after the nginx daemon started (or while every
// relay restarts) it has no lane at all, so every member of the upstream fails alike. A member's link then waits for
// a lane like any other link instead of failing the whole upstream at once.
func TestAvailabilityMemberLinkWaitsForALaneAfterARestart(t *testing.T) {
	previous := secureLinkTransientRetry
	secureLinkTransientRetry = 20 * time.Millisecond
	t.Cleanup(func() { secureLinkTransientRetry = previous })
	broker := &scriptedBroker{}
	plugin := relayOpenPlugin(t, broker, true)
	lane := plugin.relayTunnels[0]
	plugin.relayTunnels = nil
	go func() {
		time.Sleep(150 * time.Millisecond)
		plugin.relayTunnelMu.Lock()
		plugin.relayTunnels = []*nginxRelayTunnel{lane}
		plugin.relayTunnelMu.Unlock()
	}()

	elapsed := openThroughRelay(plugin)

	if got := broker.attempts.Load(); got != 1 {
		t.Fatalf("attempts = %d, want the tunnel opened once the lane came up", got)
	}
	if elapsed < 100*time.Millisecond || elapsed >= secureLinkTransientWait {
		t.Fatalf("took %s", elapsed)
	}
}

// hangingBroker receives the Open frame and never answers: the relay still holds the registration of a member whose
// host stopped answering.
type hangingBroker struct {
	relayv1.UnimplementedTunnelBrokerServer
	attempts atomic.Int32
}

func (b *hangingBroker) OpenTunnel(stream grpc.BidiStreamingServer[relayv1.TunnelFrame, relayv1.TunnelFrame]) error {
	if _, err := stream.Recv(); err != nil {
		return err
	}
	b.attempts.Add(1)
	<-stream.Context().Done()
	return stream.Context().Err()
}

func blackHoledMemberPlugin(t *testing.T, member bool) (*NginxPlugin, *hangingBroker) {
	t.Helper()
	broker := &hangingBroker{}
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
	relays := []string{"relay-130", "relay-136", "relay-137"}
	candidates := make([]*pb.RelayDataCandidate, 0, len(relays))
	tunnels := make([]*nginxRelayTunnel, 0, len(relays))
	for _, relay := range relays {
		candidates = append(candidates, &pb.RelayDataCandidate{
			RelayInstanceId: relay, AssignmentGeneration: 1, AssignmentState: "active",
			Capabilities: []string{relaybridge.PoolCapability}, Grant: &pb.RelaySignedGrant{KeyId: "k", Payload: []byte(relay)},
		})
		tunnels = append(tunnels, &nginxRelayTunnel{ctx: context.Background(), client: relayv1.NewTunnelBrokerClient(conn), targetID: relay})
	}
	if err := grants.sync(&pb.SyncRelayGrantsCommand{PolicyRevision: 1, GeneratedAtUnixMs: 1, Grants: []*pb.RelayGrantAssignment{{
		Role: "connect", OwnerKind: proxySecureLinkOwnerKind, OwnerId: "link-1", SchemaVersion: 2, Candidates: candidates,
		Grant: &pb.RelaySignedGrant{KeyId: "k", Payload: []byte("legacy")},
	}}}); err != nil {
		t.Fatal(err)
	}
	links := &sourceLinkManager{bindings: map[string]*sourceLinkBinding{}}
	if member {
		links.bindings["link-1"] = &sourceLinkBinding{availabilityPolicyID: "policy-1"}
	}
	return &NginxPlugin{
		logger:       slog.New(slog.NewTextHandler(io.Discard, nil)),
		relayGrants:  grants,
		secureLinks:  links,
		relayTunnels: tunnels,
	}, broker
}

// TestMemberOnAnUnreachableHostCostsOneSetupBudget is N-12: app-node-2 dropped off the network, every relay still
// held its registration and none answered the tunnel. A member's link gives up after one setup budget across all its
// relays, so nginx retries the next member, instead of waiting out the setup timeout on each relay in turn.
func TestMemberOnAnUnreachableHostCostsOneSetupBudget(t *testing.T) {
	previous := availabilityMemberSetupBudget
	availabilityMemberSetupBudget = 300 * time.Millisecond
	t.Cleanup(func() { availabilityMemberSetupBudget = previous })
	plugin, broker := blackHoledMemberPlugin(t, true)

	elapsed := openThroughRelay(plugin)

	if elapsed < 250*time.Millisecond || elapsed > time.Second {
		t.Fatalf("a member link on an unreachable host took %s, want about the setup budget", elapsed)
	}
	if got := broker.attempts.Load(); got != 1 {
		t.Fatalf("attempts = %d, the budget was spent on the first relay", got)
	}
	for _, tunnel := range plugin.relayTunnels {
		if active := tunnel.active.Load(); active != 0 {
			t.Fatalf("lane %s active count = %d", tunnel.targetID, active)
		}
	}
}

// B-17: the source probe of a staged move of an Availability member that is a standby is refused by the relay's
// lease gate. The refusal proves the relay authorizes the route, so the probe succeeds instead of failing the move.
func TestSourceProbeOfAGatedMemberSucceeds(t *testing.T) {
	for name, refusal := range map[string]error{
		"standby without a slot": status.Error(codes.FailedPrecondition, "availability lease gate closed: b839311a holds no committed slot"),
		"dormant member":         status.Error(codes.Unavailable, "target endpoint is dormant"),
	} {
		t.Run(name, func(t *testing.T) {
			broker := &scriptedBroker{errors: []error{refusal}}
			plugin := relayOpenPlugin(t, broker, false)
			detail, err := plugin.ProbeRelayCandidate(&pb.ProbeRelayCandidateCommand{
				Role: "source", ProbeId: "probe-1", AssignmentGeneration: 3,
				Candidate: &pb.RelayDataCandidate{RelayInstanceId: relaybridge.LegacyTargetID, AssignmentGeneration: 3, Grant: &pb.RelaySignedGrant{KeyId: "k", Payload: []byte("p")}},
			})
			if err != nil || detail == "" {
				t.Fatalf("probe = %q, %v", detail, err)
			}
			if got := broker.attempts.Load(); got != 1 {
				t.Fatalf("attempts = %d", got)
			}
		})
	}
}

func restarting() error { return status.Error(codes.Unavailable, "target endpoint is restarting") }

// B-13: the holder's daemon restarts gracefully and no other member serves. Its link holds the connection until the
// next process registered, instead of failing the only member at once.
func TestMemberLinkHoldsWhileItsDaemonRestarts(t *testing.T) {
	previous := secureLinkTransientRetry
	secureLinkTransientRetry = 20 * time.Millisecond
	t.Cleanup(func() { secureLinkTransientRetry = previous })
	broker := &scriptedBroker{errors: []error{restarting(), restarting(), restarting(), nil}}
	plugin := relayOpenPlugin(t, broker, true)

	elapsed := openThroughRelay(plugin)

	if got := broker.attempts.Load(); got != 4 {
		t.Fatalf("attempts = %d, want three restarting answers and then the opened tunnel", got)
	}
	if elapsed >= secureLinkRestartHold {
		t.Fatalf("took %s", elapsed)
	}
}

// A replica whose daemon restarts while another replica serves moves on at once: nginx sends the request there.
func TestReplicaWithAServingAlternativeDoesNotHoldWhileRestarting(t *testing.T) {
	broker := &scriptedBroker{errors: []error{restarting(), nil}}
	plugin := relayOpenPlugin(t, broker, true)
	binding := plugin.secureLinks.bindings["link-1"]
	binding.leaseGated, binding.availabilityCandidateID = true, "node-a"
	plugin.availabilityLease = newAvailabilityLeaseCoordinator(t.TempDir(), plugin.secureLinks, nil)
	t.Cleanup(plugin.availabilityLease.close)
	plugin.availabilityLease.gates.apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-b", RemainingMs: 20000,
		HolderEndpoint: relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY,
	}}}, time.Now())

	openThroughRelay(plugin)

	if got := broker.attempts.Load(); got != 1 {
		t.Fatalf("attempts = %d, a replica with a serving alternative must fail over at once", got)
	}
}

// A plain link waits for its restarting target longer than for a transient refusal.
func TestPlainLinkHoldsForARestartingTargetBeyondTheTransientWait(t *testing.T) {
	previousWait, previousRetry, previousHold := secureLinkTransientWait, secureLinkTransientRetry, secureLinkRestartHold
	secureLinkTransientWait, secureLinkTransientRetry, secureLinkRestartHold = 100*time.Millisecond, 20*time.Millisecond, time.Second
	t.Cleanup(func() {
		secureLinkTransientWait, secureLinkTransientRetry, secureLinkRestartHold = previousWait, previousRetry, previousHold
	})
	errors := make([]error, 0, 12)
	for i := 0; i < 12; i++ {
		errors = append(errors, restarting())
	}
	broker := &scriptedBroker{errors: append(errors, nil)}
	plugin := relayOpenPlugin(t, broker, false)

	openThroughRelay(plugin)

	if got := broker.attempts.Load(); got != 13 {
		t.Fatalf("attempts = %d, want the tunnel opened after the restart", got)
	}
}
