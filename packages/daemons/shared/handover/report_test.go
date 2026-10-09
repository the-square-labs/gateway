package handover

import (
	"testing"
	"time"
)

// Sessions a replaced Secure Link connector still carried when it was removed, an hour after the update that
// replaced it, join the node's last update report as a new final report, which Gateway takes again (stand rc.7 O-15:
// reported nowhere). Without a report there is nothing to join.
func TestCutAfterJoinsTheLastUpdateReport(t *testing.T) {
	stateDir := t.TempDir()
	if NewTracker(stateDir, "v2").CutAfter("connector_retired", 3) {
		t.Fatal("a cut joined a report that does not exist")
	}
	finished := time.Now().Add(-time.Hour).Truncate(time.Millisecond)
	if err := writeReport(stateDir+"/"+lastReportFile, Report{FromVersion: "v1", ToVersion: "v2", HandedOver: 4, Kept: 4,
		FinishedAt: finished}); err != nil {
		t.Fatal(err)
	}
	tracker := NewTracker(stateDir, "v2")
	if !tracker.CutAfter("connector_retired", 35) {
		t.Fatal("the cut did not join the last update's report")
	}
	report := tracker.Last()
	if report.Cut["connector_retired"] != 35 || report.Kept != 4 || !report.FinishedAt.After(finished) {
		t.Fatalf("report %+v", report)
	}
	if again := NewTracker(stateDir, "v2").Last(); again.Cut["connector_retired"] != 35 {
		t.Fatalf("the next process reads %+v", again)
	}
}

// A cut that comes while the update's counts are not final joins them when they are, without counting against the
// streams handed over.
func TestCutAfterWhileSettling(t *testing.T) {
	stateDir := t.TempDir()
	if err := WritePending(stateDir, Report{FromVersion: "v1", StartedAt: time.Now(), Handover: true}); err != nil {
		t.Fatal(err)
	}
	tracker := NewTracker(stateDir, "v2")
	if !tracker.CutAfter("connector_retired", 2) {
		t.Fatal("the cut was not taken while settling")
	}
	tracker.Settle()
	if report := tracker.Last(); report == nil || report.Cut["connector_retired"] != 2 || report.Cut[CutResumeFailed] != 0 {
		t.Fatalf("report %+v", report)
	}
}

// The relay stream counters go on from the previous process's, once.
func TestStreamTotalsAreTakenOnce(t *testing.T) {
	stateDir := t.TempDir()
	if err := WriteStreamTotals(stateDir, StreamTotals{Cut: 7}); err != nil {
		t.Fatal(err)
	}
	if totals := TakeStreamTotals(stateDir); totals.Cut != 7 {
		t.Fatalf("totals %+v", totals)
	}
	if totals := TakeStreamTotals(stateDir); totals.Cut != 0 {
		t.Fatalf("totals taken twice: %+v", totals)
	}
	// Left by a process that stopped long ago: no restart of this one.
	if err := WriteStreamTotals(stateDir, StreamTotals{Cut: 7, WrittenAt: time.Now().Add(-time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if totals := TakeStreamTotals(stateDir); totals.Cut != 0 {
		t.Fatalf("stale totals taken: %+v", totals)
	}
}
