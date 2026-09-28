package docker

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	dockerconfig "github.com/wiolett-industries/gateway/docker-daemon/internal/config"
	"google.golang.org/grpc"
)

type countingBrokerClient struct {
	relayv1.TunnelBrokerClient
	grants chan string
}

func (c *countingBrokerClient) RegisterEndpoint(ctx context.Context, _ ...grpc.CallOption) (grpc.BidiStreamingClient[relayv1.EndpointControl, relayv1.EndpointControl], error) {
	return &recordingEndpointStream{ctx: ctx, grants: c.grants}, nil
}

type recordingEndpointStream struct {
	grpc.ClientStream
	ctx    context.Context
	grants chan string
}

func (s *recordingEndpointStream) Send(message *relayv1.EndpointControl) error {
	if register := message.GetRegister(); register != nil {
		s.grants <- register.GetGrant().GetKeyId()
	}
	return nil
}

func (s *recordingEndpointStream) Recv() (*relayv1.EndpointControl, error) {
	<-s.ctx.Done()
	return nil, errors.New("closed")
}

func restoreTestBundle(revision uint64, grantKey string) *pb.SyncRelayGrantsCommand {
	return &pb.SyncRelayGrantsCommand{PolicyRevision: revision, Grants: []*pb.RelayGrantAssignment{{
		Role: "endpoint", OwnerKind: proxySecureLinkOwnerKind, OwnerId: "11111111-1111-4111-8111-111111111111",
		EndpointId: fenceEndpointID, Grant: &pb.RelaySignedGrant{KeyId: grantKey},
	}}}
}

func restoredGrantStore(t *testing.T, bundle *pb.SyncRelayGrantsCommand) *relayGrantStore {
	t.Helper()
	dir := t.TempDir()
	first, err := newRelayGrantStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	if first.registrationHold(time.Now()) != 0 {
		t.Fatal("a store without a persisted bundle held registrations")
	}
	if err := first.sync(bundle); err != nil {
		t.Fatal(err)
	}
	restored, err := newRelayGrantStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	return restored
}

func TestRestoredRelayGrantsHoldRegistrationsUntilGatewaySendsABundle(t *testing.T) {
	store := restoredGrantStore(t, restoreTestBundle(7, "restored"))
	if hold := store.registrationHold(time.Now()); hold <= 0 || hold > relayGrantRestoreHold {
		t.Fatalf("restored hold = %v", hold)
	}
	if hold := store.registrationHold(time.Now().Add(relayGrantRestoreHold)); hold != 0 {
		t.Fatalf("hold after its bound = %v", hold)
	}
	// An unchanged bundle from Gateway still confirms the restored one.
	if err := store.sync(restoreTestBundle(7, "restored")); err != nil {
		t.Fatal(err)
	}
	if hold := store.registrationHold(time.Now()); hold != 0 {
		t.Fatalf("hold after a Gateway bundle = %v", hold)
	}
}

func TestRestartedDaemonRegistersWithGatewaysBundleNotTheRestoredOne(t *testing.T) {
	store := restoredGrantStore(t, restoreTestBundle(7, "restored"))
	client := &countingBrokerClient{grants: make(chan string, 4)}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	router := &relayTunnelRouter{
		plugin: &DockerPlugin{cfg: &dockerconfig.Config{}, logger: slog.New(slog.NewTextHandler(io.Discard, nil)), relayGrants: store},
		ctx:    ctx, client: client, targetID: relaybridge.LegacyTargetID, registrations: map[string]*relayEndpointRegistration{},
	}
	router.plugin.relayTunnels = map[string]*relayTunnelRouter{relaybridge.LegacyTargetID: router}

	router.reconcileRegistrations()
	router.reconcileAfterRestoreHold(ctx)
	select {
	case grant := <-client.grants:
		t.Fatalf("registered the restored grant %q before Gateway's bundle", grant)
	case <-time.After(50 * time.Millisecond):
	}

	if _, err := router.plugin.SyncRelayGrants(restoreTestBundle(8, "fresh")); err != nil {
		t.Fatal(err)
	}
	select {
	case grant := <-client.grants:
		if grant != "fresh" {
			t.Fatalf("first registration used grant %q", grant)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no registration after Gateway's bundle")
	}
}

func TestRestoredGrantsRegisterOnceTheHoldRunsOutWithoutGateway(t *testing.T) {
	store := restoredGrantStore(t, restoreTestBundle(7, "restored"))
	store.restoredUntil = time.Now().Add(30 * time.Millisecond)
	client := &countingBrokerClient{grants: make(chan string, 4)}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	router := &relayTunnelRouter{
		plugin: &DockerPlugin{cfg: &dockerconfig.Config{}, logger: slog.New(slog.NewTextHandler(io.Discard, nil)), relayGrants: store},
		ctx:    ctx, client: client, targetID: relaybridge.LegacyTargetID, registrations: map[string]*relayEndpointRegistration{},
	}
	router.reconcileRegistrations()
	router.reconcileAfterRestoreHold(ctx)
	select {
	case grant := <-client.grants:
		if grant != "restored" {
			t.Fatalf("registration after the hold used grant %q", grant)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("restored grant was not registered after the hold")
	}
}
