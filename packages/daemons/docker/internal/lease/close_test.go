package lease

import (
	"crypto/ed25519"
	"strings"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
)

// requireUninterrupted fails when id's copy stops or its endpoints are told to
// stop serving (dormant, tunnels cut) from now on.
func requireUninterrupted(t *testing.T, w *world, id string) func() {
	t.Helper()
	h := w.daemon(id)
	stops, from := h.endpoints.stops, len(w.log)
	return func() {
		t.Helper()
		for _, line := range w.log[from:] {
			if strings.Contains(line, id+" docker stop") || strings.Contains(line, id+" docker kill") || strings.Contains(line, id+" watchdog killed") {
				t.Fatalf("%s's copy was stopped: %s\n%s", id, line, w.dump())
			}
		}
		if h.endpoints.stops != stops {
			t.Fatalf("%s's endpoints were taken out of service %d times\n%s", id, h.endpoints.stops-stops, w.dump())
		}
		if !h.engine.running() {
			t.Fatalf("%s's copy is not running\n%s", id, w.dump())
		}
	}
}

// Graceful close: the holder keeps its copy and its endpoints, the voters
// confirm, the watchdog deadline of exactly that copy is removed, and the
// lease report says retained.
func TestGracefulCloseKeepsTheCopyAndDisarmsItsWatchdog(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	w.run(3 * time.Second)
	d1, d2 := w.daemon("d1"), w.daemon("d2")
	check := requireUninterrupted(t, w, "d1")
	w.closeGracefully()
	if !w.runUntil(5*time.Second, func() bool { return len(d1.fence.records) == 0 }) {
		t.Fatalf("the retained copy's watchdog record is still armed: %v\n%s", d1.fence.records, w.dump())
	}
	if len(d2.fence.records) == 0 {
		t.Fatal("the standby's always-stale record must stay: only the retained copy is disarmed")
	}
	w.run(3 * time.Minute)
	w.requireClean()
	check()
	report := d1.runtime.Report()
	if len(report.Held) != 1 || !report.Held[0].Retained || report.Held[0].Role != "retained" {
		t.Fatalf("lease report held %+v, want the slot retained", report.Held)
	}
	sawRetained := false
	for _, event := range report.Events {
		sawRetained = sawRetained || event.Kind == string(availabilitylease.EventRetained)
		if event.Kind == string(availabilitylease.EventFence) {
			t.Fatalf("fence event on a graceful close: %+v", event)
		}
	}
	if !sawRetained {
		t.Fatalf("no retained event: %+v", report.Events)
	}
	if d2.engine.running() || w.indexOf("d2 docker start") >= 0 {
		t.Fatal("the standby started after the close")
	}
	// The docker plugin's endpoint gate admits every registration of a policy
	// that is not in lease mode (a closed one): the retained copy's endpoints
	// stay registered.
	if d1.runtime.LeaseMode(testPolicy) || !d1.endpoints.serving[testPolicy] {
		t.Fatal("the retained copy's endpoints would be refused after the close")
	}
	// B-20: legacy owns the retained copy now. Its commands for it (the disable
	// adopting it as the standalone workload, a stop or restart) pass the gate
	// instead of waiting for a release that never comes.
	if err := d1.runtime.CheckServe(testPolicy); err != nil {
		t.Fatalf("a legacy command for the retained copy is refused: %v", err)
	}
	for id, c := range d1.engine.containers {
		if !c.Running {
			continue
		}
		if err := d1.runtime.BeforeStart(id, testPolicy, ""); err != nil {
			t.Fatalf("a legacy start of the retained copy is refused: %v", err)
		}
	}
	check()
}

// A holder the closed manifest does not name fences at once.
func TestGracefulCloseNamingAnotherNodeFencesTheHolder(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	w.retained = map[uint32]availabilitylease.RetainedHolder{0: {Holder: "d2"}}
	w.closed = true
	w.publishManifest()
	if !w.runUntil(5*time.Second, func() bool { return !w.daemon("d1").engine.running() }) {
		t.Fatalf("unnamed holder kept its copy\n%s", w.dump())
	}
	w.run(time.Minute)
	w.requireClean()
	if w.daemon("d2").engine.running() {
		t.Fatal("the named node without a copy started one")
	}
}

// A holder cut off from the voters when the lease closes cannot be
// confirmed: it fences at its renewal timeout and releases, like any holder.
func TestGracefulClosePartitionedHolderFencesAtItsTimeout(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	w.closeGracefully()
	// Closed manifest reaches d1 over the Gateway, the voters do not answer.
	d1.cut = true
	w.deliverBlocks(d1)
	start := w.clock.now
	if !w.runUntil(availabilitylease.FenceCompleteAfter+time.Second, func() bool { return !d1.engine.running() }) {
		t.Fatalf("partitioned holder kept its copy past its budget\n%s", w.dump())
	}
	if took := w.clock.now - start; took > availabilitylease.SoftFenceAfter+2*time.Second {
		t.Fatalf("partitioned holder stopped %s after the close", took)
	}
	if len(w.fenceLog("d1")) == 0 || w.fenceLog("d1")[0] != string(availabilitylease.FenceClosed) {
		t.Fatalf("fence reasons %v", w.fenceLog("d1"))
	}
	for _, held := range d1.runtime.Report().Held {
		if held.Retained {
			t.Fatal("partitioned holder reported retained")
		}
	}
	w.requireClean()
}

// A daemon restart after the copy was retained: nothing kills it, and the
// voters confirm it again for the lease report.
func TestRetainedCopySurvivesADaemonRestart(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	w.closeGracefully()
	w.runUntil(5*time.Second, func() bool { return len(d1.fence.records) == 0 })
	check := requireUninterrupted(t, w, "d1")
	restartDaemon(w, d1, 5*time.Second)
	w.run(time.Minute)
	w.requireClean()
	check()
	if held := d1.runtime.Report().Held; len(held) != 1 || !held[0].Retained {
		t.Fatalf("restarted daemon does not report the retained copy: %+v", held)
	}
}

// B-12a: entering lease mode again (after a close of either kind) never stops
// the named holders' running copies or takes their endpoints out of service:
// they acquire as bootstrap holders while the copies keep running.
func TestReentryKeepsTheServingCopies(t *testing.T) {
	for _, graceful := range []bool{true, false} {
		name := "after a graceful close"
		if !graceful {
			name = "after a close that stopped the copy and a legacy restart"
		}
		t.Run(name, func(t *testing.T) {
			w := twoCandidateWorld(t)
			w.waitServing("d1", 45*time.Second)
			d1 := w.daemon("d1")
			if graceful {
				w.closeGracefully()
				w.runUntil(5*time.Second, func() bool { return len(d1.fence.records) == 0 })
			} else {
				w.closeLease()
				w.run(10 * time.Second)
				// Legacy starts the copy again (BeforeStart clears records).
				for id, c := range d1.engine.containers {
					c.Running = true
					delete(d1.fence.records, id)
				}
				w.logf("legacy restarted d1's copy")
			}
			w.run(time.Minute)
			check := requireUninterrupted(t, w, "d1")
			w.reopen(map[uint32]string{0: "d1"})
			w.waitServing("d1", 45*time.Second)
			w.run(time.Minute)
			w.requireClean()
			check()
			if w.holderOf() != "d1" {
				t.Fatalf("holder %q after re-entry", w.holderOf())
			}
		})
	}
}

// B-12a for a replicated policy: both slots' copies keep running across a
// graceful close and the re-entry, and every slot stays where it was.
func TestReplicatedCloseAndReentryKeepBothSlots(t *testing.T) {
	w := replicatedPair(t)
	before := waitTwoSlots(t, w)
	checks := []func(){requireUninterrupted(t, w, "d1"), requireUninterrupted(t, w, "d2")}
	w.closeGracefully()
	w.run(time.Minute)
	for _, id := range []string{"d1", "d2"} {
		if held := w.daemon(id).runtime.Report().Held; len(held) != 1 || !held[0].Retained {
			t.Fatalf("%s not retained: %+v", id, held)
		}
	}
	bootstrap := map[uint32]string{}
	for _, entry := range before {
		parts := strings.Split(entry, "/")
		bootstrap[map[string]uint32{"0": 0, "1": 1}[parts[1]]] = parts[0]
	}
	w.reopen(bootstrap)
	if !w.runUntil(60*time.Second, func() bool { return strings.Join(slotHolders(w), ",") == strings.Join(before, ",") }) {
		t.Fatalf("slots after re-entry %v, want %v\n%s", slotHolders(w), before, w.dump())
	}
	w.run(time.Minute)
	w.requireClean()
	for _, check := range checks {
		check()
	}
}

// A retained holder whose copy is not running (a start the close cut short)
// releases the slot instead of reporting a running copy.
func TestRetainedHolderWithoutARunningCopyReleases(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	for _, c := range d1.engine.containers {
		c.Running = false
	}
	w.closeGracefully()
	w.run(10 * time.Second)
	released := false
	for _, event := range d1.runtime.Report().Events {
		released = released || event.Kind == string(availabilitylease.EventReleased)
	}
	if !released {
		t.Fatalf("retained holder without a copy did not release\n%s", w.dump())
	}
	for _, held := range d1.runtime.Report().Held {
		if held.Retained {
			t.Fatal("still reported retained without a running copy")
		}
	}
}

// B-13: a same-boot daemon restart of the holder keeps its copy serving: the
// runtime recovers it on the live watchdog record and opens its endpoints at
// once, before the renewal, and never takes them out of service. A restart
// that outlasted the lease budget (stale records, as after a new boot, where
// records are gone) does not: that copy is killed and serves again only after
// it acquires anew.
func TestSameBootRestartKeepsTheHolderServing(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	w.run(3 * time.Second)
	d1 := w.daemon("d1")
	stops := d1.endpoints.stops
	d1.daemonOff = true
	w.run(5 * time.Second)
	// A fresh process knows nothing of the previous one's serving state.
	d1.endpoints.serving = map[string]bool{}
	w.startDaemon(d1)
	d1.daemonOff = false
	restarted := w.clock.now
	var servedAt time.Duration
	var servedWhile availabilitylease.Role
	for w.clock.now < restarted+10*time.Second {
		w.run(worldTick)
		if servedAt == 0 && d1.endpoints.serving[testPolicy] {
			servedAt = w.clock.now
			servedWhile = d1.runtime.Node().HolderStatus(availabilitylease.Key{PolicyID: testPolicy}).Role
		}
	}
	if servedAt == 0 || servedAt-restarted > time.Second || servedWhile != availabilitylease.RoleRecovering {
		t.Fatalf("recovered holder served at +%s as %s, want within a second while still recovering\n%s", servedAt-restarted, servedWhile, w.dump())
	}
	if d1.endpoints.stops != stops || w.lastIndexOf("d1 docker stop") > w.indexOf("d1 daemon started") && w.indexOf("d1 daemon started") >= 0 {
		t.Fatalf("the restart took the copy out of service\n%s", w.dump())
	}
	w.run(30 * time.Second)
	w.requireClean()
	if w.holderOf() != "d1" || !d1.engine.running() || !d1.endpoints.serving[testPolicy] {
		t.Fatalf("holder after the restart %q\n%s", w.holderOf(), w.dump())
	}
}

func TestRestartPastTheLeaseBudgetDoesNotServeTheOldCopy(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	w.watchdogOn = false // the stale copy is the daemon's to kill in this test
	d1.daemonOff = true
	w.run(availabilitylease.FenceCompleteAfter + 5*time.Second)
	d1.endpoints.serving = map[string]bool{}
	w.startDaemon(d1)
	d1.daemonOff = false
	from := len(w.log)
	for end := w.clock.now + 5*time.Second; w.clock.now < end; {
		w.run(worldTick)
		if d1.endpoints.serving[testPolicy] {
			// Only a copy started anew under a new lease may serve.
			stop, start := -1, -1
			for i, line := range w.log[from:] {
				if stop < 0 && strings.Contains(line, "d1 docker stop") {
					stop = i
				}
				if stop >= 0 && strings.Contains(line, "d1 docker start") {
					start = i
				}
			}
			if stop < 0 || start < 0 || !d1.runtime.Holds(testPolicy) {
				t.Fatalf("a copy whose lease lapsed served again without being restarted under a new lease\n%s", w.dump())
			}
		}
	}
	if w.indexOf("d1 docker stop") < 0 {
		t.Fatalf("the copy whose lease lapsed was not killed at the daemon start\n%s", w.dump())
	}
}

// Closing from bootstrapping (agent B): Gateway closes while the reserved
// bootstrap holder still runs its legacy copy. A holder that has not acquired
// yet was never lease-bound: the closed manifest leaves its copy, endpoints
// and watchdog alone, also after a daemon restart. A bootstrap holder whose
// commit raced the close is retained when Gateway names the reserved holder
// (with an empty ballot, it has seen no commit): its acceptors confirm it on
// the commit they hold, so the race does not stop the copy either.
func TestCloseFromBootstrappingKeepsTheLegacyCopy(t *testing.T) {
	bootstrapWorld := func(t *testing.T) *world {
		w := newWorld(t, worldSpec{relays: []string{"r1", "r2", "r3"}, daemons: []string{"d1", "d2"}, candidates: []string{"d1", "d2"}, bootstrap: "d2"})
		w.daemon("d1").addContainer(testPolicy, false)
		w.daemon("d2").addContainer(testPolicy, true)
		return w
	}
	requireLeftAlone := func(t *testing.T, w *world, d2 *daemonHost) {
		t.Helper()
		w.requireClean()
		if len(d2.fence.records) != 0 {
			t.Fatalf("the legacy copy got watchdog records: %v\n%s", d2.fence.records, w.dump())
		}
		if w.daemon("d1").engine.running() {
			t.Fatalf("another candidate started a copy after the close\n%s", w.dump())
		}
		for _, event := range d2.runtime.Report().Events {
			if event.Kind == string(availabilitylease.EventFence) {
				t.Fatalf("fence event for a copy that was never lease-bound: %+v", event)
			}
		}
	}
	t.Run("not acquired yet", func(t *testing.T) {
		w := bootstrapWorld(t)
		d2 := w.daemon("d2")
		d2.cut = true // the voters never hear its prepare
		w.run(40 * time.Second)
		if role := d2.runtime.Node().HolderStatus(availabilitylease.Key{PolicyID: testPolicy}).Role; role == availabilitylease.RoleHolding {
			t.Fatal("the cut-off bootstrap holder acquired")
		}
		check := requireUninterrupted(t, w, "d2")
		w.closeGracefully()
		if len(w.retained) != 0 {
			t.Fatalf("no holder committed, yet the close names %v", w.retained)
		}
		w.run(20 * time.Second)
		d2.cut = false
		w.run(2 * time.Minute)
		restartDaemon(w, d2, 5*time.Second)
		w.run(time.Minute)
		check()
		requireLeftAlone(t, w, d2)
	})
	t.Run("bootstrap commit raced the close", func(t *testing.T) {
		w := bootstrapWorld(t)
		d2 := w.daemon("d2")
		w.waitServing("d2", 45*time.Second)
		w.run(3 * time.Second)
		check := requireUninterrupted(t, w, "d2")
		// Gateway still saw bootstrapping: it names the reserved holder
		// without a ballot.
		w.retained = map[uint32]availabilitylease.RetainedHolder{0: {Holder: "d2"}}
		w.closeLease()
		if !w.runUntil(5*time.Second, func() bool { return len(d2.fence.records) == 0 }) {
			t.Fatalf("the raced bootstrap holder was not retained\n%s", w.dump())
		}
		w.run(2 * time.Minute)
		check()
		requireLeftAlone(t, w, d2)
		if held := d2.runtime.Report().Held; len(held) != 1 || !held[0].Retained {
			t.Fatalf("lease report held %+v, want the bootstrap holder retained", held)
		}
	})
}

// After closing -> legacy Gateway stops publishing the policy's manifest
// (agent B). The retained copy keeps running with its watchdog disarmed:
// nodes never forget an adopted manifest, so the policy stays closed on the
// daemon (and on the voters) across distributions without it and across a
// daemon restart.
func TestRetainedCopyOutlivesThePolicyLeavingTheDistribution(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1, d2 := w.daemon("d1"), w.daemon("d2")
	w.closeGracefully()
	if !w.runUntil(5*time.Second, func() bool { return len(d1.fence.records) == 0 }) {
		t.Fatalf("not retained\n%s", w.dump())
	}
	check := requireUninterrupted(t, w, "d1")
	withoutPolicy := func(h *daemonHost) {
		w.manifestV++
		err := h.runtime.ApplyLeaseBlocks(BlockUpdate{
			Revision: w.manifestV, MemberID: h.id,
			PolicyKeys: []PolicyKey{{ID: "k1", PublicKey: w.policyPriv.Public().(ed25519.PublicKey)}},
		})
		if err != nil {
			t.Fatalf("apply blocks on %s: %v", h.id, err)
		}
	}
	for range 3 {
		withoutPolicy(d1)
		withoutPolicy(d2)
		w.run(time.Minute)
	}
	restartDaemon(w, d1, 5*time.Second)
	withoutPolicy(d1)
	w.run(2 * time.Minute)
	check()
	w.requireClean()
	if len(d1.fence.records) != 0 {
		t.Fatalf("the retained copy's watchdog was armed again: %v", d1.fence.records)
	}
	if d1.runtime.LeaseMode(testPolicy) || !d1.endpoints.serving[testPolicy] {
		t.Fatal("the retained copy's endpoints would be refused without the manifest")
	}
	if held := d1.runtime.Report().Held; len(held) != 1 || !held[0].Retained {
		t.Fatalf("lease report held %+v, want the copy still retained", held)
	}
	if d2.engine.running() {
		t.Fatal("the standby started without the manifest")
	}
}
