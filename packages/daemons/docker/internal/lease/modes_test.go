package lease

import (
	"fmt"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
)

func TestStandbyStartedBehindTheDaemonsBackIsFenced(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	// d2's daemon is rolled back to a pre-lease version (or gone) and
	// something starts its standby: the always-stale record kills it
	// without the daemon (A12, stand m).
	d2 := w.daemon("d2")
	d2.daemonOff = true
	for _, c := range d2.engine.containers {
		c.Running = true
	}
	w.runWatchdogs()
	if d2.engine.running() || w.indexOf("d2 watchdog killed") < 0 {
		t.Fatalf("a standby started without the lease must be killed by the watchdog\n%s", w.dump())
	}
}

func TestHolderDaemonDeathIsFencedByWatchdogBeforeSuccessor(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	// The holder's daemon dies or is rolled back; its container keeps
	// running until the watchdog enforces the last recorded deadline.
	w.daemon("d1").daemonOff = true
	w.waitServing("d2", 60*time.Second)
	w.requireClean()
	killed := w.indexOf("d1 watchdog killed")
	if killed < 0 || killed > w.lastIndexOf("d2 docker start") {
		t.Fatalf("the watchdog must fence the orphaned holder before the successor starts\n%s", w.dump())
	}
}

func TestAvailableModeHolderIsNotTimerFencedAndConverges(t *testing.T) {
	w := newWorld(t, worldSpec{relays: []string{"r1", "r2", "r3"}, daemons: []string{"d1", "d2"}, candidates: []string{"d1", "d2"}, available: true})
	w.daemon("d1").addContainer(testPolicy, false)
	w.daemon("d2").addContainer(testPolicy, false)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	d1.cut = true
	w.run(40 * time.Second)
	if !d1.engine.running() {
		t.Fatalf("available mode never fences on unreachable acceptors alone (A7)\n%s", w.dump())
	}
	d1.cut = false
	w.run(60 * time.Second)
	running := 0
	for _, h := range w.daemons {
		if h.engine.running() {
			running++
		}
	}
	if running != 1 {
		t.Fatalf("available mode must converge to one copy after the partition heals, have %d\n%s", running, w.dump())
	}
}

func TestRemovedSlotHolderStopsThenReleases(t *testing.T) {
	w := newWorld(t, worldSpec{relays: []string{"r1", "r2", "r3"}, daemons: []string{"d1", "d2", "d3"}, candidates: []string{"d1", "d2", "d3"}, slots: 2})
	for _, id := range []string{"d1", "d2", "d3"} {
		w.daemon(id).addContainer(testPolicy, false)
	}
	holders := func() []string {
		var out []string
		for _, h := range w.daemons {
			for _, status := range h.runtime.Node().Holders() {
				if status.Role == availabilitylease.RoleHolding && h.engine.running() {
					out = append(out, fmt.Sprintf("%s/%d", h.id, status.Key.Slot))
				}
			}
		}
		return out
	}
	if !w.runUntil(60*time.Second, func() bool { return len(holders()) == 2 }) {
		t.Fatalf("two slots were not served: %v\n%s", holders(), w.dump())
	}
	w.run(5 * time.Second)
	var slotOne *daemonHost
	for _, h := range w.daemons {
		if h.runtime.Node().HolderStatus(availabilitylease.Key{PolicyID: testPolicy, Slot: 1}).Role == availabilitylease.RoleHolding {
			slotOne = h
		}
	}
	w.setSlots(1)
	if !w.runUntil(10*time.Second, func() bool { return !slotOne.engine.running() && len(holders()) == 1 }) {
		t.Fatalf("the removed slot's holder kept running\n%s", w.dump())
	}
	w.run(3 * time.Second)
	w.requireClean()
	deregistered := w.lastIndexOf(slotOne.id + " endpoints serving=false")
	stopped := w.lastIndexOf(slotOne.id + " docker stop")
	empty := w.lastIndexOf(slotOne.id + " cgroup empty")
	marked := w.lastIndexOf(slotOne.id + " placement serving=false")
	if !(deregistered >= 0 && deregistered < stopped && stopped < empty && empty < marked) {
		t.Fatalf("scale-down order must be deregister < stop < cgroup empty < mark stopped\n%s", w.dump())
	}
	released := false
	for _, event := range slotOne.runtime.Report().Events {
		released = released || (event.Kind == "released" && event.Key.Slot == 1)
	}
	if !released {
		t.Fatal("the removed slot must be released, not left to its renewal timer")
	}
	if slotOne.runtime.Node().HolderStatus(availabilitylease.Key{PolicyID: testPolicy, Slot: 1}).Role == availabilitylease.RoleHolding {
		t.Fatal("the removed slot is still held")
	}
}
