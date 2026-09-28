package lease

import (
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
)

func heldView(t *testing.T, report Report) Held {
	t.Helper()
	for _, held := range report.Held {
		if held.Key.PolicyID == testPolicy {
			return held
		}
	}
	t.Fatalf("no held view for %s: %+v", testPolicy, report.Held)
	return Held{}
}

// B-14: the holder reports when it acquired the key with every report, not
// only in the acquired event. Reports built while Gateway is away drain that
// event, and the next voter to report after a restart only knows when it
// first saw the holder.
func TestHolderReportsItsAcquisitionTimeUntilItStopsHolding(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1, d2 := w.daemon("d1"), w.daemon("d2")

	first := d1.runtime.Report()
	var acquiredAt int64
	for _, event := range first.Events {
		if event.Kind == string(availabilitylease.EventAcquired) && event.Key.PolicyID == testPolicy {
			acquiredAt = event.AtUnixMs
		}
	}
	if acquiredAt == 0 {
		t.Fatalf("acquired event missing: %+v", first.Events)
	}
	if held := heldView(t, first); held.SinceUnixMs != acquiredAt {
		t.Fatalf("held since %d, want the acquisition %d", held.SinceUnixMs, acquiredAt)
	}

	// Renewals do not move it, and it outlives the drained event.
	w.run(40 * time.Second)
	later := d1.runtime.Report()
	if len(later.Events) != 0 {
		t.Fatalf("no transition expected while renewing: %+v", later.Events)
	}
	if held := heldView(t, later); held.SinceUnixMs != acquiredAt || held.Ballot.Round <= heldView(t, first).Ballot.Round {
		t.Fatalf("after renewals held since %d (round %d), want %d with a later round", held.SinceUnixMs, held.Ballot.Round, acquiredAt)
	}

	// A handoff ends d1's holding; d2 reports its own acquisition.
	if err := d1.runtime.Handoff(handoffRequest(w, "d2")); err != nil {
		t.Fatal(err)
	}
	w.waitServing("d2", 15*time.Second)
	w.run(time.Second)
	for _, held := range d1.runtime.Report().Held {
		if held.Key.PolicyID == testPolicy && held.SinceUnixMs != 0 {
			t.Fatalf("a node that handed the key off reports no holding time: %+v", held)
		}
	}
	successor := heldView(t, d2.runtime.Report())
	if successor.SinceUnixMs <= acquiredAt || successor.SinceUnixMs > d2.runtime.opts.Wall().UnixMilli() {
		t.Fatalf("successor held since %d, want its own acquisition after %d", successor.SinceUnixMs, acquiredAt)
	}
}
