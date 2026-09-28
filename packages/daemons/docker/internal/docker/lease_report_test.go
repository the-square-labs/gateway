package docker

import (
	"testing"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/lease"
)

// Graceful close: the lease report carries a retained slot to Gateway.
func TestLeaseReportCarriesARetainedSlot(t *testing.T) {
	report := leaseReportProto(lease.Report{
		MemberID: "node-1",
		Held: []lease.Held{{
			Key: availabilitylease.Key{PolicyID: "p1", Slot: 1}, Role: availabilitylease.RoleRetained.String(), Retained: true,
			Ballot: availabilitylease.Ballot{Round: 9, Incarnation: 2, Proposer: "node-1"}, PlacementID: "pl-1", PlacementGeneration: 3,
		}},
		Events: []lease.ReportEvent{{Kind: string(availabilitylease.EventRetained), Key: availabilitylease.Key{PolicyID: "p1", Slot: 1}}},
	}, nil)
	held := report.GetHeld()
	if len(held) != 1 || !held[0].GetRetained() || held[0].GetRole() != "retained" || held[0].GetSlot() != 1 || held[0].GetBallot().GetRound() != 9 || held[0].GetPlacementId() != "pl-1" {
		t.Fatalf("held = %v", held)
	}
	if events := report.GetEvents(); len(events) != 1 || events[0].GetKind() != "retained" {
		t.Fatalf("events = %v", events)
	}
}

// N-15: the report states the wall clock its times were converted with.
func TestLeaseReportCarriesItsWallClock(t *testing.T) {
	report := leaseReportProto(lease.Report{MemberID: "node-1", ReportedAtUnixMs: 1_800_000_123_456}, nil)
	if got := report.GetReportedAtUnixMs(); got != 1_800_000_123_456 {
		t.Fatalf("reported at %d", got)
	}
}
