package docker

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	dockerconfig "github.com/wiolett-industries/gateway/docker-daemon/internal/config"
	"google.golang.org/grpc"
)

const fenceEndpointID = "22222222-2222-4222-8222-222222222222"

func fenceTestRouter(t *testing.T, targetID string) *relayTunnelRouter {
	t.Helper()
	store, err := newRelayGrantStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	plugin := &DockerPlugin{cfg: &dockerconfig.Config{}, logger: slog.New(slog.NewTextHandler(io.Discard, nil)), relayGrants: store}
	return &relayTunnelRouter{plugin: plugin, targetID: targetID, registrations: map[string]*relayEndpointRegistration{}}
}

func syncFences(t *testing.T, router *relayTunnelRouter, revision uint64, fences ...*pb.RelayRevocationFence) {
	t.Helper()
	if err := router.plugin.relayGrants.sync(&pb.SyncRelayGrantsCommand{PolicyRevision: revision, RevocationFences: fences}); err != nil {
		t.Fatal(err)
	}
}

func fenceEndpointAssignment(relayInstanceID string) *pb.RelayGrantAssignment {
	return &pb.RelayGrantAssignment{
		Role: "endpoint", OwnerKind: proxySecureLinkOwnerKind, EndpointId: fenceEndpointID, SchemaVersion: 2,
		Candidates: []*pb.RelayDataCandidate{{RelayInstanceId: relayInstanceID, AssignmentGeneration: 3}},
	}
}

func incomingFor(routeID string, generation uint64) *relayv1.IncomingTunnel {
	incoming := &relayv1.IncomingTunnel{SessionId: "session", AcceptToken: "token"}
	if routeID != "" {
		incoming.Route = &relayv1.IncomingTunnelRoute{RouteId: routeID, RouteGeneration: generation, SourceKind: "daemon", SourceId: "source"}
	}
	return incoming
}

func staleRelayFence(relayInstanceID string) *pb.RelayRevocationFence {
	return &pb.RelayRevocationFence{
		RelayInstanceId: relayInstanceID, EndpointId: fenceEndpointID,
		Routes: []*pb.RelayRevokedRoute{{RouteId: "revoked-route"}},
	}
}

func TestEndpointAcceptsEveryRouteThroughARelayThatAcknowledgedInTime(t *testing.T) {
	router := fenceTestRouter(t, "relay-1")
	syncFences(t, router, 1)
	for _, incoming := range []*relayv1.IncomingTunnel{incomingFor("revoked-route", 1), incomingFor("", 0)} {
		release, refusal := router.admitIncoming(fenceEndpointAssignment("relay-1"), incoming, func() {})
		if refusal != "" {
			t.Fatalf("unfenced relay refused %v: %s", incoming.GetRoute(), refusal)
		}
		release()
	}
}

func TestEndpointRefusesOnlyTheRevokedRouteThroughAStaleRelay(t *testing.T) {
	router := fenceTestRouter(t, "relay-1")
	syncFences(t, router, 1, staleRelayFence("relay-1"))
	if _, refusal := router.admitIncoming(fenceEndpointAssignment("relay-1"), incomingFor("revoked-route", 1), func() {}); refusal != relaybridge.RefusalRevokedRoute {
		t.Fatalf("revoked route refusal = %q", refusal)
	}
	release, refusal := router.admitIncoming(fenceEndpointAssignment("relay-1"), incomingFor("other-route", 1), func() {})
	if refusal != "" {
		t.Fatalf("other route through the same relay refused: %s", refusal)
	}
	release()
	// A relay that names no route is refused entirely for the fenced endpoint only.
	if _, refusal := router.admitIncoming(fenceEndpointAssignment("relay-1"), incomingFor("", 0), func() {}); refusal != relaybridge.RefusalUnnamedRoute {
		t.Fatalf("old relay refusal = %q", refusal)
	}
	other := fenceEndpointAssignment("relay-1")
	other.EndpointId = "33333333-3333-4333-8333-333333333333"
	release, refusal = router.admitIncoming(other, incomingFor("", 0), func() {})
	if refusal != "" {
		t.Fatalf("old relay refused for an unfenced endpoint: %s", refusal)
	}
	release()
	if len(router.accepted) != 0 {
		t.Fatalf("released tunnels stay tracked: %d", len(router.accepted))
	}
}

func TestEndpointResolvesTheLocalRelayBehindTheLegacyRouter(t *testing.T) {
	router := fenceTestRouter(t, relaybridge.LegacyTargetID)
	syncFences(t, router, 1, staleRelayFence("local-relay-instance"))
	if _, refusal := router.admitIncoming(fenceEndpointAssignment("local-relay-instance"), incomingFor("revoked-route", 1), func() {}); refusal == "" {
		t.Fatal("legacy router accepted a revoked route through the fenced local relay")
	}
}

func TestRevocationFenceClosesAcceptedTunnelsOfRevokedRoutesAndClearsOnAcknowledgement(t *testing.T) {
	router := fenceTestRouter(t, "relay-1")
	syncFences(t, router, 1)
	type tracked struct {
		ctx     context.Context
		release func()
	}
	admit := func(routeID string) tracked {
		ctx, cancel := context.WithCancel(context.Background())
		t.Cleanup(cancel)
		release, refusal := router.admitIncoming(fenceEndpointAssignment("relay-1"), incomingFor(routeID, 1), cancel)
		if refusal != "" {
			t.Fatalf("%q refused before the fence: %s", routeID, refusal)
		}
		return tracked{ctx: ctx, release: release}
	}
	revoked, other, unnamed := admit("revoked-route"), admit("other-route"), admit("")

	syncFences(t, router, 2, staleRelayFence("relay-1"))
	router.reconcileRegistrations()
	if revoked.ctx.Err() == nil || unnamed.ctx.Err() == nil {
		t.Fatal("fence left a refused tunnel open")
	}
	if other.ctx.Err() != nil {
		t.Fatal("fence closed a tunnel of an unrevoked route")
	}
	revoked.release()
	unnamed.release()

	// The relay acknowledged: Gateway sends the bundle without the fence.
	syncFences(t, router, 3)
	release, refusal := router.admitIncoming(fenceEndpointAssignment("relay-1"), incomingFor("", 0), func() {})
	if refusal != "" {
		t.Fatalf("acknowledged relay still refused: %s", refusal)
	}
	release()
	other.release()
}

type unavailableBroker struct{ relayv1.TunnelBrokerClient }

func (unavailableBroker) RegisterEndpoint(context.Context, ...grpc.CallOption) (relayv1.TunnelBroker_RegisterEndpointClient, error) {
	return nil, errors.New("relay unavailable")
}

func TestReconcileDoesNotRenewAnUnchangedRegistration(t *testing.T) {
	router := fenceTestRouter(t, "relay-1")
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	router.ctx, router.client = ctx, unavailableBroker{}
	bundle := func(revision uint64, grant string) *pb.SyncRelayGrantsCommand {
		assignment := fenceEndpointAssignment("relay-1")
		assignment.Candidates[0].Capabilities = []string{relaybridge.PoolCapability}
		assignment.Candidates[0].AssignmentState = "active"
		assignment.Candidates[0].Grant = &pb.RelaySignedGrant{KeyId: "key", Payload: []byte(grant)}
		return &pb.SyncRelayGrantsCommand{PolicyRevision: revision, Grants: []*pb.RelayGrantAssignment{assignment}}
	}
	latest := func() *pb.RelayGrantAssignment {
		router.mu.Lock()
		defer router.mu.Unlock()
		if len(router.registrations) != 1 {
			t.Fatalf("registrations = %d", len(router.registrations))
		}
		for _, registration := range router.registrations {
			return registration.latest
		}
		return nil
	}
	if err := router.plugin.relayGrants.sync(bundle(1, "first")); err != nil {
		t.Fatal(err)
	}
	router.reconcileRegistrations()
	first := latest()
	// Gateway resends the same bundle: nothing to renew.
	router.reconcileRegistrations()
	if latest() != first {
		t.Fatal("an unchanged assignment was renewed")
	}
	if err := router.plugin.relayGrants.sync(bundle(2, "refreshed")); err != nil {
		t.Fatal(err)
	}
	router.reconcileRegistrations()
	if next := latest(); next == first || string(next.GetGrant().GetPayload()) != "refreshed" {
		t.Fatal("a refreshed grant was not renewed")
	}
}
