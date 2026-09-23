package lifecycle

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newLauncherRefreshFixture installs a v1 launcher copy and a v2 daemon binary.
func newLauncherRefreshFixture(t *testing.T) (stateDir, launcherPath, source string) {
	t.Helper()
	stateDir = t.TempDir()
	source = filepath.Join(t.TempDir(), "test-daemon")
	writeLauncherTestExecutable(t, source, "v2", true)
	launcherPath = canonicalLauncherPath(stateDir, source)
	writeLauncherTestExecutable(t, launcherPath, "v1", true)
	return stateDir, launcherPath, source
}

func stageTestLauncherRefresh(t *testing.T, stateDir, launcherPath, source string) {
	t.Helper()
	staged, err := stageLauncherRefresh(stateDir, launcherPath, source, "v2", time.Now())
	if err != nil || !staged {
		t.Fatalf("stage launcher refresh = %v, %v", staged, err)
	}
}

func mustReadLauncherRefreshState(t *testing.T, stateDir string) *launcherRefreshState {
	t.Helper()
	state, err := readLauncherRefreshState(stateDir)
	if err != nil || state == nil {
		t.Fatalf("launcher refresh state = %#v, %v", state, err)
	}
	return state
}

func mustReadFile(t *testing.T, path string) string {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(contents)
}

func useTrialExecutable(t *testing.T, path string) {
	t.Helper()
	previous := currentExecutable
	currentExecutable = func() (string, error) { return path, nil }
	t.Cleanup(func() { currentExecutable = previous })
}

func TestStageLauncherRefreshStagesVerifiedCopyWithoutTouchingLauncher(t *testing.T) {
	stateDir, launcherPath, source := newLauncherRefreshFixture(t)
	installed := mustReadFile(t, launcherPath)
	stageTestLauncherRefresh(t, stateDir, launcherPath, source)

	if mustReadFile(t, launcherPath) != installed {
		t.Fatal("staging modified the installed launcher")
	}
	if mustReadFile(t, stagedLauncherPath(launcherPath)) != mustReadFile(t, source) {
		t.Fatal("staged launcher is not a copy of the daemon binary")
	}
	state := mustReadLauncherRefreshState(t, stateDir)
	sourceSum, _ := executableChecksum(source)
	if state.Phase != launcherRefreshPhaseTrial || state.Attempts != 0 || state.TargetSHA256 != sourceSum || state.TargetVersion != "v2" || state.LauncherPath != launcherPath {
		t.Fatalf("launcher refresh state = %#v", state)
	}
	if staged, err := stageLauncherRefresh(stateDir, launcherPath, source, "v2", time.Now()); err != nil || staged {
		t.Fatalf("restaging the same binary = %v, %v", staged, err)
	}
	freshStateDir, freshLauncherPath, freshSource := newLauncherRefreshFixture(t)
	if _, err := stageLauncherRefresh(freshStateDir, freshLauncherPath, freshSource, "v3", time.Now()); err == nil {
		t.Fatal("staged a binary that is not the running version")
	}
}

func TestStageLauncherRefreshSkipsPendingUpdateAndCurrentLauncher(t *testing.T) {
	stateDir, launcherPath, source := newLauncherRefreshFixture(t)
	if _, err := stageLauncherUpdate(stateDir, "docker", source, "v1", "v2", time.Now()); err != nil {
		t.Fatal(err)
	}
	if staged, err := stageLauncherRefresh(stateDir, launcherPath, source, "v2", time.Now()); err != nil || staged {
		t.Fatalf("staged during a pending update = %v, %v", staged, err)
	}
	if _, err := os.Lstat(stagedLauncherPath(launcherPath)); !os.IsNotExist(err) {
		t.Fatalf("staged launcher exists during a pending update: %v", err)
	}
	if err := removeLauncherUpdateState(stateDir); err != nil {
		t.Fatal(err)
	}
	writeLauncherTestExecutable(t, launcherPath, "v2", true)
	if staged, err := stageLauncherRefresh(stateDir, launcherPath, source, "v2", time.Now()); err != nil || staged {
		t.Fatalf("staged an already current launcher = %v, %v", staged, err)
	}
}

func TestSelectLauncherForStartWithoutRefreshKeepsInstalledLauncher(t *testing.T) {
	stateDir, launcherPath, _ := newLauncherRefreshFixture(t)
	if selected := selectLauncherForStart(stateDir, launcherPath); selected != launcherPath {
		t.Fatalf("selected %s", selected)
	}
	if _, err := os.Stat(launcherRefreshStatePath(stateDir)); !os.IsNotExist(err) {
		t.Fatalf("selection created refresh state: %v", err)
	}
}

func TestSelectLauncherForStartTriesStagedLauncherUntilAttemptLimit(t *testing.T) {
	stateDir, launcherPath, source := newLauncherRefreshFixture(t)
	installed := mustReadFile(t, launcherPath)
	stageTestLauncherRefresh(t, stateDir, launcherPath, source)
	for attempt := 1; attempt <= launcherRefreshAttemptLimit; attempt++ {
		if selected := selectLauncherForStart(stateDir, launcherPath); selected != stagedLauncherPath(launcherPath) {
			t.Fatalf("attempt %d selected %s", attempt, selected)
		}
		if state := mustReadLauncherRefreshState(t, stateDir); state.Attempts != attempt {
			t.Fatalf("attempt %d recorded %d attempts", attempt, state.Attempts)
		}
	}
	// The trial never confirmed: fall back for good.
	if selected := selectLauncherForStart(stateDir, launcherPath); selected != launcherPath {
		t.Fatalf("exhausted trial selected %s", selected)
	}
	state := mustReadLauncherRefreshState(t, stateDir)
	if state.Phase != launcherRefreshPhaseAbandoned || !strings.Contains(state.Reason, "did not confirm") {
		t.Fatalf("exhausted trial state = %#v", state)
	}
	if _, err := os.Lstat(stagedLauncherPath(launcherPath)); !os.IsNotExist(err) {
		t.Fatalf("abandoned staged launcher was kept: %v", err)
	}
	if mustReadFile(t, launcherPath) != installed {
		t.Fatal("abandoned trial modified the installed launcher")
	}
	if staged, err := stageLauncherRefresh(stateDir, launcherPath, source, "v2", time.Now()); err != nil || staged {
		t.Fatalf("restaged an abandoned launcher = %v, %v", staged, err)
	}
}

func TestSelectLauncherForStartKeepsInstalledLauncherDuringPendingUpdate(t *testing.T) {
	stateDir, launcherPath, source := newLauncherRefreshFixture(t)
	stageTestLauncherRefresh(t, stateDir, launcherPath, source)
	if _, err := stageLauncherUpdate(stateDir, "docker", source, "v2", "v3", time.Now()); err != nil {
		t.Fatal(err)
	}
	if selected := selectLauncherForStart(stateDir, launcherPath); selected != launcherPath {
		t.Fatalf("pending update selected %s", selected)
	}
	state := mustReadLauncherRefreshState(t, stateDir)
	if state.Phase != launcherRefreshPhaseTrial || state.Attempts != 0 {
		t.Fatalf("pending update consumed the trial: %#v", state)
	}
}

func TestSelectLauncherForStartAbandonsChangedStagedLauncher(t *testing.T) {
	stateDir, launcherPath, source := newLauncherRefreshFixture(t)
	stageTestLauncherRefresh(t, stateDir, launcherPath, source)
	writeLauncherTestExecutable(t, stagedLauncherPath(launcherPath), "v3", true)
	if selected := selectLauncherForStart(stateDir, launcherPath); selected != launcherPath {
		t.Fatalf("changed staged launcher selected %s", selected)
	}
	if state := mustReadLauncherRefreshState(t, stateDir); state.Phase != launcherRefreshPhaseAbandoned || !strings.Contains(state.Reason, "checksum") {
		t.Fatalf("changed staged launcher state = %#v", state)
	}
	if _, err := os.Lstat(stagedLauncherPath(launcherPath)); !os.IsNotExist(err) {
		t.Fatalf("changed staged launcher was kept: %v", err)
	}
}

func TestSelectLauncherForStartFinishesInterruptedPromotion(t *testing.T) {
	stateDir, launcherPath, source := newLauncherRefreshFixture(t)
	stageTestLauncherRefresh(t, stateDir, launcherPath, source)
	// Power loss after the promotion rename but before the journal was removed.
	if err := os.Rename(stagedLauncherPath(launcherPath), launcherPath); err != nil {
		t.Fatal(err)
	}
	if selected := selectLauncherForStart(stateDir, launcherPath); selected != launcherPath {
		t.Fatalf("interrupted promotion selected %s", selected)
	}
	if state, err := readLauncherRefreshState(stateDir); err != nil || state != nil {
		t.Fatalf("interrupted promotion left state %#v, %v", state, err)
	}
}

func TestLauncherTrialPromotesStagedLauncherAfterStableChild(t *testing.T) {
	restore := useFastLauncherTimings()
	defer restore()
	stateDir, launcherPath, source := newLauncherRefreshFixture(t)
	installed := mustReadFile(t, launcherPath)
	stageTestLauncherRefresh(t, stateDir, launcherPath, source)
	if selected := selectLauncherForStart(stateDir, launcherPath); selected != stagedLauncherPath(launcherPath) {
		t.Fatalf("selected %s", selected)
	}
	useTrialExecutable(t, stagedLauncherPath(launcherPath))

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		done <- runLauncher(ctx, LauncherSpec{DaemonType: "docker", StateDir: stateDir, BinaryPath: source, ChildArgs: []string{"run"}}, discardLauncherLogger())
	}()
	waitForLauncherPath(t, launcherRefreshStatePath(stateDir), false)
	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("launcher did not stop")
	}
	if mustReadFile(t, launcherPath) != mustReadFile(t, source) {
		t.Fatal("confirmed launcher did not replace the installed copy")
	}
	if mustReadFile(t, previousLauncherPath(launcherPath)) != installed {
		t.Fatal("replaced launcher was not kept as the previous copy")
	}
	if _, err := os.Lstat(stagedLauncherPath(launcherPath)); !os.IsNotExist(err) {
		t.Fatalf("staged launcher remained after promotion: %v", err)
	}
}

func TestLauncherTrialFallsBackToInstalledLauncherWhenChildrenFail(t *testing.T) {
	restore := useFastLauncherTimings()
	defer restore()
	stateDir, launcherPath, source := newLauncherRefreshFixture(t)
	installed := mustReadFile(t, launcherPath)
	stageTestLauncherRefresh(t, stateDir, launcherPath, source)
	useTrialExecutable(t, stagedLauncherPath(launcherPath))
	// The daemon never becomes ready under the trial launcher.
	failing := filepath.Join(t.TempDir(), "test-daemon")
	if err := os.WriteFile(failing, []byte("#!/bin/sh\nexit 1\n"), 0755); err != nil {
		t.Fatal(err)
	}
	execErr := errors.New("exec intercepted")
	var execPath string
	var execArgs []string
	previousExec := launcherExec
	launcherExec = func(path string, args []string, _ []string) error {
		execPath, execArgs = path, args
		return execErr
	}
	defer func() { launcherExec = previousExec }()

	err := runLauncher(context.Background(), LauncherSpec{DaemonType: "docker", StateDir: stateDir, BinaryPath: failing, ChildArgs: []string{"run"}}, discardLauncherLogger())
	if !errors.Is(err, execErr) {
		t.Fatalf("trial launcher returned %v, expected a hand-over to the installed launcher", err)
	}
	wantArgs := []string{launcherPath, LauncherCommand, "--daemon-type", "docker", "--state-dir", stateDir, "--binary", failing, "--", "run"}
	if execPath != launcherPath || strings.Join(execArgs, " ") != strings.Join(wantArgs, " ") {
		t.Fatalf("hand-over exec = %s %q", execPath, execArgs)
	}
	if state := mustReadLauncherRefreshState(t, stateDir); state.Phase != launcherRefreshPhaseAbandoned {
		t.Fatalf("failed trial state = %#v", state)
	}
	if _, err := os.Lstat(stagedLauncherPath(launcherPath)); !os.IsNotExist(err) {
		t.Fatalf("failed staged launcher was kept: %v", err)
	}
	if mustReadFile(t, launcherPath) != installed {
		t.Fatal("failed trial modified the installed launcher")
	}
}

func TestScheduleLauncherRefreshStagesOnlyAfterUpdateCommits(t *testing.T) {
	stateDir, launcherPath, source := newLauncherRefreshFixture(t)
	t.Setenv(LauncherManagedEnv, "1")
	t.Setenv(LauncherStateDirEnv, stateDir)
	useTrialExecutable(t, source)
	oldPoll, oldWait := launcherRefreshPollInterval, launcherRefreshCommitWait
	launcherRefreshPollInterval, launcherRefreshCommitWait = 10*time.Millisecond, 3*time.Second
	defer func() { launcherRefreshPollInterval, launcherRefreshCommitWait = oldPoll, oldWait }()
	if _, err := stageLauncherUpdate(stateDir, "docker", source, "v1", "v2", time.Now()); err != nil {
		t.Fatal(err)
	}

	scheduleLauncherRefresh("v2", discardLauncherLogger())
	time.Sleep(100 * time.Millisecond)
	if _, err := os.Lstat(stagedLauncherPath(launcherPath)); !os.IsNotExist(err) {
		t.Fatalf("launcher refresh staged before the update committed: %v", err)
	}
	if err := removeLauncherUpdateState(stateDir); err != nil {
		t.Fatal(err)
	}
	waitForLauncherPath(t, launcherRefreshStatePath(stateDir), true)
	if state := mustReadLauncherRefreshState(t, stateDir); state.Phase != launcherRefreshPhaseTrial || state.TargetVersion != "v2" {
		t.Fatalf("scheduled launcher refresh state = %#v", state)
	}
}
