package lifecycle

// Service restart right after an update that carried no connection.
//
// A daemon that updates under a launcher that predates launcher self-update
// restarts its whole service on its next update (launcher_service_restart.go).
// When the update that started it could not hand its connections over (the
// previous daemon predates daemon_stream_handover_v1: the update already cut
// every connection, stand upgrade run rc.10 F-3), waiting for the next update
// would cut them a second time. Such a daemon restarts the whole service once,
// right after the update committed and its own launcher is staged: the
// customer's update has one disruption window, and the next update is handed
// over by the refreshed launcher. The restart is reported as the same update's
// cut (UpdateReportFromVersion), and a flag in the launcher state directory
// keeps it to one per version.

import (
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"
)

var (
	// previousUpdateReport is what this process found of its previous
	// process's update report: 0 nobody looked (the daemon keeps no
	// connections), 1 it found one, 2 it found none.
	previousUpdateReport atomic.Int32
	// afterUpdateFrom is the version the update came from while this process
	// restarts the service right after it ("" otherwise).
	afterUpdateFrom atomic.Value
	// afterUpdateRestarts takes the restart to the control session loop.
	afterUpdateRestarts = make(chan *launcherServiceRestart, 1)
)

// NotePreviousUpdateReport records whether the previous daemon process left a
// report of what its update did to the connections (handover.NewTracker).
// Every daemon that hands connections over writes one when it exits for an
// update; one that predates the handover writes none.
func NotePreviousUpdateReport(found bool) {
	if found {
		previousUpdateReport.Store(1)
	} else {
		previousUpdateReport.Store(2)
	}
}

// UpdateReportFromVersion is the version an update report names as the one
// updated from: this daemon's version, or, while it restarts the service
// right after its own update, the version that update came from (the restart
// belongs to it).
func UpdateReportFromVersion() string {
	if from, _ := afterUpdateFrom.Load().(string); from != "" {
		return from
	}
	return Version
}

// afterUpdateRestartFile marks the version that restarted its service right
// after its update: never twice for one version.
func afterUpdateRestartFile(stateDir string) string {
	return filepath.Join(stateDir, "launcher", "after-update-restart.json")
}

type afterUpdateRestartMark struct {
	TargetVersion string    `json:"targetVersion"`
	FromVersion   string    `json:"fromVersion"`
	At            time.Time `json:"at"`
}

// planAfterUpdateRestart decides, once the update that started this process
// (from fromVersion; "" when this start was no update) committed and its
// launcher refresh was staged, whether the daemon restarts its whole service
// now. It returns nil when it does not.
func planAfterUpdateRestart(stateDir, executable, version, fromVersion string, launcher LauncherInfo, launcherPID, euid int, logger *slog.Logger) *launcherServiceRestart {
	if fromVersion == "" || fromVersion == version || previousUpdateReport.Load() != 2 {
		// No update, or the previous daemon handed over (or keeps no
		// connections): the next update restarts the service if needed.
		return nil
	}
	plan := planLauncherServiceRestart(stateDir, executable, launcher, launcherPID, euid)
	if plan == nil || plan.method == "" {
		return nil
	}
	path := afterUpdateRestartFile(stateDir)
	var mark afterUpdateRestartMark
	if err := readJSONFile(path, &mark); err == nil && mark.TargetVersion == version {
		return nil
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		logger.Info("the service is not restarted after the update: its restart mark could not be read", "error", err)
		return nil
	}
	if err := writeJSONFileAtomic(path, &afterUpdateRestartMark{TargetVersion: version, FromVersion: fromVersion, At: time.Now().UTC()}, 0o600); err != nil {
		logger.Info("the service is not restarted after the update: its restart mark could not be written", "error", err)
		return nil
	}
	plan.afterUpdate = true
	plan.detail = "The update from " + fromVersion + " could not keep connections; the whole service restarts once now so the launcher of this version starts and the next update keeps them."
	return plan
}

// requestAfterUpdateRestart hands the restart to the control session loop.
func requestAfterUpdateRestart(plan *launcherServiceRestart, fromVersion string, logger *slog.Logger) {
	afterUpdateFrom.Store(fromVersion)
	serviceRestartPending.Store(true)
	logger.Info(plan.detail, "from_version", fromVersion, "version", Version)
	select {
	case afterUpdateRestarts <- plan:
	default:
	}
}

func readJSONFile(path string, value any) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, value)
}
