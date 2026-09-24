package lifecycle

import (
	"reflect"
	"testing"
)

// A certificate renewal changes one relay target. Only that target's future
// connections change: no lane to any relay is torn down for it.
func TestPlanRelayTargetsRestartsNothingForAChangedCertificate(t *testing.T) {
	running := map[string]bool{"relay-a": true, "relay-b": true}
	desired := []RelayTunnelTarget{
		{ID: "relay-a", Addresses: []string{"a.example"}, CertificateIdentity: "relay-a-r2", CertificateFingerprint: "sha256:new"},
		{ID: "relay-b", Addresses: []string{"b.example"}, CertificateIdentity: "relay-b", CertificateFingerprint: "sha256:b"},
	}
	plan := planRelayTargets(running, desired)
	if len(plan.start) != 0 || len(plan.stop) != 0 {
		t.Fatalf("lanes restarted for a certificate change: start=%v stop=%v", plan.start, plan.stop)
	}
	if !reflect.DeepEqual(plan.update, desired) {
		t.Fatalf("targets were not updated in place: %v", plan.update)
	}
}

func TestPlanRelayTargetsStartsAndStopsOnlyWhatChanged(t *testing.T) {
	plan := planRelayTargets(
		map[string]bool{"relay-a": true, "relay-gone": true},
		[]RelayTunnelTarget{{ID: "relay-a"}, {ID: "relay-new"}, {ID: "relay-new"}},
	)
	if len(plan.start) != 1 || plan.start[0].ID != "relay-new" {
		t.Fatalf("start = %v", plan.start)
	}
	if !reflect.DeepEqual(plan.stop, []string{"relay-gone"}) {
		t.Fatalf("stop = %v", plan.stop)
	}
	if len(plan.update) != 1 || plan.update[0].ID != "relay-a" {
		t.Fatalf("update = %v", plan.update)
	}
}
