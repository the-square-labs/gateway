package docker

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/relaybridge"
)

func TestAssignmentsForRelayTargetPreservesActiveAndStagingGenerations(t *testing.T) {
	assignment := &pb.RelayGrantAssignment{
		EndpointId:    "22222222-2222-4222-8222-222222222222",
		SchemaVersion: 2,
		Candidates: []*pb.RelayDataCandidate{
			{
				RelayInstanceId: "relay-1", AssignmentGeneration: 3, AssignmentState: "active",
				Capabilities: []string{relaybridge.PoolCapability}, Grant: &pb.RelaySignedGrant{KeyId: "active"},
			},
			{
				RelayInstanceId: "relay-1", AssignmentGeneration: 4, AssignmentState: "staging",
				Capabilities: []string{relaybridge.PoolCapability}, Grant: &pb.RelaySignedGrant{KeyId: "staging"},
			},
		},
	}
	projected := assignmentsForRelayTarget(assignment, "relay-1")
	if len(projected) != 2 {
		t.Fatalf("projected assignments = %d", len(projected))
	}
	if relayRegistrationKey(projected[0]) != assignment.EndpointId+":3" || relayRegistrationKey(projected[1]) != assignment.EndpointId+":4" {
		t.Fatalf("projected registration keys = %q, %q", relayRegistrationKey(projected[0]), relayRegistrationKey(projected[1]))
	}
}

func TestRelayConnectorHandshake(t *testing.T) {
	bindingID := "11111111-1111-4111-8111-111111111111"
	var input bytes.Buffer
	input.WriteString(DatabaseTunnelHandshakeMagic)
	var size [2]byte
	binary.BigEndian.PutUint16(size[:], uint16(len(bindingID)))
	input.Write(size[:])
	input.WriteString(bindingID)
	got, err := readDatabaseTunnelHandshake(&input)
	if err != nil || got != bindingID {
		t.Fatalf("read handshake = %q, %v", got, err)
	}
}

func TestRelayGrantStoreDoesNotRestartLanesForEndpointGrantChanges(t *testing.T) {
	dir := t.TempDir()
	store, err := newRelayGrantStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	first := &pb.SyncRelayGrantsCommand{PolicyRevision: 7, GeneratedAtUnixMs: 100, DataLanes: 4}
	if err := store.sync(first); err != nil {
		t.Fatal(err)
	}
	<-store.changed

	updated := &pb.SyncRelayGrantsCommand{
		PolicyRevision:    8,
		GeneratedAtUnixMs: 101,
		DataLanes:         4,
		Grants: []*pb.RelayGrantAssignment{{
			Role:       "endpoint",
			OwnerKind:  proxySecureLinkOwnerKind,
			OwnerId:    "11111111-1111-4111-8111-111111111111",
			EndpointId: "22222222-2222-4222-8222-222222222222",
		}},
	}
	if err := store.sync(updated); err != nil {
		t.Fatal(err)
	}
	select {
	case <-store.changed:
		t.Fatal("endpoint-only grant change restarted relay lanes")
	default:
	}
}

func TestRelayGrantStoreRefreshesWithinPolicyRevision(t *testing.T) {
	dir := t.TempDir()
	store, err := newRelayGrantStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	first := &pb.SyncRelayGrantsCommand{PolicyRevision: 7, GeneratedAtUnixMs: 100}
	if err := store.sync(first); err != nil {
		t.Fatal(err)
	}
	refreshed := &pb.SyncRelayGrantsCommand{PolicyRevision: 7, GeneratedAtUnixMs: 101}
	if err := store.sync(refreshed); err != nil {
		t.Fatal(err)
	}
	if err := store.sync(first); err == nil {
		t.Fatal("expected stale refresh rejection")
	}
	info, err := os.Stat(filepath.Join(dir, relayGrantFile))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("grant mode = %o", info.Mode().Perm())
	}
}
