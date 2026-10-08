package lifecycle

// Service restart for launchers that predate self-update.
//
// A launcher process started before launchers updated themselves in place
// (launcher_selfupdate.go) runs the launcher code it started with until its
// service restarts. A daemon under such a launcher performs its next update as
// one restart of the whole service instead of a restart under the launcher:
// the start that follows runs the refreshed launcher together with the
// updated daemon, and later updates go through that launcher. The update cuts
// the daemon's connections as every update does under the old launcher.
//
// The daemon asks the service manager for the restart only when it is safe:
//
//   - systemd, unit whose main process is the launcher: as root, `systemctl
//     restart --no-block`. Otherwise the daemon stops the launcher (SIGTERM),
//     which exits cleanly, and only a unit with Restart=always starts again
//     after a clean exit.
//   - OpenRC: supervise-daemon starts the launcher again whatever it exited
//     with, so the daemon stops the launcher (SIGTERM).
//   - manual mode: nothing would start the launcher again, so the update runs
//     under the running launcher as before.
//
// The update journal carries ServiceRestart so the start after the restart
// may try the staged launcher with the pending update; the update result says
// how the update restarts the daemon.

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sync/atomic"
	"syscall"
	"time"
)

const (
	launcherRestartSystemctl = "systemctl"
	launcherRestartSignal    = "signal"
)

var (
	// launcherServiceRestartWait bounds the wait for the service manager to
	// stop this daemon after the restart was requested; the daemon then exits
	// for the update as before.
	launcherServiceRestartWait = 20 * time.Second

	serviceRestartPending atomic.Bool
)

// ServiceRestartPending reports whether the restart this daemon prepares for
// an update restarts its whole service: its launcher stops too, so nothing the
// launcher keeps reaches the next daemon process.
func ServiceRestartPending() bool {
	return serviceRestartPending.Load()
}

// launcherServiceRestart is how a staged update restarts the daemon when its
// launcher lacks a feature. method is empty when the update stays under the
// running launcher; detail says why for the update result.
type launcherServiceRestart struct {
	stateDir    string
	launcherPID int
	manager     launcherServiceManager
	method      string
	detail      string
}

// planLauncherServiceRestart decides how a staged update restarts this daemon.
// It returns nil when the launcher updates itself (every such launcher has the
// keeper too, unless the keeper failed to open) and restarts the daemon as
// always.
func planLauncherServiceRestart(stateDir, binaryPath string, launcher LauncherInfo, launcherPID, euid int) *launcherServiceRestart {
	if !launcher.Managed || launcher.Has(LauncherFeatureSelfUpdate) {
		return nil
	}
	plan := &launcherServiceRestart{stateDir: stateDir, launcherPID: launcherPID}
	stays := func(reason string) *launcherServiceRestart {
		plan.detail = "The running launcher predates launcher self-update and stays until the service restarts: " + reason + "."
		return plan
	}
	if owner, err := readLauncherOwner(stateDir); err != nil || owner.PID != plan.launcherPID {
		return stays("its process could not be identified")
	}
	// The start after the restart runs the new binary's bootstrap, which must
	// know the journal's ServiceRestart, and the launcher it selects.
	if probe, err := probeLauncherFeatures(binaryPath); err != nil || !probe.has(LauncherFeatureSelfUpdate) {
		return stays("the new daemon version predates launcher self-update")
	}
	if probe, err := probeLauncherFeatures(launcherForNextStart(stateDir, binaryPath)); err != nil ||
		!probe.has(LauncherFeatureSelfUpdate) || !probe.has(LauncherFeatureListenerKeep) {
		return stays("no newer launcher is staged yet")
	}
	plan.manager = launcherServiceManagerOf(plan.launcherPID)
	switch plan.manager.kind {
	case launcherManagerSystemd:
		if euid == 0 {
			plan.method = launcherRestartSystemctl
		} else if plan.manager.restart == "always" {
			plan.method = launcherRestartSignal
		} else {
			return stays(fmt.Sprintf("its systemd unit %s does not start again after a clean stop (Restart=%s)", plan.manager.unit, plan.manager.restart))
		}
	case launcherManagerOpenRC:
		plan.method = launcherRestartSignal
	default:
		return stays("in manual mode nothing would start it again")
	}
	plan.detail = "The running launcher predates launcher self-update: this update restarts the whole service once, so the refreshed launcher starts with it."
	return plan
}

// launcherForNextStart is the launcher the next start of the service selects:
// a staged launcher on trial with attempts left, else the installed copy.
func launcherForNextStart(stateDir, binaryPath string) string {
	launcherPath := canonicalLauncherPath(stateDir, binaryPath)
	state, err := readLauncherRefreshState(stateDir)
	if err != nil || !launcherSelfUpdateTrialDue(state, launcherPath, nil) {
		return launcherPath
	}
	next := stagedLauncherPath(launcherPath)
	if sum, err := executableChecksum(next); err != nil || sum != state.TargetSHA256 {
		return launcherPath
	}
	return next
}

// planUpdateRestart plans the restart for the update this daemon just staged.
func planUpdateRestart() *launcherServiceRestart {
	executable, err := currentExecutable()
	if err != nil {
		return nil
	}
	// The launcher started this daemon: it is the parent process.
	plan := planLauncherServiceRestart(launcherStateDirFromEnvironment(executable), executable, LauncherFeatures(), os.Getppid(), os.Geteuid())
	serviceRestartPending.Store(plan != nil && plan.method != "")
	return plan
}

// run restarts the whole service: it marks the update journal, asks the
// service manager, and waits until the service manager (directly, or through
// the stopping launcher) stops this daemon. Without a method it does nothing,
// and on any failure the daemon exits for the update under its launcher as
// before.
func (r *launcherServiceRestart) run(logger *slog.Logger) {
	if r == nil || r.method == "" {
		return
	}
	if err := markLauncherUpdateServiceRestart(r.stateDir, true); err != nil {
		serviceRestartPending.Store(false)
		logger.Warn("the update restarts the daemon under the running launcher: the update journal could not be marked for a service restart", "error", err)
		return
	}
	stopped := make(chan os.Signal, 1)
	signal.Notify(stopped, syscall.SIGTERM)
	defer signal.Stop(stopped)
	if err := r.request(); err != nil {
		serviceRestartPending.Store(false)
		_ = markLauncherUpdateServiceRestart(r.stateDir, false)
		logger.Warn("the update restarts the daemon under the running launcher: the service restart could not be requested", "error", err, "service_manager", r.manager.String())
		return
	}
	logger.Info("restarting the whole service for the update so the refreshed launcher starts", "service_manager", r.manager.String())
	select {
	case <-stopped:
	case <-time.After(launcherServiceRestartWait):
		logger.Warn("the service manager did not stop the daemon in time; exiting for the update", "service_manager", r.manager.String())
	}
}

func (r *launcherServiceRestart) request() error {
	if r.method == launcherRestartSystemctl {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		output, err := exec.CommandContext(ctx, "systemctl", "restart", "--no-block", r.manager.unit).CombinedOutput()
		if err == nil {
			return nil
		}
		if r.manager.restart != "always" {
			return fmt.Errorf("systemctl restart: %w: %s", err, output)
		}
		// The unit starts again after the launcher's clean exit.
	}
	return syscall.Kill(r.launcherPID, syscall.SIGTERM)
}

func markLauncherUpdateServiceRestart(stateDir string, restart bool) error {
	state, err := readLauncherUpdateState(stateDir)
	if err != nil {
		return err
	}
	if state == nil {
		return fmt.Errorf("no update is pending in %s", filepath.Join(stateDir, "launcher"))
	}
	state.ServiceRestart = restart
	return writeLauncherUpdateState(stateDir, state)
}
