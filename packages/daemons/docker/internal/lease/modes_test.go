package lease

import (
	"testing"
	"time"
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
