package lifecycle

import (
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSelfUpdateRejectsMissingChecksum(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	err := SelfUpdate("https://gitlab.wiolett.net/update", "v9.9.9", "", "manifest", "nginx", logger)
	if err == nil {
		t.Fatal("expected missing checksum to be rejected")
	}
}

func TestCandidateFailuresRollbackAtThreshold(t *testing.T) {
	dir := t.TempDir()
	executable := filepath.Join(dir, "daemon")
	if err := os.WriteFile(executable, []byte("candidate"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(previousBinaryPath(executable), []byte("previous"), 0755); err != nil {
		t.Fatal(err)
	}
	started := time.Date(2026, time.August, 31, 10, 0, 0, 0, time.UTC)
	if err := StagePendingUpdate(executable, "v2.10.0", "v2.10.1", started); err != nil {
		t.Fatal(err)
	}
	for attempt := 1; attempt <= 2; attempt++ {
		if err := PrepareCandidateStart(executable); err != nil {
			t.Fatal(err)
		}
		rolledBack, err := RecordCandidateFailure(executable, "candidate exited", started.Add(time.Duration(attempt)*10*time.Second))
		if err != nil {
			t.Fatal(err)
		}
		if rolledBack {
			t.Fatalf("attempt %d rolled back before threshold", attempt)
		}
	}
	if err := PrepareCandidateStart(executable); err != nil {
		t.Fatal(err)
	}
	rolledBack, err := RecordCandidateFailure(executable, "candidate exited", started.Add(30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if !rolledBack {
		t.Fatal("third failure did not roll back")
	}
	contents, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "previous" {
		t.Fatalf("restored executable = %q", contents)
	}
	if pending, err := ReadPendingUpdate(executable); err != nil || pending != nil {
		t.Fatalf("pending update after rollback = %#v, %v", pending, err)
	}
	outcome, err := ReadUpdateOutcome(executable)
	if err != nil {
		t.Fatal(err)
	}
	if outcome == nil || outcome.TargetVersion != "v2.10.1" || outcome.RestoredVersion != "v2.10.0" {
		t.Fatalf("unexpected rollback outcome: %#v", outcome)
	}
}

func TestCandidateFailureWindowExpires(t *testing.T) {
	dir := t.TempDir()
	executable := filepath.Join(dir, "daemon")
	if err := os.WriteFile(executable, []byte("candidate"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(previousBinaryPath(executable), []byte("previous"), 0755); err != nil {
		t.Fatal(err)
	}
	started := time.Date(2026, time.August, 31, 10, 0, 0, 0, time.UTC)
	if err := StagePendingUpdate(executable, "v2.10.0", "v2.10.1", started); err != nil {
		t.Fatal(err)
	}
	for _, offset := range []time.Duration{0, 91 * time.Second, 182 * time.Second} {
		if err := PrepareCandidateStart(executable); err != nil {
			t.Fatal(err)
		}
		rolledBack, err := RecordCandidateFailure(executable, "candidate exited", started.Add(offset))
		if err != nil {
			t.Fatal(err)
		}
		if rolledBack {
			t.Fatal("spaced failures incorrectly triggered rollback")
		}
	}
}

func TestOldDaemonExitBeforeCandidateStartDoesNotCountAsFailure(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "daemon")
	if err := StagePendingUpdate(executable, "v2.10.0", "v2.10.1", time.Now()); err != nil {
		t.Fatal(err)
	}
	rolledBack, err := RecordCandidateFailure(executable, "old daemon exited for update", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if rolledBack {
		t.Fatal("old daemon exit triggered rollback")
	}
	state, err := ReadPendingUpdate(executable)
	if err != nil {
		t.Fatal(err)
	}
	if state == nil || len(state.Failures) != 0 {
		t.Fatalf("old daemon exit recorded a candidate failure: %#v", state)
	}
}

func TestCommitPendingUpdateKeepsPreviousBinary(t *testing.T) {
	dir := t.TempDir()
	executable := filepath.Join(dir, "daemon")
	backup := previousBinaryPath(executable)
	if err := os.WriteFile(backup, []byte("previous"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := StagePendingUpdate(executable, "v2.10.0", "v2.10.1", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := CommitPendingUpdate(executable, "v2.10.1"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(backup); err != nil {
		t.Fatalf("previous binary was not retained: %v", err)
	}
	if pending, err := ReadPendingUpdate(executable); err != nil || pending != nil {
		t.Fatalf("pending update after commit = %#v, %v", pending, err)
	}
}

func TestReadPendingUpdateSupportsLegacyRelayMarker(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "relay-supervisor")
	if err := os.WriteFile(legacyPendingUpdatePath(executable), []byte("v2.10.0\n"), 0600); err != nil {
		t.Fatal(err)
	}
	state, err := ReadPendingUpdate(executable)
	if err != nil {
		t.Fatal(err)
	}
	if state == nil || state.TargetVersion != "v2.10.0" || state.SchemaVersion != 0 {
		t.Fatalf("legacy pending update = %#v", state)
	}
}

func TestRollbackCapabilityRequiresGuardStartedCandidateAndBackup(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "daemon")
	if err := os.WriteFile(previousBinaryPath(executable), []byte("previous"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := StagePendingUpdate(executable, "v2.10.0", "v2.10.1", time.Now()); err != nil {
		t.Fatal(err)
	}
	if supported, err := PendingUpdateSupportsRollback(executable, "v2.10.1"); err != nil || supported {
		t.Fatalf("unstated candidate advertised rollback support: supported=%v err=%v", supported, err)
	}
	if err := PrepareCandidateStart(executable); err != nil {
		t.Fatal(err)
	}
	if supported, err := PendingUpdateSupportsRollback(executable, "v2.10.1"); err != nil || !supported {
		t.Fatalf("guarded candidate did not advertise rollback support: supported=%v err=%v", supported, err)
	}
	if supported, err := PendingUpdateSupportsRollback(executable, "v2.10.2"); err != nil || supported {
		t.Fatalf("wrong-version candidate advertised rollback support: supported=%v err=%v", supported, err)
	}
}

func TestRollbackCapabilityRejectsLegacyBootstrapMarker(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "relay-supervisor")
	if err := os.WriteFile(previousBinaryPath(executable), []byte("previous"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(legacyPendingUpdatePath(executable), []byte("v2.10.1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if supported, err := PendingUpdateSupportsRollback(executable, "v2.10.1"); err != nil || supported {
		t.Fatalf("legacy bootstrap marker advertised rollback support: supported=%v err=%v", supported, err)
	}
}

func TestFinalizeUpdateRejectsMissingPendingState(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "daemon")
	if err := finalizeUpdate(executable, "v2.10.1", "v2.10.1", false); err == nil {
		t.Fatal("missing pending update was committed")
	}
}

func TestFinalizeUpdateCommitsLegacyRelayBootstrap(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "relay-supervisor")
	if err := os.WriteFile(legacyPendingUpdatePath(executable), []byte("v2.10.1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := finalizeUpdate(executable, "v2.10.1", "v2.10.1", false); err != nil {
		t.Fatal(err)
	}
	if pending, err := ReadPendingUpdate(executable); err != nil || pending != nil {
		t.Fatalf("legacy pending state after commit = %#v, %v", pending, err)
	}
}

func TestStagePendingUpdateRejectsConcurrentMarker(t *testing.T) {
	executable := filepath.Join(t.TempDir(), "daemon")
	if err := StagePendingUpdate(executable, "v2.10.0", "v2.10.1", time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := StagePendingUpdate(executable, "v2.10.1", "v2.10.2", time.Now()); err == nil {
		t.Fatal("expected concurrent pending update to be rejected")
	}
}

func TestSystemdUpdateGuardRunsPreviousBinaryAroundCandidate(t *testing.T) {
	dropIn := systemdUpdateGuardDropIn("/usr/local/bin/nginx-daemon")
	for _, expected := range []string{
		"StartLimitIntervalSec=120",
		"StartLimitBurst=6",
		"ExecStartPre=+/bin/sh",
		"nginx-daemon.previous\" update-guard start",
		"ExecStopPost=+/bin/sh",
		"update-guard failure",
		"${SERVICE_RESULT}:${EXIT_CODE}:${EXIT_STATUS}",
		"nginx-daemon.update-state.json",
	} {
		if !strings.Contains(dropIn, expected) {
			t.Fatalf("systemd guard missing %q:\n%s", expected, dropIn)
		}
	}
}

func TestBackupBinaryPublishesExecutableCopy(t *testing.T) {
	source := filepath.Join(t.TempDir(), "daemon")
	backup := source + ".previous"
	if err := os.WriteFile(source, []byte("old-binary"), 0751); err != nil {
		t.Fatal(err)
	}
	if err := BackupBinary(source, backup); err != nil {
		t.Fatal(err)
	}
	contents, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	if string(contents) != "old-binary" {
		t.Fatalf("backup contents = %q", contents)
	}
	info, err := os.Stat(backup)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0751 {
		t.Fatalf("backup mode = %o", info.Mode().Perm())
	}
}

func TestSelfUpdateRejectsMissingSignedManifest(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	err := SelfUpdate(
		"https://gitlab.wiolett.net/api/v4/projects/wiolett%2Fgateway/packages/generic/nginx-daemon/v9.9.9-nginx/nginx-daemon-linux-amd64",
		"v9.9.9",
		"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"",
		"nginx",
		logger,
	)
	if err == nil {
		t.Fatal("expected missing signed manifest to be rejected")
	}
}
