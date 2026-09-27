package daemon

import (
	"testing"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

func TestLeaseGateTrackerOpensOnlyForTheReportedHolder(t *testing.T) {
	tracker := newLeaseGateTracker()
	now := time.Now()
	tracker.apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-a", RemainingMs: 30000,
	}}}, now)

	if !tracker.openFor("policy-1", "node-a", now) {
		t.Fatal("gate should be open for the reported holder")
	}
	if tracker.openFor("policy-1", "node-b", now) {
		t.Fatal("gate must not open for a different candidate")
	}
	if tracker.openFor("policy-2", "node-a", now) {
		t.Fatal("gate must not open for a different policy")
	}
}

// TestLeaseGateTrackerLeaseModeFalseOpensForEveryCandidate covers the B2
// fix: a policy that is not lease-bound (legacy, or after its lease closed)
// admits every member once a relay reports lease_mode=false, regardless of
// holder_id. Without this, a lease-bound member loses ingress permanently
// the moment its policy leaves lease mode.
func TestLeaseGateTrackerLeaseModeFalseOpensForEveryCandidate(t *testing.T) {
	tracker := newLeaseGateTracker()
	now := time.Now()
	tracker.apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{
		{PolicyId: "policy-1", Slot: 0, LeaseMode: false, Open: false, HolderId: ""},
	}}, now)
	if !tracker.openFor("policy-1", "node-a", now) {
		t.Fatal("a fresh lease_mode=false view must open every candidate's socket (legacy admission, B2)")
	}
	if !tracker.openFor("policy-1", "node-b", now) {
		t.Fatal("legacy admission must not depend on which candidate is asking")
	}
}

func TestLeaseGateTrackerClosesOnAClosedLeaseModeGate(t *testing.T) {
	tracker := newLeaseGateTracker()
	now := time.Now()
	tracker.apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{
		{PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: false, HolderId: "node-a", Reason: "expired"},
	}}, now)
	if tracker.openFor("policy-1", "node-a", now) {
		t.Fatal("a closed lease-mode gate must not open a socket")
	}
}

func TestLeaseGateTrackerViewGoesStaleWithoutABroadcast(t *testing.T) {
	tracker := newLeaseGateTracker()
	now := time.Now()
	tracker.apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-a", RemainingMs: 1000,
	}}}, now)
	if !tracker.openFor("policy-1", "node-a", now.Add(500*time.Millisecond)) {
		t.Fatal("gate should still be open within its reported TTL")
	}
	if tracker.openFor("policy-1", "node-a", now.Add(1500*time.Millisecond)) {
		t.Fatal("gate must close once its TTL elapses, even with no new broadcast")
	}
}

func TestLeaseGateTrackerCapsTTLAtTheLeaseTerm(t *testing.T) {
	tracker := newLeaseGateTracker()
	now := time.Now()
	// A relay that misreports an implausibly long remaining_ms must not keep
	// a socket open past the protocol's own lease term (D8, A8).
	tracker.apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-a",
		RemainingMs: uint64(2 * leaseGateMaxTTL / time.Millisecond),
	}}}, now)
	if tracker.openFor("policy-1", "node-a", now.Add(leaseGateMaxTTL+time.Second)) {
		t.Fatal("a view must never be trusted past the lease term regardless of what the relay reports")
	}
}

func TestLeaseGateTrackerSecondRelayReopensAfterFirstGoesStale(t *testing.T) {
	tracker := newLeaseGateTracker()
	now := time.Now()
	tracker.apply("relay-1", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-a", RemainingMs: 100,
	}}}, now)
	tracker.apply("relay-2", &relayv1.LeaseGateSnapshot{Gates: []*relayv1.LeaseGateView{{
		PolicyId: "policy-1", Slot: 0, LeaseMode: true, Open: true, HolderId: "node-a", RemainingMs: 30000,
	}}}, now)
	later := now.Add(500 * time.Millisecond)
	if !tracker.openFor("policy-1", "node-a", later) {
		t.Fatal("some relay's still-fresh view should keep the socket open even after another relay's view expired")
	}
}
