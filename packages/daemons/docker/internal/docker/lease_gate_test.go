package docker

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/leasefence"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/lease"
	"google.golang.org/protobuf/proto"
)

type gateTestFence struct{}

func (gateTestFence) HeartbeatAge(time.Duration) (time.Duration, bool) { return 0, true }
func (gateTestFence) Records() (map[string]leasefence.Record, error) {
	return map[string]leasefence.Record{}, nil
}
func (gateTestFence) WriteRecord(leasefence.Record) error { return nil }
func (gateTestFence) DeleteRecord(string) error           { return nil }

type gateTestEngine struct{}

func (gateTestEngine) ListLeaseContainers(context.Context) ([]lease.Container, error) {
	return nil, nil
}
func (gateTestEngine) Inspect(context.Context, string) (lease.Container, bool, error) {
	return lease.Container{}, false, nil
}
func (gateTestEngine) Start(context.Context, string) error                        { return nil }
func (gateTestEngine) Stop(context.Context, string, time.Duration) error          { return nil }
func (gateTestEngine) Kill(context.Context, string) error                         { return nil }
func (gateTestEngine) DisableRestart(context.Context, string) error               { return nil }
func (gateTestEngine) CgroupEmpty(context.Context, lease.Container) (bool, error) { return true, nil }

// leasePluginForTest returns a general-mode plugin whose lease runtime has
// adopted a strict lease-mode manifest for policy-1 that this node does not
// hold.
func leasePluginForTest(t *testing.T) *DockerPlugin {
	t.Helper()
	plugin := availabilityPluginForTest(t)
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	integration := &leaseIntegration{plugin: plugin, serving: map[string]bool{}}
	runtime, err := lease.New(lease.Options{
		NodeID: "node-1", StateDir: t.TempDir(), Signer: availabilitylease.ECDSASigner{Key: key},
		Engine: gateTestEngine{}, Fence: gateTestFence{}, Endpoints: integration, Placements: integration,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)), Async: func(func()) {},
	})
	if err != nil {
		t.Fatal(err)
	}
	integration.runtime = runtime
	plugin.lease = integration
	public, private, _ := ed25519.GenerateKey(rand.Reader)
	der, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	manifestPayload, _ := proto.Marshal(&relayv1.LeaseManifest{
		SchemaVersion: 1, PolicyId: "policy-1", ManifestVersion: 1, Slots: 1, VoterEpoch: 1,
		Mode: relayv1.LeasePolicyMode_LEASE_POLICY_MODE_FAILOVER, PartitionMode: relayv1.LeasePartitionMode_LEASE_PARTITION_MODE_STRICT,
		Candidates: []*relayv1.LeaseCandidate{{Id: "node-1", PublicKey: der}},
		Members:    []*relayv1.LeaseMember{{Id: "relay-1", PublicKey: der, Role: relayv1.LeaseMemberRole_LEASE_MEMBER_ROLE_RELAY}},
		QuorumSets: []*relayv1.LeaseQuorumSet{{VoterIds: []string{"relay-1"}}},
	})
	err = runtime.ApplyLeaseBlocks(lease.BlockUpdate{
		MemberID: "node-1", PolicyKeys: []lease.PolicyKey{{ID: "k1", PublicKey: public}},
		Manifests: []*relayv1.LeaseSignedBlock{availabilitylease.SignPolicyBlock("k1", private, relayv1.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, manifestPayload)},
	})
	if err != nil || !runtime.LeaseMode("policy-1") {
		t.Fatalf("lease manifest not adopted: %v", err)
	}
	return plugin
}

func TestLeaseGateRefusesServeCommandsWithoutTheLease(t *testing.T) {
	plugin := leasePluginForTest(t)
	for _, action := range []string{availabilityActionActivate, availabilityActionAdoptSingle} {
		result := plugin.HandleCommand(availabilityGatewayCommand(availabilityCommand(action, 1, "key-"+action, "op", "")))
		if result.Success || !strings.Contains(result.Error, lease.ErrLeaseNotHeld.Error()) {
			t.Fatalf("%s must be refused without the lease (A5), got success=%v error=%q", action, result.Success, result.Error)
		}
	}
	// Preparing and stopping stay allowed: they never start a copy.
	for _, action := range []string{availabilityActionPrepare, availabilityActionStop} {
		if result := plugin.HandleCommand(availabilityGatewayCommand(availabilityCommand(action, 2, "key-"+action, "op", ""))); !result.Success {
			t.Fatalf("%s must pass the lease gate: %s", action, result.Error)
		}
	}
	// A policy without a lease manifest keeps legacy behavior.
	legacy := availabilityCommand(availabilityActionActivate, 3, "legacy", "op", "")
	legacy.PolicyId = "legacy-policy"
	if err := plugin.leaseGate(availabilityGatewayCommand(legacy)); err != nil {
		t.Fatalf("legacy policy refused: %v", err)
	}
}

func TestLeaseGateCoversDeploymentAndComposeStarts(t *testing.T) {
	plugin := leasePluginForTest(t)
	if _, err := plugin.availability.apply(&pb.DockerAvailabilityCommand{
		Action: availabilityActionPrepare, PolicyId: "policy-1", PlacementId: "placement-1", Generation: 1,
		IdempotencyKey: "prepare", ResourceKind: "compose", ResourceId: "project-1",
	}); err != nil {
		t.Fatal(err)
	}
	compose := &pb.GatewayCommand{Payload: &pb.GatewayCommand_DockerCompose{DockerCompose: &pb.DockerComposeCommand{Action: "start", ProjectId: "project-1"}}}
	if err := plugin.leaseGate(compose); !errors.Is(err, lease.ErrLeaseNotHeld) {
		t.Fatalf("compose start must be gated: %v", err)
	}
	down := &pb.GatewayCommand{Payload: &pb.GatewayCommand_DockerCompose{DockerCompose: &pb.DockerComposeCommand{Action: "down", ProjectId: "project-1"}}}
	if err := plugin.leaseGate(down); err != nil {
		t.Fatalf("compose down must stay allowed: %v", err)
	}
	config, _ := json.Marshal(map[string]any{"desiredConfig": map[string]any{"labels": map[string]string{availabilityPolicyLabel: "policy-1"}}})
	deploy := &pb.GatewayCommand{Payload: &pb.GatewayCommand_DockerDeployment{DockerDeployment: &pb.DockerDeploymentCommand{Action: "deploy_slot", DeploymentId: "dep-1", ConfigJson: string(config)}}}
	if err := plugin.leaseGate(deploy); !errors.Is(err, lease.ErrLeaseNotHeld) {
		t.Fatalf("deployment deploy must be gated by its availability labels: %v", err)
	}
}

func TestLeaseCreateConfigForcesRestartPolicyNo(t *testing.T) {
	plugin := leasePluginForTest(t)
	leaseConfig := `{"image":"nginx","restart_policy":"unless-stopped","stopTimeout":30,"labels":{"` + availabilityPolicyLabel + `":"policy-1"}}`
	var rewritten map[string]any
	if err := json.Unmarshal([]byte(plugin.leaseCreateConfig(leaseConfig)), &rewritten); err != nil {
		t.Fatal(err)
	}
	if rewritten["restartPolicy"] != "no" || rewritten["restart_policy"] != nil || rewritten["stopTimeout"] != float64(30) {
		t.Fatalf("lease-mode create must force restart policy no (A2.1): %v", rewritten)
	}
	legacyConfig := `{"image":"nginx","restartPolicy":"always","labels":{"` + availabilityPolicyLabel + `":"legacy-policy"}}`
	if got := plugin.leaseCreateConfig(legacyConfig); got != legacyConfig {
		t.Fatalf("legacy create changed: %s", got)
	}
	live := &pb.DockerContainerCommand{Action: "live_update", ContainerId: "c1", ConfigJson: `{"restartPolicy":"no"}`}
	if err := plugin.leaseLiveUpdateGate(live); err != nil {
		t.Fatalf("restart policy no is always allowed: %v", err)
	}
}

func TestLeaseEndpointGateFollowsServingFlag(t *testing.T) {
	plugin := leasePluginForTest(t)
	integration := plugin.lease
	store, err := securelink.NewStateStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	// T3 marks availability members, including deployment router targets and
	// dormant standbys, with availability_policy_id.
	if err := store.Commit(&pb.SyncProxySecureLinksCommand{Bindings: []*pb.ProxySecureLinkBinding{
		{LinkId: "link-lease", Role: "target", TargetContainer: "router-1", AvailabilityPolicyId: "policy-1", AvailabilityCandidateId: "node-1", Dormant: true},
		{LinkId: "link-legacy", Role: "target", TargetContainer: "app", AvailabilityPolicyId: "legacy-policy"},
	}}); err != nil {
		t.Fatal(err)
	}
	plugin.secureLinkState = store
	if integration.endpointAllowed("link-lease") {
		t.Fatal("a lease-mode endpoint must not register before this node serves it (D8)")
	}
	if !integration.endpointAllowed("link-legacy") || !integration.endpointAllowed("link-unknown") {
		t.Fatal("non-lease endpoints keep registering")
	}
	integration.mu.Lock()
	integration.serving["policy-1"] = true
	integration.mu.Unlock()
	if !integration.endpointAllowed("link-lease") {
		t.Fatal("serving holder must register its endpoint")
	}
	var nilIntegration *leaseIntegration
	if !nilIntegration.endpointAllowed("link-lease") {
		t.Fatal("daemons without the lease runtime keep legacy registration")
	}
}

func TestLeaseServeSetSelectsCurrentPlacementAndActiveSlot(t *testing.T) {
	plugin := leasePluginForTest(t)
	if _, err := plugin.availability.apply(&pb.DockerAvailabilityCommand{
		Action: availabilityActionPrepare, PolicyId: "policy-1", PlacementId: "placement-2", Generation: 4,
		IdempotencyKey: "prepare", ResourceKind: "deployment", ResourceId: "dep-1",
		ConfigJson: `{"runtimeIdentity":{"activeSlot":"green","deploymentId":"dep-1"}}`,
	}); err != nil {
		t.Fatal(err)
	}
	containers := []lease.Container{
		{ID: "blue", PlacementID: "placement-2", Labels: map[string]string{deploymentRoleLabel: "app", deploymentSlotLabel: "blue"}},
		{ID: "green", PlacementID: "placement-2", Labels: map[string]string{deploymentRoleLabel: "app", deploymentSlotLabel: "green"}},
		{ID: "stale", PlacementID: "placement-1", Labels: map[string]string{}},
	}
	serve := plugin.lease.ServeSet("policy-1", containers)
	if len(serve) != 1 || serve[0].ID != "green" {
		t.Fatalf("serve set %+v, want only the active slot of the current placement", serve)
	}
	placement, ok := plugin.lease.Local("policy-1")
	if !ok || placement.PlacementID != "placement-2" || placement.Generation != 4 {
		t.Fatalf("local placement %+v ok=%v", placement, ok)
	}
}

// Stand run c2: a deployment placement recorded by the legacy path names no
// active slot, and after a host reboot the holder started both blue and green.
func TestLeaseServeSetStartsOneSlotWithoutARecordedActiveSlot(t *testing.T) {
	plugin := leasePluginForTest(t)
	if _, err := plugin.availability.apply(&pb.DockerAvailabilityCommand{
		Action: availabilityActionPrepare, PolicyId: "policy-1", PlacementId: "placement-1", Generation: 1,
		IdempotencyKey: "prepare", ResourceKind: "deployment", ResourceId: "dep-1",
		ConfigJson: `{"runtimeIdentity":{"deploymentId":"dep-1"}}`,
	}); err != nil {
		t.Fatal(err)
	}
	app := func(id, slot string, started time.Time) lease.Container {
		return lease.Container{ID: id, PlacementID: "placement-1", StartedAt: started,
			Labels: map[string]string{deploymentRoleLabel: "app", deploymentSlotLabel: slot}}
	}
	switched := time.Date(2026, 9, 28, 7, 0, 0, 0, time.UTC)
	serve := plugin.lease.ServeSet("policy-1", []lease.Container{
		app("blue", "blue", switched.Add(-time.Hour)), app("green", "green", switched),
	})
	if len(serve) != 1 || serve[0].ID != "green" {
		t.Fatalf("serve set %+v, want only the slot started last", serve)
	}
	serve = plugin.lease.ServeSet("policy-1", []lease.Container{app("blue", "blue", time.Time{}), app("green", "green", time.Time{})})
	if len(serve) != 1 || serve[0].ID != "blue" {
		t.Fatalf("serve set %+v, want the default blue slot for a standby that never ran", serve)
	}
	single := []lease.Container{{ID: "app", PlacementID: "placement-1", Labels: map[string]string{}}}
	if serve := plugin.lease.ServeSet("policy-1", single); len(serve) != 1 {
		t.Fatalf("a container placement keeps its container: %+v", serve)
	}
}
