package relaybridge

import (
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func relayCandidate(id, state string, generation uint64) *pb.RelayDataCandidate {
	return &pb.RelayDataCandidate{
		PoolId: "system", RelayInstanceId: id, AssignmentGeneration: generation,
		Addresses: []string{"10.0.0.1"}, Port: 9443, CertificateIdentity: "relay-" + id,
		CertificateFingerprint: "sha256:fingerprint", Capabilities: []string{PoolCapability},
		Grant:           &pb.RelaySignedGrant{KeyId: "key", Payload: []byte("payload"), Signature: []byte("signature")},
		AssignmentState: state,
	}
}

func TestPoolCandidatesPreservePrimaryOrderAndHideStagingFromNormalOpens(t *testing.T) {
	assignment := &pb.RelayGrantAssignment{SchemaVersion: 2, Candidates: []*pb.RelayDataCandidate{
		relayCandidate("primary", "active", 3),
		relayCandidate("fallback", "active", 3),
		relayCandidate("next", "staging", 4),
	}}
	active := PoolCandidates(assignment, false)
	if len(active) != 2 || active[0].GetRelayInstanceId() != "primary" || active[1].GetRelayInstanceId() != "fallback" {
		t.Fatalf("active candidates = %#v", active)
	}
	all := PoolCandidates(assignment, true)
	if len(all) != 3 || all[2].GetRelayInstanceId() != "next" {
		t.Fatalf("probe candidates = %#v", all)
	}
}

func TestPoolCandidatesFailClosedWithoutCapability(t *testing.T) {
	candidate := relayCandidate("remote", "active", 3)
	candidate.Capabilities = nil
	assignment := &pb.RelayGrantAssignment{SchemaVersion: 2, Candidates: []*pb.RelayDataCandidate{candidate}}
	if candidates := PoolCandidates(assignment, false); candidates != nil {
		t.Fatalf("unsupported candidates were accepted: %#v", candidates)
	}
}

func TestRequiredTargetsDeduplicatesPerRelayInstance(t *testing.T) {
	candidate := relayCandidate("remote", "active", 3)
	bundle := &pb.SyncRelayGrantsCommand{Grants: []*pb.RelayGrantAssignment{
		{Role: "endpoint", SchemaVersion: 2, Candidates: []*pb.RelayDataCandidate{candidate}},
		{Role: "connect", SchemaVersion: 2, Candidates: []*pb.RelayDataCandidate{candidate}},
	}}
	targets := RequiredTargets(bundle)
	if len(targets) != 1 || targets[0].ID != "remote" || targets[0].CertificateFingerprint == "" {
		t.Fatalf("targets = %#v", targets)
	}
}

func TestRequiredTargetsIncludesStagingSourceCandidate(t *testing.T) {
	candidate := relayCandidate("remote", "staging", 4)
	bundle := &pb.SyncRelayGrantsCommand{Grants: []*pb.RelayGrantAssignment{{
		Role: "connect", SchemaVersion: 2, Candidates: []*pb.RelayDataCandidate{candidate},
	}}}
	targets := RequiredTargets(bundle)
	if len(targets) != 1 || targets[0].ID != "remote" {
		t.Fatalf("staging source targets = %#v", targets)
	}
}

func TestDrainingCandidateStaysConnectedButReceivesNoNewOpens(t *testing.T) {
	candidate := relayCandidate("remote", "draining", 4)
	assignment := &pb.RelayGrantAssignment{SchemaVersion: 2, Candidates: []*pb.RelayDataCandidate{candidate}}
	if candidates := PoolCandidates(assignment, false); len(candidates) != 0 {
		t.Fatalf("draining candidates were selectable: %#v", candidates)
	}
	targets := RequiredTargets(&pb.SyncRelayGrantsCommand{Grants: []*pb.RelayGrantAssignment{assignment}})
	if len(targets) != 1 || targets[0].ID != "remote" {
		t.Fatalf("draining target lanes were removed: %#v", targets)
	}
}
