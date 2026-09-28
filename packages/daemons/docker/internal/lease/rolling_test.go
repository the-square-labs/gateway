package lease

import (
	"fmt"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
)

// replicatedPair mirrors the rc.19 -> rc.20 upgrade run's ha-web: two
// replicas, the two candidate daemons plus a witness relay as voters.
func replicatedPair(t *testing.T) *world {
	t.Helper()
	w := newWorld(t, worldSpec{
		relays: []string{"r1"}, daemons: []string{"d1", "d2"}, candidates: []string{"d1", "d2"},
		voters: []string{"d1", "d2", "r1"}, slots: 2,
	})
	w.daemon("d1").addContainer(testPolicy, false)
	w.daemon("d2").addContainer(testPolicy, false)
	return w
}

// slotHolders lists "node/slot" for every held slot whose copy runs.
func slotHolders(w *world) []string {
	var out []string
	for _, h := range w.daemons {
		if h.down || h.daemonOff {
			continue
		}
		for _, status := range h.runtime.Node().Holders() {
			if status.Role == availabilitylease.RoleHolding && h.engine.running() {
				out = append(out, fmt.Sprintf("%s/%d", h.id, status.Key.Slot))
			}
		}
	}
	sort.Strings(out)
	return out
}

// restartDaemon stops a daemon process for downtime (the host, Docker, the
// watchdog and every container keep running) and starts it again on the same
// state: a binary swap by the updater.
func restartDaemon(w *world, h *daemonHost, downtime time.Duration) {
	h.daemonOff = true
	w.logf("%s daemon stopped", h.id)
	w.run(downtime)
	w.startDaemon(h)
	h.daemonOff = false
	w.logf("%s daemon started", h.id)
}

func waitTwoSlots(t *testing.T, w *world) []string {
	t.Helper()
	if !w.runUntil(90*time.Second, func() bool { return len(slotHolders(w)) == 2 }) {
		t.Fatalf("two slots were not served: %v\n%s", slotHolders(w), w.dump())
	}
	w.run(10 * time.Second)
	return slotHolders(w)
}

// Upgrade run rc.19 -> rc.20 (sora /root/rc20/next/runs/cand-rc19-to-rc20pre):
// the rolling update restarted d1, then d2 29 s later. Each restarted voter
// abstained for 33 s, so d1 lost its quorum while d2 restarted and fenced, and
// d2's own restart took so long that its recovery fenced at once (budget
// 8.7 s under the old 9 s graceful-stop reserve). A rolling daemon update must
// keep every slot where it is, without a stop.
func TestRollingDaemonUpdateKeepsEverySlot(t *testing.T) {
	w := replicatedPair(t)
	before := waitTwoSlots(t, w)
	for _, id := range []string{"d1", "d2"} {
		restartDaemon(w, w.daemon(id), 12*time.Second)
		w.run(15 * time.Second)
	}
	w.run(40 * time.Second)
	w.requireClean()
	if after := slotHolders(w); strings.Join(after, ",") != strings.Join(before, ",") {
		t.Fatalf("slots moved across a rolling update: %v -> %v\n%s", before, after, w.dump())
	}
	for _, id := range []string{"d1", "d2"} {
		if w.indexOf(id+" docker stop") >= 0 || w.indexOf(id+" docker kill") >= 0 || w.indexOf(id+" watchdog killed") >= 0 {
			t.Fatalf("%s stopped its copy during a rolling update\n%s", id, w.dump())
		}
		if fences := w.fenceLog(id); len(fences) != 0 {
			t.Fatalf("%s fenced during a rolling update: %v\n%s", id, fences, w.dump())
		}
	}
}

// A restart that takes most of the budget still recovers: the recovering
// holder renews until RecoverStopReserve before its recorded deadline.
func TestSlowDaemonRestartStillRecoversItsSlot(t *testing.T) {
	w := replicatedPair(t)
	before := waitTwoSlots(t, w)
	restartDaemon(w, w.daemon("d2"), 14*time.Second)
	w.run(30 * time.Second)
	w.requireClean()
	if after := slotHolders(w); strings.Join(after, ",") != strings.Join(before, ",") {
		t.Fatalf("a 14 s daemon restart lost the slot: %v -> %v\n%s", before, after, w.dump())
	}
	if w.indexOf("d2 docker stop") >= 0 {
		t.Fatalf("d2 stopped its copy\n%s", w.dump())
	}
}

// The first restart onto this build from an older one finds no boot stamp in
// the acceptor store and abstains (A3), but the holder still recovers its own
// slot with the other voters.
func TestUpgradeFromAStoreWithoutBootStampRecoversWithTheOtherVoters(t *testing.T) {
	w := replicatedPair(t)
	before := waitTwoSlots(t, w)
	d1 := w.daemon("d1")
	records, err := d1.store.Load()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := records["bootstamp"]; !ok {
		t.Fatal("this build writes no boot stamp")
	}
	if err := d1.store.Apply(nil, []string{"bootstamp"}); err != nil {
		t.Fatal(err)
	}
	restartDaemon(w, d1, 8*time.Second)
	w.run(2 * time.Second)
	if !d1.runtime.Node().Abstaining() {
		t.Fatal("a store an older build wrote must make the restarted voter abstain")
	}
	w.run(40 * time.Second)
	w.requireClean()
	if after := slotHolders(w); strings.Join(after, ",") != strings.Join(before, ",") {
		t.Fatalf("slots moved: %v -> %v\n%s", before, after, w.dump())
	}
}

// One slot per node: a node that holds (or recovers, fences, releases) one
// slot never acquires another, not even as the designated successor of a
// handoff; and a node takes back its own last slot before a foreign one.
func TestNoNodeHoldsTwoSlotsOfAPolicy(t *testing.T) {
	w := newWorld(t, worldSpec{
		relays: []string{"r1"}, daemons: []string{"d1", "d2", "d3"}, candidates: []string{"d1", "d2", "d3"},
		voters: []string{"d1", "d2", "r1"}, slots: 2,
	})
	for _, id := range []string{"d1", "d2", "d3"} {
		w.daemon(id).addContainer(testPolicy, false)
	}
	holders := waitTwoSlots(t, w)
	perNode := func() map[string]int {
		counts := map[string]int{}
		for _, h := range w.daemons {
			for _, status := range h.runtime.Node().Holders() {
				switch status.Role {
				case availabilitylease.RoleNone, availabilitylease.RoleCandidate:
				default:
					counts[h.id]++
				}
			}
		}
		return counts
	}
	check := func() {
		for id, count := range perNode() {
			if count > 1 {
				t.Fatalf("%s has %d slots in flight\n%s", id, count, w.dump())
			}
		}
	}
	// A handoff that names a node holding the other slot as successor.
	holder, other := strings.Split(holders[0], "/")[0], strings.Split(holders[1], "/")[0]
	slot := uint32(0)
	if strings.HasSuffix(holders[0], "/1") {
		slot = 1
	}
	if err := w.daemon(holder).runtime.Handoff(Handoff{PolicyID: testPolicy, Slot: slot, SuccessorID: other, OperationID: "op", ManifestVersion: w.manifestV}); err != nil {
		t.Fatal(err)
	}
	for end := w.clock.now + 40*time.Second; w.clock.now < end; {
		w.run(worldTick)
		check()
	}
	w.requireClean()
	if got := slotHolders(w); len(got) != 2 {
		t.Fatalf("slots after the handoff: %v\n%s", got, w.dump())
	}
}
