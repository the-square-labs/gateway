package availabilitylease

import (
	"testing"
	"time"
)

// hafoWorld mirrors the stand's failover policy: three candidates that are
// also the voters, and two relays that are members only (shadow accepts).
func hafoWorld(t *testing.T) *simWorld {
	return newScenario(t, scenarioSpec{
		relays:     []nodeSpec{{id: "r1"}, {id: "r2"}},
		daemons:    []nodeSpec{{id: "d1", voter: true}, {id: "d2", voter: true}, {id: "d3", voter: true}},
		candidates: []string{"d1", "d2", "d3"},
	})
}

func fenceReasons(w *simWorld, node string) []FenceReason {
	var out []FenceReason
	for _, event := range w.eventsOf(node, EventFence) {
		out = append(out, event.event.Reason)
	}
	return out
}

// B-11 (scenario i2): the frozen holder resumes behind a firewall that lets it
// reach only a relay that missed the failover. The relay is no voter and has
// no newer commit, so no NACK comes back; its clock alone tells the holder it
// was frozen, and the copy stops at once instead of after the frozen budget.
func TestFreezeResumedHolderReachingOnlyAStaleRelayFencesAtOnce(t *testing.T) {
	w := hafoWorld(t)
	log := w.watchContainers()
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	w.runUntil(w.now + 6*time.Second)
	d1 := w.nodes["d1"]
	d1.stopDelay = 300 * time.Millisecond // a kill: the budget is gone
	// r2 goes away 10 s before the VM freezes and misses the failover.
	w.isolate("r2", true)
	w.runUntil(w.now + 10*time.Second)
	d1.freeze()
	w.waitHolderIs(t, keyP1, "d2", 90*time.Second)
	w.runUntil(w.now + 30*time.Second)
	// Only d1 <-> r2 comes back before the resume.
	w.isolate("d1", true)
	w.link("d1", "r2").up = true
	resumed := w.now
	d1.resume()
	var firstFromR2 time.Duration
	w.observers = append(w.observers, func() {
		if firstFromR2 == 0 && d1.node != nil {
			if pc := d1.node.peerClocks["r2"]; pc != nil && pc.lastAt >= d1.resumedLocal {
				firstFromR2 = w.now
			}
		}
	})
	w.runUntil(w.now + 5*time.Second)
	if firstFromR2 == 0 {
		t.Fatalf("no frame from r2 reached the resumed holder\n%s", w.dumpTrace(80))
	}
	died, ok := firstChange(*log, "d1", false, resumed)
	if !ok {
		t.Fatalf("resumed holder's copy never stopped\n%s", w.dumpTrace(80))
	}
	if died-firstFromR2 > 1500*time.Millisecond {
		t.Fatalf("copy stopped %s after the first frame from the stale relay, want about a second", died-firstFromR2)
	}
	if reasons := fenceReasons(w, "d1"); len(reasons) == 0 || reasons[len(reasons)-1] != FenceFrozen {
		t.Fatalf("fence reasons %v, want %q", reasons, FenceFrozen)
	}
	w.runUntil(w.now + 30*time.Second)
	w.requireClean(t)
	if copies := w.liveCopies(keyP1); len(copies) != 1 || copies[0] != "d2" {
		t.Fatalf("copies %v, want d2 only", copies)
	}
}

// A resumed holder that reaches nobody has no evidence: it fences on its own
// timer within the remaining budget. When the network returns, the freeze is
// detected but nothing it holds by then is fenced for it.
func TestFreezeResumedHolderReachingNobodyFencesOnItsTimer(t *testing.T) {
	w := hafoWorld(t)
	log := w.watchContainers()
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	w.runUntil(w.now + 6*time.Second)
	d1 := w.nodes["d1"]
	d1.stopDelay = 300 * time.Millisecond
	d1.freeze()
	w.waitHolderIs(t, keyP1, "d2", 90*time.Second)
	w.isolate("d1", true)
	// Nothing sent during the freeze waits in its buffers either.
	d1.frozenInbox = nil
	resumed := w.now
	d1.resume()
	w.runUntil(w.now + FenceCompleteAfter)
	died, ok := firstChange(*log, "d1", false, resumed)
	if !ok {
		t.Fatalf("isolated resumed holder kept its copy past its budget\n%s", w.dumpTrace(60))
	}
	if died-resumed > SoftFenceAfter+time.Second {
		t.Fatalf("isolated resumed holder stopped %s after the resume, past its soft fence", died-resumed)
	}
	if reasons := fenceReasons(w, "d1"); len(reasons) != 1 || reasons[0] != FenceTimer {
		t.Fatalf("fence reasons %v, want one %q", reasons, FenceTimer)
	}
	w.isolate("d1", false)
	w.runUntil(w.now + 20*time.Second)
	w.requireClean(t)
	if reasons := fenceReasons(w, "d1"); len(reasons) != 1 {
		t.Fatalf("the late freeze detection fenced again: %v", reasons)
	}
	if copies := w.liveCopies(keyP1); len(copies) != 1 || copies[0] != "d2" {
		t.Fatalf("copies %v, want d2 only", copies)
	}
}

// A freeze shorter than the acceptors' hold: nobody took over, the resumed
// holder fences on the first frame and, once its copy is confirmed dead,
// releases, so the successor starts at once instead of after the hold.
func TestFreezeShortFreezeFencesThenReleasesToTheSuccessor(t *testing.T) {
	w := hafoWorld(t)
	log := w.watchContainers()
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	w.runUntil(w.now + 6*time.Second)
	d1 := w.nodes["d1"]
	d1.stopDelay = 300 * time.Millisecond
	d1.freeze()
	w.runUntil(w.now + 12*time.Second)
	d1.resume()
	resumed := w.now
	w.runUntil(w.now + 10*time.Second)
	died, ok := firstChange(*log, "d1", false, resumed)
	if !ok || died-resumed > 2*time.Second {
		t.Fatalf("resumed holder did not stop within 2 s of the resume (died %v at %s)\n%s", ok, died-resumed, w.dumpTrace(80))
	}
	if released := w.eventsOf("d1", EventReleased); len(released) == 0 {
		t.Fatalf("no release after the confirmed fence\n%s", w.dumpTrace(80))
	}
	started, ok := firstChange(*log, "d2", true, died)
	if !ok {
		w.runUntil(w.now + 20*time.Second)
		started, ok = firstChange(*log, "d2", true, died)
	}
	if !ok || started-died > 6*time.Second {
		t.Fatalf("successor started %s after the released copy died (ok %v), want a prompt takeover\n%s", started-died, ok, w.dumpTrace(80))
	}
	w.requireClean(t)
}

// B-9: a fence the daemon confirmed (watchdog lost, kill done) releases the
// key: the successor takes over at once. Nothing is released before
// FenceComplete.
func TestFenceCompleteReleasesAndNothingBefore(t *testing.T) {
	w := hafoWorld(t)
	log := w.watchContainers()
	w.startAll()
	w.waitHolderIs(t, keyP1, "d1", 60*time.Second)
	w.runUntil(w.now + 6*time.Second)
	d1 := w.nodes["d1"]
	// The daemon stops renewing (watchdog lost) but its kill hangs.
	d1.node.AbandonFor(keyP1, FenceWatchdogLost)
	c := d1.containers[keyP1]
	c.stopping = true // the model's reconcile must not stop it on its own
	w.runUntil(w.now + 10*time.Second)
	if released := w.eventsOf("d1", EventReleased); len(released) != 0 {
		t.Fatalf("released before the stop was confirmed: %+v", released)
	}
	// The kill completes and is confirmed.
	c.live, c.stopping = false, false
	killed := w.now
	d1.node.FenceComplete(keyP1)
	d1.after()
	w.runUntil(w.now + 10*time.Second)
	if released := w.eventsOf("d1", EventReleased); len(released) != 1 {
		t.Fatalf("want one release after the confirmed kill, have %+v", released)
	}
	started, ok := firstChange(*log, "d2", true, killed)
	if !ok || started-killed > 6*time.Second {
		t.Fatalf("successor started %s after the confirmed kill (ok %v)\n%s", started-killed, ok, w.dumpTrace(80))
	}
	if reasons := fenceReasons(w, "d1"); len(reasons) == 0 || reasons[0] != FenceWatchdogLost {
		t.Fatalf("fence reasons %v, want %q", reasons, FenceWatchdogLost)
	}
	w.requireClean(t)
}
