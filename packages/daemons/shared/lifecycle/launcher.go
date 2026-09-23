package lifecycle

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	LauncherProtocolVersion = 1
	LauncherCommand         = "launcher"
	LauncherProbeCommand    = "launcher-probe"
	LauncherManagedEnv      = "GATEWAY_DAEMON_LAUNCHER_MANAGED"
	LauncherReadyFDEnv      = "GATEWAY_DAEMON_LAUNCHER_READY_FD"
	LauncherOwnerFDEnv      = "GATEWAY_DAEMON_LAUNCHER_OWNER_FD"
	LauncherStateDirEnv     = "GATEWAY_DAEMON_LAUNCHER_STATE_DIR"
	LauncherUpdateExitCode  = 75
)

var (
	launcherLocalReadyLimit = 30 * time.Second
	// A candidate that announced it will report gateway control readiness
	// must receive its first gateway command within this window.
	launcherControlReadyLimit = 3 * time.Minute
	launcherStabilityWindow   = 30 * time.Second
	launcherStopGrace         = 15 * time.Second
	launcherRestartBackoff    = time.Second
	launcherRestartMax        = 5 * time.Second
	launcherStateRetry        = 5 * time.Second
)

type LauncherSpec struct {
	DaemonType string
	StateDir   string
	BinaryPath string
	ChildArgs  []string
}

type launcherOwner struct {
	PID             int       `json:"pid"`
	StartedAt       time.Time `json:"startedAt"`
	DaemonType      string    `json:"daemonType"`
	BinaryPath      string    `json:"binaryPath"`
	ProtocolVersion int       `json:"protocolVersion"`
}

type launcherReadinessEvent struct {
	Type    string `json:"type"`
	Version string `json:"version"`
	// AwaitControl on local_ready announces that this daemon will also send
	// control_ready once the gateway accepted it. Launchers that predate the
	// field ignore it and keep committing on local readiness alone.
	AwaitControl bool `json:"awaitControl,omitempty"`
}

const (
	launcherEventLocalReady   = "local_ready"
	launcherEventControlReady = "control_ready"
)

type launcherChildStatus struct {
	PID       int       `json:"pid"`
	Version   string    `json:"version,omitempty"`
	Ready     bool      `json:"ready"`
	UpdatedAt time.Time `json:"updatedAt"`
}

var (
	localReadyOnce   sync.Once
	controlReadyOnce sync.Once

	launcherReadyMu       sync.Mutex
	launcherReadyFile     *os.File
	launcherReadyOpened   bool
	launcherReadyVersion  string
	launcherAwaitsControl bool
)

func IsLauncherCommand(args []string) bool {
	return len(args) > 1 && args[1] == LauncherCommand
}

func IsLauncherProbeCommand(args []string) bool {
	return len(args) > 1 && args[1] == LauncherProbeCommand
}

func PrintLauncherProbe() {
	fmt.Printf("gateway-daemon-launcher %d\n", LauncherProtocolVersion)
}

// BootstrapLauncher replaces a direct daemon invocation with a stable launcher
// copy. If no safe copy can be created, it returns an error and the caller may
// continue running directly with rollback protection unavailable.
func BootstrapLauncher(spec LauncherSpec) error {
	if os.Getenv(LauncherManagedEnv) == "1" {
		// Keep ownership in this daemon if the launcher dies, but never leak the
		// lock into worker processes subsequently spawned by the daemon.
		if fd, err := strconv.Atoi(os.Getenv(LauncherOwnerFDEnv)); err == nil && fd >= 3 {
			syscall.CloseOnExec(fd)
		}
		return nil
	}
	if strings.TrimSpace(spec.DaemonType) == "" || strings.TrimSpace(spec.StateDir) == "" {
		return errors.New("launcher daemon type and state directory are required")
	}
	executable := spec.BinaryPath
	if executable == "" {
		var err error
		executable, err = os.Executable()
		if err != nil {
			return fmt.Errorf("resolve daemon executable: %w", err)
		}
	}
	executable, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return fmt.Errorf("resolve daemon executable symlink: %w", err)
	}
	if err := retireLegacyUpdateGuard(spec.DaemonType, executable); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: legacy update-guard cleanup incomplete: %v\n", err)
	}
	stateDir, launcherPath, err := ensureStableLauncher(spec.StateDir, spec.DaemonType, executable)
	if err != nil {
		return err
	}
	// A staged launcher refresh is tried here; the known-good copy is used
	// whenever the trial is not due, not valid, or an update is pending.
	launcherPath = selectLauncherForStart(stateDir, launcherPath)
	childArgs := spec.ChildArgs
	if len(childArgs) == 0 {
		childArgs = []string{"run"}
	}
	args := launcherCommandArgs(launcherPath, LauncherSpec{DaemonType: spec.DaemonType, StateDir: stateDir, BinaryPath: executable, ChildArgs: childArgs})
	environment := append(os.Environ(), LauncherStateDirEnv+"="+stateDir)
	return syscall.Exec(launcherPath, args, environment)
}

func RunLauncherCommand(args []string, logger *slog.Logger) error {
	spec, err := parseLauncherArgs(args)
	if err != nil {
		return err
	}
	if logger == nil {
		logger = slog.New(slog.NewJSONHandler(os.Stdout, nil))
	}
	return runLauncher(context.Background(), spec, logger)
}

func parseLauncherArgs(args []string) (LauncherSpec, error) {
	if !IsLauncherCommand(args) {
		return LauncherSpec{}, errors.New("launcher command is required")
	}
	var spec LauncherSpec
	index := 2
	for index < len(args) {
		if args[index] == "--" {
			spec.ChildArgs = append([]string(nil), args[index+1:]...)
			break
		}
		if index+1 >= len(args) {
			return LauncherSpec{}, fmt.Errorf("launcher flag %s requires a value", args[index])
		}
		switch args[index] {
		case "--daemon-type":
			spec.DaemonType = args[index+1]
		case "--state-dir":
			spec.StateDir = args[index+1]
		case "--binary":
			spec.BinaryPath = args[index+1]
		default:
			return LauncherSpec{}, fmt.Errorf("unknown launcher flag %s", args[index])
		}
		index += 2
	}
	if spec.DaemonType == "" || !filepath.IsAbs(spec.StateDir) || !filepath.IsAbs(spec.BinaryPath) {
		return LauncherSpec{}, errors.New("launcher requires daemon type and absolute state/binary paths")
	}
	if len(spec.ChildArgs) == 0 {
		spec.ChildArgs = []string{"run"}
	}
	return spec, nil
}

func runLauncher(ctx context.Context, spec LauncherSpec, logger *slog.Logger) error {
	launcherDir := filepath.Join(spec.StateDir, "launcher")
	if err := ensurePrivateLauncherDirectory(launcherDir); err != nil {
		return fmt.Errorf("create launcher state directory: %w", err)
	}
	signalCtx, stopSignals := signal.NotifyContext(ctx, syscall.SIGTERM, syscall.SIGINT)
	defer stopSignals()
	lock, err := acquireLauncherLock(signalCtx, filepath.Join(launcherDir, "owner.lock"))
	if err != nil {
		return err
	}
	defer releaseLauncherLock(lock)
	owner := launcherOwner{
		PID:             os.Getpid(),
		StartedAt:       time.Now().UTC(),
		DaemonType:      spec.DaemonType,
		BinaryPath:      spec.BinaryPath,
		ProtocolVersion: LauncherProtocolVersion,
	}
	if err := writeJSONFileAtomic(filepath.Join(launcherDir, "owner.json"), &owner, 0600); err != nil {
		return fmt.Errorf("write launcher owner metadata: %w", err)
	}
	defer os.Remove(filepath.Join(launcherDir, "owner.json"))

	// A staged launcher on trial replaces the installed copy once a child was
	// stable under it, and hands over to the installed copy if children keep
	// failing before that.
	trial := detectLauncherRefreshTrial(spec.StateDir)
	if trial != nil {
		logger.Info("running a staged launcher on trial", "launcher", trial.launcherPath)
	}
	promoteTrial := func() {
		if trial == nil {
			return
		}
		confirmed := trial
		trial = nil
		if err := promoteLauncherRefresh(spec.StateDir, confirmed); err != nil {
			logger.Error("staged launcher was stable but could not replace the installed launcher", "error", err)
			return
		}
		logger.Info("launcher refresh confirmed; replaced the installed launcher", "launcher", confirmed.launcherPath)
	}
	trialChildFailed := func() error {
		if trial == nil {
			return nil
		}
		trial.failures++
		if trial.failures < launcherRefreshChildFailureLimit {
			return nil
		}
		return fallBackFromLauncherTrial(spec, trial, logger)
	}

	backoff := launcherRestartBackoff
	for {
		if signalCtx.Err() != nil {
			return nil
		}
		state, err := prepareLauncherCandidate(spec)
		if err != nil {
			return err
		}
		child, events, done, err := startLauncherChild(spec, lock)
		if err != nil {
			if state != nil {
				if rollbackErr := rollbackLauncherUpdate(spec.StateDir, state, "candidate exec failed"); rollbackErr != nil {
					return fmt.Errorf("start candidate: %v; rollback: %w", err, rollbackErr)
				}
				logger.Error("candidate exec failed; restored previous daemon", "error", err, "target_version", state.TargetVersion)
				if trialErr := trialChildFailed(); trialErr != nil {
					return trialErr
				}
				continue
			}
			logger.Error("daemon child exec failed; retrying", "error", err)
			if trialErr := trialChildFailed(); trialErr != nil {
				return trialErr
			}
			select {
			case <-signalCtx.Done():
				return nil
			case <-time.After(backoff):
			}
			if backoff < launcherRestartMax {
				backoff *= 2
				if backoff > launcherRestartMax {
					backoff = launcherRestartMax
				}
			}
			continue
		}
		childStatusPath := filepath.Join(launcherDir, "child.json")
		if err := writeJSONFileAtomic(childStatusPath, &launcherChildStatus{PID: child.Process.Pid, Ready: false, UpdatedAt: time.Now().UTC()}, 0600); err != nil {
			logger.Warn("launcher child status is unavailable", "error", err)
		}

		var onStable func()
		if trial != nil {
			onStable = promoteTrial
		}
		outcome := superviseLauncherChild(signalCtx, spec, state, child, events, done, onStable, logger)
		_ = os.Remove(childStatusPath)
		if outcome.stop {
			return outcome.err
		}
		if outcome.err != nil {
			logger.Warn("daemon child stopped", "error", outcome.err)
		}
		if !outcome.handoff {
			if trialErr := trialChildFailed(); trialErr != nil {
				return trialErr
			}
		}
		select {
		case <-signalCtx.Done():
			return nil
		case <-time.After(backoff):
		}
		if backoff < launcherRestartMax {
			backoff *= 2
			if backoff > launcherRestartMax {
				backoff = launcherRestartMax
			}
		}
	}
}

type launcherChildOutcome struct {
	stop bool
	// handoff marks a child that exited to hand over to a staged update.
	handoff bool
	err     error
}

func prepareLauncherCandidate(spec LauncherSpec) (*launcherUpdateState, error) {
	state, err := readLauncherUpdateState(spec.StateDir)
	if err != nil || state == nil {
		return state, err
	}
	if filepath.Clean(state.BinaryPath) != filepath.Clean(spec.BinaryPath) || state.DaemonType != spec.DaemonType {
		return nil, errors.New("pending launcher update does not belong to this daemon")
	}
	version, err := readDaemonBinaryVersion(spec.BinaryPath)
	if err != nil || version != state.TargetVersion {
		if rollbackErr := rollbackLauncherUpdate(spec.StateDir, state, "candidate version did not match update target"); rollbackErr != nil {
			return nil, fmt.Errorf("candidate version validation failed: %v; rollback: %w", err, rollbackErr)
		}
		return nil, nil
	}
	if state.Phase == "staged" {
		if err := markLauncherCandidateStarted(spec.StateDir, state, time.Now()); err != nil {
			return nil, err
		}
	}
	return state, nil
}

func startLauncherChild(spec LauncherSpec, ownerLock *os.File) (*exec.Cmd, <-chan launcherReadinessEvent, <-chan error, error) {
	reader, writer, err := os.Pipe()
	if err != nil {
		return nil, nil, nil, err
	}
	cmd := exec.Command(spec.BinaryPath, spec.ChildArgs...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	// The child inherits the same flock open-file description. If the launcher
	// itself crashes, a replacement launcher cannot acquire ownership until the
	// old child has actually exited after Pdeathsig, preventing process overlap.
	cmd.ExtraFiles = []*os.File{writer, ownerLock}
	cmd.Env = append(os.Environ(),
		LauncherManagedEnv+"=1",
		LauncherReadyFDEnv+"=3",
		LauncherOwnerFDEnv+"=4",
		LauncherStateDirEnv+"="+spec.StateDir,
	)
	cmd.SysProcAttr = launcherChildSysProcAttr()
	if err := cmd.Start(); err != nil {
		reader.Close()
		writer.Close()
		return nil, nil, nil, err
	}
	writer.Close()
	events := make(chan launcherReadinessEvent, 4)
	go func() {
		defer close(events)
		defer reader.Close()
		scanner := bufio.NewScanner(reader)
		for scanner.Scan() {
			var event launcherReadinessEvent
			if json.Unmarshal(scanner.Bytes(), &event) == nil {
				events <- event
			}
		}
	}()
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	return cmd, events, done, nil
}

// onStable, when set, runs once this child was locally ready for the
// stability window, independently of any pending update.
func superviseLauncherChild(ctx context.Context, spec LauncherSpec, initialState *launcherUpdateState, child *exec.Cmd, events <-chan launcherReadinessEvent, done <-chan error, onStable func(), logger *slog.Logger) launcherChildOutcome {
	state := initialState
	var readyTimer *time.Timer
	var readyTimeout <-chan time.Time
	var controlTimer *time.Timer
	var controlTimeout <-chan time.Time
	var stabilityTimer *time.Timer
	var stabilityTimeout <-chan time.Time
	var onStableTimer *time.Timer
	var onStableTimeout <-chan time.Time
	startStability := func() {
		if stabilityTimer == nil {
			stabilityTimer = time.NewTimer(launcherStabilityWindow)
			stabilityTimeout = stabilityTimer.C
		}
	}
	defer func() {
		if controlTimer != nil {
			controlTimer.Stop()
		}
		if stabilityTimer != nil {
			stabilityTimer.Stop()
		}
		if onStableTimer != nil {
			onStableTimer.Stop()
		}
	}()
	// A persisted ready_stabilizing phase only describes the previous child.
	// Every newly launched candidate must prove local readiness again.
	if state != nil {
		readyTimer = time.NewTimer(launcherLocalReadyLimit)
		readyTimeout = readyTimer.C
		defer readyTimer.Stop()
	}
	for {
		select {
		case <-ctx.Done():
			return launcherChildOutcome{stop: true, err: terminateLauncherChild(child, done, launcherStopGrace)}
		case <-readyTimeout:
			err := terminateLauncherChild(child, done, launcherStopGrace)
			return launcherChildOutcome{err: handleLauncherCandidateExit(spec, state, "local readiness timeout", err, logger)}
		case <-controlTimeout:
			// The candidate runs but never proved it can reach and be accepted
			// by the gateway. Committing it would strand the node, so restore
			// the previous daemon now.
			_ = terminateLauncherChild(child, done, launcherStopGrace)
			if err := rollbackLauncherUpdate(spec.StateDir, state, "gateway control readiness timeout"); err != nil {
				return launcherChildOutcome{stop: true, err: err}
			}
			logger.Error("candidate never reached the gateway; restored previous daemon", "target_version", state.TargetVersion)
			return launcherChildOutcome{err: fmt.Errorf("candidate %s did not reach gateway control readiness within %s", state.TargetVersion, launcherControlReadyLimit)}
		case <-onStableTimeout:
			onStableTimeout = nil
			onStable()
		case <-stabilityTimeout:
			if state != nil {
				if err := removeLauncherUpdateState(spec.StateDir); err != nil {
					logger.Error("failed to commit stable daemon update; retrying", "error", err, "version", state.TargetVersion)
					stabilityTimer.Reset(launcherStateRetry)
					stabilityTimeout = stabilityTimer.C
					continue
				}
				logger.Info("daemon update committed after candidate stability window", "version", state.TargetVersion)
				state = nil
				stabilityTimeout = nil
			}
		case event, ok := <-events:
			if !ok {
				events = nil
				continue
			}
			if event.Type == launcherEventControlReady {
				if state == nil || controlTimeout == nil {
					continue
				}
				if event.Version != state.TargetVersion {
					_ = terminateLauncherChild(child, done, launcherStopGrace)
					if err := rollbackLauncherUpdate(spec.StateDir, state, "candidate control readiness version did not match update target"); err != nil {
						return launcherChildOutcome{stop: true, err: err}
					}
					return launcherChildOutcome{err: fmt.Errorf("candidate reported version %s, expected %s", event.Version, state.TargetVersion)}
				}
				controlTimer.Stop()
				controlTimeout = nil
				logger.Info("candidate reached gateway control readiness", "version", state.TargetVersion)
				startStability()
				continue
			}
			if event.Type != launcherEventLocalReady {
				continue
			}
			if err := writeJSONFileAtomic(filepath.Join(spec.StateDir, "launcher", "child.json"), &launcherChildStatus{
				PID:       child.Process.Pid,
				Version:   event.Version,
				Ready:     true,
				UpdatedAt: time.Now().UTC(),
			}, 0600); err != nil {
				logger.Warn("launcher child status is unavailable", "error", err)
			}
			if onStable != nil && onStableTimer == nil {
				onStableTimer = time.NewTimer(launcherStabilityWindow)
				onStableTimeout = onStableTimer.C
			}
			if state == nil {
				continue
			}
			if event.Version != state.TargetVersion {
				_ = terminateLauncherChild(child, done, launcherStopGrace)
				if err := rollbackLauncherUpdate(spec.StateDir, state, "candidate readiness version did not match update target"); err != nil {
					return launcherChildOutcome{stop: true, err: err}
				}
				return launcherChildOutcome{err: fmt.Errorf("candidate reported version %s, expected %s", event.Version, state.TargetVersion)}
			}
			readyTimeout = nil
			if err := markLauncherLocalReady(spec.StateDir, state, time.Now()); err != nil {
				logger.Error("failed to persist candidate readiness; continuing stability check", "error", err, "version", state.TargetVersion)
			}
			if event.AwaitControl {
				// Commit only after the candidate proved it reaches the gateway.
				if controlTimer == nil && stabilityTimer == nil {
					controlTimer = time.NewTimer(launcherControlReadyLimit)
					controlTimeout = controlTimer.C
				}
				continue
			}
			// A daemon that predates control_ready keeps the local-only rule.
			startStability()
		case err := <-done:
			fresh, readErr := readLauncherUpdateState(spec.StateDir)
			if readErr != nil {
				return launcherChildOutcome{stop: true, err: readErr}
			}
			if fresh != nil && fresh.Phase == "staged" {
				if daemonProcessExitCode(err) == LauncherUpdateExitCode {
					return launcherChildOutcome{handoff: true}
				}
				return launcherChildOutcome{err: fmt.Errorf("daemon exited after staging an update without the update handoff code: %v", err)}
			}
			if state == nil {
				return launcherChildOutcome{err: err}
			}
			return launcherChildOutcome{err: handleLauncherCandidateExit(spec, fresh, "candidate process exited", err, logger)}
		}
	}
}

func daemonProcessExitCode(err error) int {
	if err == nil {
		return 0
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		return exitErr.ExitCode()
	}
	return -1
}

func handleLauncherCandidateExit(spec LauncherSpec, state *launcherUpdateState, reason string, processErr error, logger *slog.Logger) error {
	if state == nil {
		return processErr
	}
	rolledBack, err := recordLauncherCandidateFailure(spec.StateDir, state, reason, time.Now())
	if err != nil {
		return err
	}
	if rolledBack {
		logger.Error("candidate crash threshold reached; restored previous daemon", "target_version", state.TargetVersion)
	}
	return processErr
}

func terminateLauncherChild(child *exec.Cmd, done <-chan error, grace time.Duration) error {
	if child == nil || child.Process == nil {
		return nil
	}
	_ = syscall.Kill(-child.Process.Pid, syscall.SIGTERM)
	select {
	case err := <-done:
		return normalizeOperatorStop(err)
	case <-time.After(grace):
		_ = syscall.Kill(-child.Process.Pid, syscall.SIGKILL)
		return normalizeOperatorStop(<-done)
	}
}

func normalizeOperatorStop(err error) error {
	if err == nil {
		return nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		if status, ok := exitErr.Sys().(syscall.WaitStatus); ok && status.Signaled() {
			return nil
		}
	}
	return err
}

// NotifyLauncherLocalReady reports local readiness only. A launcher commits a
// pending update after its stability window without waiting for the gateway.
func NotifyLauncherLocalReady(version string) {
	localReadyOnce.Do(func() {
		writeLauncherReadiness(launcherReadinessEvent{Type: launcherEventLocalReady, Version: version}, true)
	})
}

// NotifyLauncherLocalReadyAwaitingControl reports local readiness and
// announces a later NotifyLauncherControlReady. A launcher that understands
// the announcement commits a pending update only after control readiness.
func NotifyLauncherLocalReadyAwaitingControl(version string) {
	localReadyOnce.Do(func() {
		launcherReadyMu.Lock()
		launcherReadyVersion = version
		launcherAwaitsControl = true
		launcherReadyMu.Unlock()
		writeLauncherReadiness(launcherReadinessEvent{Type: launcherEventLocalReady, Version: version, AwaitControl: true}, false)
	})
}

// NotifyLauncherControlReady reports that the gateway accepted this daemon's
// control session (its first command after Register arrived). It is a no-op
// unless NotifyLauncherLocalReadyAwaitingControl announced it.
func NotifyLauncherControlReady() {
	notifyLauncherControlReady(nil)
}

// notifyLauncherControlReady also stages this daemon as the next launcher once
// its update, if any, is committed; see launcher_refresh.go.
func notifyLauncherControlReady(logger *slog.Logger) {
	launcherReadyMu.Lock()
	awaits, version := launcherAwaitsControl, launcherReadyVersion
	launcherReadyMu.Unlock()
	if !awaits {
		return
	}
	controlReadyOnce.Do(func() {
		writeLauncherReadiness(launcherReadinessEvent{Type: launcherEventControlReady, Version: version}, true)
		scheduleLauncherRefresh(version, logger)
	})
}

// writeLauncherReadiness writes one event to the launcher pipe. The pipe stays
// open between events when more are expected and is closed after the last.
func writeLauncherReadiness(event launcherReadinessEvent, last bool) {
	launcherReadyMu.Lock()
	defer launcherReadyMu.Unlock()
	if !launcherReadyOpened {
		launcherReadyOpened = true
		fdValue := os.Getenv(LauncherReadyFDEnv)
		if fdValue == "" {
			return
		}
		fd, err := strconv.Atoi(fdValue)
		if err != nil || fd < 3 {
			return
		}
		// The pipe may stay open while the daemon spawns workers; never leak it.
		syscall.CloseOnExec(fd)
		launcherReadyFile = os.NewFile(uintptr(fd), "launcher-ready")
	}
	if launcherReadyFile == nil {
		return
	}
	message, _ := json.Marshal(event)
	_, _ = launcherReadyFile.Write(append(message, '\n'))
	if last {
		_ = launcherReadyFile.Close()
		launcherReadyFile = nil
	}
}

func ensureStableLauncher(preferredStateDir, daemonType, executable string) (string, string, error) {
	candidates := []string{preferredStateDir}
	if cacheDir, err := os.UserCacheDir(); err == nil {
		candidates = append(candidates, filepath.Join(cacheDir, "gateway-daemon", daemonType))
	}
	candidates = append(candidates, filepath.Join(os.TempDir(), fmt.Sprintf("gateway-daemon-%d", os.Getuid()), daemonType))
	var failures []error
	for _, stateDir := range candidates {
		launcherPath := canonicalLauncherPath(stateDir, executable)
		if _, statErr := os.Lstat(launcherPath); statErr == nil {
			if err := ensureLauncherCopy(executable, launcherPath, stateDir); err != nil {
				return "", "", err
			}
			return stateDir, launcherPath, nil
		} else if !errors.Is(statErr, os.ErrNotExist) {
			return "", "", statErr
		}
		if err := ensureLauncherCopy(executable, launcherPath, stateDir); err != nil {
			failures = append(failures, err)
			continue
		}
		return stateDir, launcherPath, nil
	}
	return "", "", errors.Join(failures...)
}

func ensureLauncherCopy(executable, launcherPath, stateDir string) error {
	if _, err := os.Stat(launcherPath); err == nil {
		if probeErr := probeLauncher(launcherPath); probeErr != nil {
			return fmt.Errorf("installed launcher is incompatible; explicit repair required: %w", probeErr)
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := ensurePrivateLauncherDirectory(filepath.Dir(launcherPath)); err != nil {
		return err
	}
	if err := copyExecutableAtomic(executable, launcherPath); err != nil {
		return fmt.Errorf("install stable launcher copy: %w", err)
	}
	return probeLauncher(launcherPath)
}

func probeLauncher(path string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, path, LauncherProbeCommand).Output()
	if err != nil {
		return err
	}
	expected := fmt.Sprintf("gateway-daemon-launcher %d", LauncherProtocolVersion)
	if strings.TrimSpace(string(output)) != expected {
		return fmt.Errorf("unsupported launcher probe response %q", strings.TrimSpace(string(output)))
	}
	return nil
}

func readDaemonBinaryVersion(path string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, path, "version").Output()
	if err != nil {
		return "", err
	}
	fields := strings.Fields(string(output))
	if len(fields) < 2 {
		return "", errors.New("daemon version output is invalid")
	}
	return fields[len(fields)-1], nil
}

func launcherStateDirFromEnvironment(executable string) string {
	if value := strings.TrimSpace(os.Getenv(LauncherStateDirEnv)); value != "" {
		return value
	}
	switch filepath.Base(executable) {
	case "docker-daemon":
		return "/var/lib/docker-daemon"
	case "nginx-daemon":
		return "/var/lib/nginx-daemon"
	case "monitoring-daemon":
		return "/var/lib/monitoring-daemon"
	case "relay-supervisor":
		return "/var/lib/gateway-relay-supervisor"
	default:
		return filepath.Join(filepath.Dir(executable), ".gateway-launcher")
	}
}

func acquireLauncherLock(ctx context.Context, path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("open launcher owner lock: %w", err)
	}
	for {
		if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err == nil {
			return file, nil
		} else if !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
			file.Close()
			return nil, fmt.Errorf("acquire launcher owner lock: %w", err)
		}
		select {
		case <-ctx.Done():
			file.Close()
			return nil, ctx.Err()
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func releaseLauncherLock(file *os.File) {
	if file == nil {
		return
	}
	_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	_ = file.Close()
}
