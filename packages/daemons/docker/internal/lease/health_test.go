package lease

import (
	"testing"
	"time"
)

func TestClassifyHealthPortsBackendSeverity(t *testing.T) {
	running := Container{ID: "a", Name: "a", Running: true, Status: "running"}
	cases := []struct {
		name     string
		serve    []Container
		expected map[string]bool
		previous map[string]int
		want     string
		starting bool
	}{
		{name: "healthy", serve: []Container{running}},
		{name: "no containers", want: issueMissing},
		{name: "vanished", serve: []Container{running}, expected: map[string]bool{"a": true, "b": true}, want: issueMissing},
		{name: "exited", serve: []Container{{ID: "a", Status: "exited", ExitCode: 1}}, want: issueStopped},
		{name: "paused", serve: []Container{{ID: "a", Running: true, Paused: true}}, want: issueStopped},
		{name: "restarting", serve: []Container{{ID: "a", Restarting: true}}, want: issueRestarting},
		{name: "restart loop", serve: []Container{{ID: "a", Running: true, RestartCount: 3}}, previous: map[string]int{"a": 2}, want: issueRestarting},
		{name: "unhealthy", serve: []Container{{ID: "a", Running: true, Health: "unhealthy"}}, want: issueUnhealthy},
		{name: "starting", serve: []Container{{ID: "a", Running: true, Health: "starting"}}, starting: true},
		{name: "worst wins", serve: []Container{{ID: "a", Running: true, Health: "unhealthy"}, {ID: "b", Status: "exited"}}, want: issueStopped},
	}
	for _, tc := range cases {
		issue, _, starting, _ := classifyHealth(tc.serve, tc.expected, tc.previous)
		if issue != tc.want || starting != tc.starting {
			t.Errorf("%s: issue %q starting %v, want %q %v", tc.name, issue, starting, tc.want, tc.starting)
		}
	}
}

func TestHealthReleaseNeedsTwoBadSamplesInARow(t *testing.T) {
	w := twoCandidateWorld(t)
	w.waitServing("d1", 45*time.Second)
	d1 := w.daemon("d1")
	w.run(6 * time.Second)
	var holderContainer *Container
	for _, c := range d1.engine.containers {
		holderContainer = c
	}
	// One bad sample, then healthy again: no release.
	holderContainer.Health = "unhealthy"
	w.run(5 * time.Second)
	holderContainer.Health = "healthy"
	w.run(10 * time.Second)
	if w.holderOf() != "d1" || !d1.engine.running() {
		t.Fatalf("a single bad sample must not release\n%s", w.dump())
	}
	// Two bad samples in a row (5 s apart): release and fail over.
	holderContainer.Running = false
	crashed := w.clock.now
	w.waitServing("d2", 30*time.Second)
	w.requireClean()
	if took := w.clock.now - crashed; took < 5*time.Second {
		t.Fatalf("released after %s, before the second sample", took)
	}
	released := false
	for _, event := range d1.runtime.Report().Events {
		if event.Kind == "released" {
			released = true
		}
	}
	if !released {
		t.Fatal("health release must publish a release")
	}
	// The released node stays out for the cooldown even though its own
	// leftover lease would count as free for it.
	w.run(20 * time.Second)
	if d1.engine.running() {
		t.Fatal("unhealthy node re-acquired during its cooldown")
	}
}
