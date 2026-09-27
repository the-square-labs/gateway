package relaybridge

import (
	"reflect"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func TestLatencyTrackerSmoothsAndExpiresSamples(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	tracker := NewLatencyTracker(func() time.Time { return now })
	tracker.Observe("relay", 10*time.Millisecond)
	tracker.Observe("relay", 20*time.Millisecond)
	if rtt, ok := tracker.RTT("relay"); !ok || rtt != 13*time.Millisecond {
		t.Fatalf("rtt = %v %v, want 13ms", rtt, ok)
	}
	samples := tracker.Samples()
	if len(samples) != 1 || samples[0].GetRelayInstanceId() != "relay" || samples[0].GetRttMicros() != 13_000 {
		t.Fatalf("samples = %v", samples)
	}
	now = now.Add(latencyMaxAge + time.Second)
	if _, ok := tracker.RTT("relay"); ok {
		t.Fatal("a stale sample still counts")
	}
	// A new sample after a gap starts over instead of averaging with the stale one.
	tracker.Observe("relay", 2*time.Millisecond)
	if rtt, _ := tracker.RTT("relay"); rtt != 2*time.Millisecond {
		t.Fatalf("rtt after a gap = %v", rtt)
	}
}

func TestLatencyTargetsAddsPoolRelaysToAssignedOnes(t *testing.T) {
	bundle := &pb.SyncRelayGrantsCommand{
		Grants: []*pb.RelayGrantAssignment{{
			SchemaVersion: 2,
			Candidates: []*pb.RelayDataCandidate{{
				RelayInstanceId: "assigned", AssignmentGeneration: 1, Addresses: []string{"10.0.0.1"}, Port: 9443,
				CertificateIdentity: "relay", CertificateFingerprint: "sha256:x", Capabilities: []string{PoolCapability},
				Grant: &pb.RelaySignedGrant{}, AssignmentState: "active",
			}},
		}},
		RelayLatencyTargets: []*pb.RelayLatencyTarget{
			{RelayInstanceId: "assigned", Addresses: []string{"ignored"}, Port: 1},
			{RelayInstanceId: "other", Addresses: []string{"10.0.0.2"}, Port: 9443},
			{RelayInstanceId: "local"},
		},
	}
	got := LatencyTargets(bundle)
	want := []Target{
		{ID: "assigned", Addresses: []string{"10.0.0.1"}, Port: 9443, CertificateIdentity: "relay", CertificateFingerprint: "sha256:x"},
		{ID: "local"},
		{ID: "other", Addresses: []string{"10.0.0.2"}, Port: 9443},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("targets = %#v", got)
	}
}
