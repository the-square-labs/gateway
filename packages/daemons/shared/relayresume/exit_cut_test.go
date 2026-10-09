package relayresume

import (
	"testing"
	"time"
)

// A stop or restart that is no update ends the streams the process carries: its drain ends some, the exit the rest.
// Both are cut by the exit, and the next process goes on from the total (stand rc.7 O-5: a launcher crash restart
// lost every count of the streams it cut). A stream that ended on its own before the exit is not cut.
func TestExitCutCountsTheStreamsTheExitEnds(t *testing.T) {
	h := newHarness(t, "relay-a")
	finished, finishedSession := h.stream()
	_ = finished.Close()
	waitUntil(t, "the closed stream to finish", func() bool { return finishedSession.State().Terminal() })

	_, drained := h.stream()
	_, carried := h.stream()
	for _, session := range []*Session{drained, carried} {
		waitUntil(t, "the stream to open", func() bool { return session.State() == StateOpen })
	}
	h.mgr.CarryCut(5)
	h.mgr.BeginExit()
	// The drain ends one stream by this side's hand.
	drained.Cancel()
	waitUntil(t, "the drained stream to be counted", func() bool { return h.mgr.Stats().Cut == 6 })
	// The other is still carried when the process exits.
	if cut := h.mgr.ExitCut(); cut != 7 {
		t.Fatalf("exit cut total %d, want the 5 carried over, the drained stream and the one still open", cut)
	}
}

func waitUntil(t *testing.T, what string, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !done() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}
