package lifecycle

import (
	"log/slog"
	"strings"
	"testing"
)

// A daemon that an update started under a launcher that predates self-update,
// after a previous daemon that could not hand its connections over (stand
// upgrade run rc.10 F-3: 2.11.3 -> 2.11.4), restarts the whole service once
// right away, so the next update is handed over; never twice for one version,
// and not when the previous daemon handed over or this start was no update.
func TestServiceRestartsOnceRightAfterAnUpdateThatCarriedNothing(t *testing.T) {
	keeperOnly := LauncherInfo{Managed: true, Features: []string{LauncherFeatureListenerKeep}}
	useServiceManager(t, launcherServiceManager{kind: launcherManagerSystemd, unit: "docker-daemon.service", restart: "always"})
	logger := slog.New(slog.DiscardHandler)
	previous := previousUpdateReport.Load()
	t.Cleanup(func() {
		previousUpdateReport.Store(previous)
		afterUpdateFrom.Store("")
		serviceRestartPending.Store(false)
	})

	f := newServiceRestartFixture(t)
	f.stageNext(t, launcherBinaryFeatures)
	NotePreviousUpdateReport(false)
	plan := planAfterUpdateRestart(f.stateDir, f.binary, "v2", "v1", keeperOnly, f.launcherPID, 0, logger)
	if plan == nil || plan.method != launcherRestartSystemctl || !plan.afterUpdate || !strings.Contains(plan.detail, "from v1") {
		t.Fatalf("plan = %+v", plan)
	}
	if again := planAfterUpdateRestart(f.stateDir, f.binary, "v2", "v1", keeperOnly, f.launcherPID, 0, logger); again != nil {
		t.Fatalf("restarted twice for one version: %+v", again)
	}
	requestAfterUpdateRestart(plan, "v1", logger)
	if from := UpdateReportFromVersion(); from != "v1" || !ServiceRestartPending() {
		t.Fatalf("report names %q, pending %v", from, ServiceRestartPending())
	}
	if queued := <-afterUpdateRestarts; queued != plan {
		t.Fatal("the restart did not reach the session loop")
	}

	for _, test := range []struct {
		name     string
		found    bool
		from     string
		launcher LauncherInfo
		staged   []string
	}{
		{name: "previous daemon handed over", found: true, from: "v1", launcher: keeperOnly, staged: launcherBinaryFeatures},
		{name: "no update", from: "", launcher: keeperOnly, staged: launcherBinaryFeatures},
		{name: "launcher that updates itself", from: "v1", launcher: LauncherInfo{Managed: true, Version: "v1", Features: launcherBinaryFeatures}, staged: launcherBinaryFeatures},
		{name: "no newer launcher staged", from: "v1", launcher: keeperOnly},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newServiceRestartFixture(t)
			if test.staged != nil {
				f.stageNext(t, test.staged)
			}
			NotePreviousUpdateReport(test.found)
			if plan := planAfterUpdateRestart(f.stateDir, f.binary, "v2", test.from, test.launcher, f.launcherPID, 0, logger); plan != nil {
				t.Fatalf("plan = %+v", plan)
			}
		})
	}
}
