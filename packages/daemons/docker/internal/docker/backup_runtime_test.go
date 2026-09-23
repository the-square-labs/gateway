package docker

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
)

func validBackupPayloadJSON() string {
	return `{"runId":"11111111-1111-4111-8111-111111111111","version":1,"direction":"backup","engine":"postgres","source":{"connectionId":"source","host":"127.0.0.1","port":5432},"destination":{"connectionId":"destination","provider":"s3","endpoint":"https://s3.example.test","bucket":"backups","prefix":"nightly"},"limits":{"workspaceBytes":1073741824,"timeoutSeconds":60,"cpuCores":1,"memoryMb":128},"toolImage":"registry.example.test/backup@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`
}

func TestBackupPayloadRejectsControlCharactersInStoragePaths(t *testing.T) {
	raw := strings.Replace(validBackupPayloadJSON(), `"prefix":"nightly"`, `"prefix":"nightly\n!id"`, 1)
	if _, _, err := parseBackupPayload(raw); err == nil {
		t.Fatal("expected control character in storage path to be rejected")
	}
}

func TestRedisRestoreRequiresExecutorReachableStageAddress(t *testing.T) {
	raw := `{"runId":"11111111-1111-4111-8111-111111111111","version":1,"direction":"restore","engine":"redis","destination":{"connectionId":"destination","provider":"s3","endpoint":"https://s3.example.test","bucket":"backups","prefix":"nightly"},"restoreTarget":{"connectionId":"target","host":"redis.example.test","port":6379},"redisStageAdvertiseHost":"127.0.0.1","limits":{"workspaceBytes":1073741824,"timeoutSeconds":60,"cpuCores":1,"memoryMb":128},"toolImage":"registry.example.test/backup@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`
	if _, _, err := parseBackupPayload(raw); err == nil {
		t.Fatal("expected loopback Redis stage address to be rejected")
	}
}

func TestManagedRedisRestoreUsesPrivateStageWithoutPublicAddress(t *testing.T) {
	raw := `{"runId":"11111111-1111-4111-8111-111111111111","version":1,"direction":"restore","engine":"redis","destination":{"connectionId":"destination","provider":"s3","endpoint":"https://s3.example.test","bucket":"backups","prefix":"nightly"},"restoreTarget":{"connectionId":"target","host":"relay.local","port":6379,"managedDatabaseId":"managed-target"},"limits":{"workspaceBytes":1073741824,"timeoutSeconds":60,"cpuCores":1,"memoryMb":128},"toolImage":"registry.example.test/backup@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`
	if _, _, err := parseBackupPayload(raw); err != nil {
		t.Fatalf("managed Redis restore must use its private stage network: %v", err)
	}
}

func TestAllocatedRedisStagePortIsBounded(t *testing.T) {
	port, err := allocateBackupStagePort()
	if err != nil {
		t.Fatal(err)
	}
	if port < 20000 || port >= 40000 {
		t.Fatalf("stage port %d outside bounded range", port)
	}
}

func TestRedisStageMemoryUsesApprovedPayloadLimit(t *testing.T) {
	limit, maxMemory, err := redisStageMemoryLimits(128)
	if err != nil {
		t.Fatal(err)
	}
	if limit != 128*1024*1024 || maxMemory != 96*1024*1024 {
		t.Fatalf("Redis stage memory limits = (%d, %d)", limit, maxMemory)
	}
}

func TestAbsoluteFileProtocolBasePathIsAllowedWithoutTraversal(t *testing.T) {
	if !isSafeBackupBasePath("/srv/data") || !isSafeBackupBasePath("relative/root") {
		t.Fatal("expected absolute and relative base paths to be allowed")
	}
	for _, path := range []string{"/srv/../data", "/srv//data", "/srv/data\n", "/srv\\data"} {
		if isSafeBackupBasePath(path) {
			t.Fatalf("unsafe base path accepted: %q", path)
		}
	}
}

func TestRestartReclaimsOnlyTerminalBackupWorkspace(t *testing.T) {
	stateRoot := t.TempDir()
	storageRoot := t.TempDir()
	runtime := &backupRuntime{
		root:   stateRoot,
		plugin: &DockerPlugin{databaseManager: &managedDatabaseManager{root: storageRoot}},
	}
	imageDir := filepath.Join(storageRoot, "backups", "images")
	if err := os.MkdirAll(imageDir, 0700); err != nil {
		t.Fatal(err)
	}
	terminalImage := filepath.Join(imageDir, "terminal.img")
	activeImage := filepath.Join(imageDir, "active.img")
	for _, image := range []string{terminalImage, activeImage} {
		if err := os.WriteFile(image, []byte("image"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(stateRoot, "terminal.json"), []byte(`{"runId":"terminal","status":"completed"}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateRoot, "active.json"), []byte(`{"runId":"active","status":"running"}`), 0600); err != nil {
		t.Fatal(err)
	}
	originalLoop := backupWorkspaceLoopDevice
	backupWorkspaceLoopDevice = func(string) (string, error) { return "", nil }
	t.Cleanup(func() { backupWorkspaceLoopDevice = originalLoop })
	runtime.reconcileWorkspaces()
	if _, err := os.Stat(terminalImage); !os.IsNotExist(err) {
		t.Fatalf("terminal workspace was not reclaimed: %v", err)
	}
	if _, err := os.Stat(activeImage); err != nil {
		t.Fatalf("active workspace was reclaimed: %v", err)
	}
}

func TestWorkspaceTeardownFailureRetainsImageAndState(t *testing.T) {
	stateRoot := t.TempDir()
	storageRoot := t.TempDir()
	runtime := &backupRuntime{root: stateRoot, plugin: &DockerPlugin{databaseManager: &managedDatabaseManager{root: storageRoot}}}
	imagePath := filepath.Join(storageRoot, "backups", "images", "run.img")
	statePath := filepath.Join(stateRoot, "run")
	if err := os.MkdirAll(filepath.Dir(imagePath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(statePath, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(imagePath, []byte("image"), 0600); err != nil {
		t.Fatal(err)
	}
	originalLoop := backupWorkspaceLoopDevice
	originalDetach := backupWorkspaceDetach
	backupWorkspaceLoopDevice = func(string) (string, error) { return "/dev/loop-test", nil }
	backupWorkspaceDetach = func(string) error { return os.ErrPermission }
	t.Cleanup(func() { backupWorkspaceLoopDevice = originalLoop; backupWorkspaceDetach = originalDetach })
	if err := runtime.removeWorkspace("run", imagePath); err == nil {
		t.Fatal("expected teardown failure")
	}
	if _, err := os.Stat(imagePath); err != nil {
		t.Fatalf("image was removed after teardown failure: %v", err)
	}
	if _, err := os.Stat(statePath); err != nil {
		t.Fatalf("state was removed after teardown failure: %v", err)
	}
}

func TestStatusReconcilesPendingCleanupWithoutRerunningOperation(t *testing.T) {
	stateRoot := t.TempDir()
	storageRoot := t.TempDir()
	runtime := &backupRuntime{root: stateRoot, plugin: &DockerPlugin{databaseManager: &managedDatabaseManager{root: storageRoot}}}
	runID := "run"
	imagePath := filepath.Join(storageRoot, "backups", "images", runID+".img")
	if err := os.MkdirAll(filepath.Join(stateRoot, runID), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Dir(imagePath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(imagePath, []byte("image"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := runtime.persist(backupRunStatus{RunID: runID, Status: "completed", Phase: "completed", CleanupPending: true}); err != nil {
		t.Fatal(err)
	}
	originalLoop := backupWorkspaceLoopDevice
	backupWorkspaceLoopDevice = func(string) (string, error) { return "", nil }
	t.Cleanup(func() { backupWorkspaceLoopDevice = originalLoop })
	status, err := runtime.status(runID)
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "completed" || status.CleanupPending {
		t.Fatalf("terminal status was changed or cleanup remained pending: %#v", status)
	}
	if _, err := os.Stat(imagePath); !os.IsNotExist(err) {
		t.Fatalf("workspace image was not reclaimed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(stateRoot, runID)); !os.IsNotExist(err) {
		t.Fatalf("workspace state was not reclaimed: %v", err)
	}
}

func TestStatusPersistsPendingCleanupFailure(t *testing.T) {
	stateRoot := t.TempDir()
	storageRoot := t.TempDir()
	runtime := &backupRuntime{root: stateRoot, plugin: &DockerPlugin{databaseManager: &managedDatabaseManager{root: storageRoot}}}
	runID := "run"
	imagePath := filepath.Join(storageRoot, "backups", "images", runID+".img")
	if err := os.MkdirAll(filepath.Dir(imagePath), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(imagePath, []byte("image"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := runtime.persist(backupRunStatus{RunID: runID, Status: "failed", Phase: "failed", CleanupPending: true}); err != nil {
		t.Fatal(err)
	}
	originalLoop := backupWorkspaceLoopDevice
	originalDetach := backupWorkspaceDetach
	backupWorkspaceLoopDevice = func(string) (string, error) { return "/dev/loop-test", nil }
	backupWorkspaceDetach = func(string) error { return errors.New("busy") }
	t.Cleanup(func() { backupWorkspaceLoopDevice = originalLoop; backupWorkspaceDetach = originalDetach })
	status, err := runtime.status(runID)
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "failed" || !status.CleanupPending || status.CleanupError == "" {
		t.Fatalf("cleanup failure was not retained on terminal status: %#v", status)
	}
	persisted, err := runtime.load(runID)
	if err != nil {
		t.Fatal(err)
	}
	if !persisted.CleanupPending || persisted.CleanupError == "" {
		t.Fatalf("cleanup failure was not persisted: %#v", persisted)
	}
}

func TestRestartReadsVerifiedTerminalResultBeforeWorkspaceCleanup(t *testing.T) {
	runtime := &backupRuntime{root: t.TempDir()}
	runID := "11111111-1111-4111-8111-111111111111"
	work := filepath.Join(runtime.root, runID, "work")
	if err := os.MkdirAll(work, 0700); err != nil {
		t.Fatal(err)
	}
	result := []byte(`{"runId":"11111111-1111-4111-8111-111111111111","status":"completed","phase":"completed","bytes":7}`)
	if err := os.WriteFile(filepath.Join(work, "result.json"), result, 0600); err != nil {
		t.Fatal(err)
	}
	status, err := runtime.readPersistedRunnerResult(backupRunStatus{RunID: runID, Fingerprint: "immutable"})
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "completed" || status.Bytes != 7 || status.Fingerprint != "immutable" {
		t.Fatalf("recovered result = %#v", status)
	}
}

func TestPreflightValidationFailurePersistsTerminalStatus(t *testing.T) {
	runID := "11111111-1111-4111-8111-111111111111"
	runtime := &backupRuntime{root: t.TempDir(), runs: map[string]*backupRunStatus{}, cancel: map[string]context.CancelFunc{}}
	raw := strings.Replace(validBackupPayloadJSON(), `"provider":"s3","endpoint":"https://s3.example.test","bucket":"backups"`, `"provider":"sftp","host":"sftp.example.test","port":22,"bucket":"backups"`, 1)
	if _, err := runtime.apply("preflight", runID, raw); err == nil {
		t.Fatal("expected validation failure")
	}
	status, err := runtime.load(runID)
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "failed" || status.Phase != "validation" || status.CompletedAt == nil {
		t.Fatalf("validation failure was not durable: %#v", status)
	}
}

func TestPreflightInfrastructureFailurePersistsTerminalStatus(t *testing.T) {
	runID := "11111111-1111-4111-8111-111111111111"
	root := t.TempDir()
	// A file where the run's config directory belongs makes runTool fail before
	// the runner container exists, like a capacity or image pull failure does.
	if err := os.MkdirAll(filepath.Join(root, runID), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, runID, "config"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	runtime := &backupRuntime{root: root, runs: map[string]*backupRunStatus{}, cancel: map[string]context.CancelFunc{}}
	if _, err := runtime.apply("preflight", runID, validBackupPayloadJSON()); err == nil {
		t.Fatal("expected preflight failure")
	}
	status, err := runtime.load(runID)
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "failed" || status.Phase != "preflight" || status.Error == "" || status.CompletedAt == nil {
		t.Fatalf("preflight failure was not durable: %#v", status)
	}
}

func TestRestartKeepsPreflightCompleteForSafeStartReplay(t *testing.T) {
	runtime := &backupRuntime{root: t.TempDir()}
	status, err := runtime.reconcilePersistedRun(backupRunStatus{RunID: "run", Status: "queued", Phase: "preflight_complete", Fingerprint: "immutable"})
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "queued" || status.Phase != "preflight_complete" {
		t.Fatalf("preflight state was not retained: %#v", status)
	}
}

func TestPersistUsesAtomicRename(t *testing.T) {
	runtime := &backupRuntime{root: t.TempDir()}
	status := backupRunStatus{RunID: "run", Status: "queued", Phase: "queued"}
	if err := runtime.persist(status); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(runtime.root, "run.json.tmp")); !os.IsNotExist(err) {
		t.Fatalf("temporary status file remained: %v", err)
	}
	loaded, err := runtime.load("run")
	if err != nil || loaded.Status != "queued" {
		t.Fatalf("atomic status was not readable: %#v, %v", loaded, err)
	}
}

func TestCancelKeepsRunReconcilableUntilWorkerExits(t *testing.T) {
	cancelled := false
	runtime := &backupRuntime{
		root:   t.TempDir(),
		runs:   map[string]*backupRunStatus{"run": {RunID: "run", Status: "running", Phase: "backup"}},
		cancel: map[string]context.CancelFunc{"run": func() { cancelled = true }},
	}
	status, err := runtime.cancelRun("run")
	if err != nil {
		t.Fatal(err)
	}
	if !cancelled || status.Status != "running" || status.Phase != "cancelling" {
		t.Fatalf("cancel must remain reconcilable: %#v", status)
	}
}

func TestParseBackupPayloadRejectsUnknownFields(t *testing.T) {
	raw := strings.TrimSuffix(validBackupPayloadJSON(), "}") + `,"shell":"rm -rf /"}`
	if _, _, err := parseBackupPayload(raw); err == nil {
		t.Fatal("expected unknown backup payload field to be rejected")
	}
}

func TestBackupPayloadRequiresSFTPHostPin(t *testing.T) {
	raw := strings.Replace(validBackupPayloadJSON(), `"provider":"s3","endpoint":"https://s3.example.test","bucket":"backups"`, `"provider":"sftp","host":"sftp.example.test","port":22,"bucket":"backups"`, 1)
	if _, _, err := parseBackupPayload(raw); err == nil {
		t.Fatal("expected SFTP host key pin requirement")
	}
}

func TestBackupPayloadRequiresClickHouseStagingForFileTargets(t *testing.T) {
	raw := strings.Replace(validBackupPayloadJSON(), `"engine":"postgres"`, `"engine":"clickhouse"`, 1)
	raw = strings.Replace(raw, `"provider":"s3","endpoint":"https://s3.example.test","bucket":"backups"`, `"provider":"ftp","host":"ftp.example.test","port":21,"bucket":"backups"`, 1)
	if _, _, err := parseBackupPayload(raw); err == nil {
		t.Fatal("expected ClickHouse file destination staging requirement")
	}
}

func TestBackupRunnerResultRetainsReplayMetadata(t *testing.T) {
	data := []byte(`{"runId":"11111111-1111-4111-8111-111111111111","status":"completed","phase":"completed","containerId":"container-1","fingerprint":"server-value"}`)
	status, err := parseBackupRunnerResult(data, "11111111-1111-4111-8111-111111111111", "request-fingerprint", "backup")
	if err != nil {
		t.Fatal(err)
	}
	if status.ContainerID != "container-1" || status.Fingerprint != "request-fingerprint" {
		t.Fatalf("status replay metadata = %#v", status)
	}
}

func TestRunToolCleanupRetainsDirectoryWhenDetachFails(t *testing.T) {
	root := t.TempDir()
	workdir := filepath.Join(root, "run")
	if err := os.MkdirAll(workdir, 0700); err != nil {
		t.Fatal(err)
	}
	image := filepath.Join(root, "run.img")
	if err := os.WriteFile(image, []byte("allocated"), 0600); err != nil {
		t.Fatal(err)
	}
	original := backupWorkspaceDetach
	backupWorkspaceDetach = func(string) error { return errors.New("busy") }
	defer func() { backupWorkspaceDetach = original }()
	if err := cleanupBackupWorkspace(&backupWorkspace{imagePath: image, mountPath: filepath.Join(workdir, "work"), loopDevice: "/dev/loop123"}, workdir); err == nil {
		t.Fatal("expected teardown failure")
	}
	if _, err := os.Stat(workdir); err != nil {
		t.Fatal("run directory removed after failed teardown", err)
	}
	if _, err := os.Stat(image); err != nil {
		t.Fatal("image removed after failed teardown", err)
	}
}

func TestContainerPersistenceFailureAlwaysReleasesRuntimeMutex(t *testing.T) {
	r := &backupRuntime{root: filepath.Join(t.TempDir(), "missing"), runs: map[string]*backupRunStatus{"run": {RunID: "run"}}}
	if err := r.recordRunnerContainer("run", "backup", "container"); err == nil {
		t.Fatal("expected persistence failure")
	}
	if !r.mu.TryLock() {
		t.Fatal("runtime mutex retained after persistence failure")
	}
	r.mu.Unlock()
}

const testBackupRunID = "11111111-1111-4111-8111-111111111111"

func TestBackupRunnerResultPhaseMustMatchOperation(t *testing.T) {
	result := func(status, phase string) []byte {
		return []byte(`{"runId":"` + testBackupRunID + `","status":"` + status + `","phase":"` + phase + `","bytes":0}`)
	}
	for _, test := range []struct {
		name      string
		operation string
		status    string
		phase     string
		valid     bool
	}{
		{"preflight passed", "preflight", "completed", "preflight", true},
		{"preflight cannot report a finished run", "preflight", "completed", "completed", false},
		{"backup finished", "backup", "completed", "completed", true},
		{"backup cannot finish with a preflight", "backup", "completed", "preflight", false},
		{"restore finished", "restore", "completed", "completed", true},
		{"restore cannot finish with a preflight", "restore", "completed", "preflight", false},
		{"recovery accepts a finished run", "", "completed", "completed", true},
		{"recovery accepts a passed preflight", "", "completed", "preflight", true},
		{"recovery rejects an unknown completed phase", "", "completed", "restore", false},
		{"failure names its operation", "restore", "failed", "restore", true},
		{"preflight failure", "preflight", "failed", "preflight", true},
		{"cancelled run", "backup", "cancelled", "backup", true},
		{"unknown status", "backup", "running", "completed", false},
		{"unknown operation", "migrate", "completed", "completed", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			_, err := parseBackupRunnerResult(result(test.status, test.phase), testBackupRunID, "fingerprint", test.operation)
			if test.valid && err != nil {
				t.Fatalf("expected result to be accepted: %v", err)
			}
			if !test.valid && err == nil {
				t.Fatal("expected result to be rejected")
			}
		})
	}
}

func TestNormalizeRecoveredRunnerResultReturnsPreflightToQueue(t *testing.T) {
	completed := time.Now().UTC()
	status := normalizeRecoveredRunnerResult(backupRunStatus{RunID: "run", Status: "completed", Phase: "preflight", CompletedAt: &completed, Fingerprint: "immutable", Bytes: 3})
	if status.Status != "queued" || status.Phase != "preflight_complete" || status.CompletedAt != nil {
		t.Fatalf("recovered preflight was not returned to the queue: %#v", status)
	}
	if status.RunID != "run" || status.Fingerprint != "immutable" || status.Bytes != 3 {
		t.Fatalf("recovered preflight lost its metadata: %#v", status)
	}
	for _, terminal := range []backupRunStatus{
		{RunID: "run", Status: "completed", Phase: "completed", CompletedAt: &completed},
		{RunID: "run", Status: "failed", Phase: "preflight", CompletedAt: &completed},
	} {
		if normalized := normalizeRecoveredRunnerResult(terminal); normalized.Status != terminal.Status || normalized.Phase != terminal.Phase || normalized.CompletedAt == nil {
			t.Fatalf("terminal result was changed: %#v", normalized)
		}
	}
}

func TestEffectiveBackupDeadlineUsesTheEarlierLimit(t *testing.T) {
	now := time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)
	if deadline := effectiveBackupDeadline(now, 3600, nil); !deadline.Equal(now.Add(time.Hour)) {
		t.Fatalf("timeout deadline = %v", deadline)
	}
	earlier := now.Add(10 * time.Minute)
	if deadline := effectiveBackupDeadline(now, 3600, &earlier); !deadline.Equal(earlier) {
		t.Fatalf("control plane deadline was not applied: %v", deadline)
	}
	later := now.Add(2 * time.Hour)
	if deadline := effectiveBackupDeadline(now, 3600, &later); !deadline.Equal(now.Add(time.Hour)) {
		t.Fatalf("control plane deadline extended the run timeout: %v", deadline)
	}
	offset := time.FixedZone("offset", 3*3600)
	if deadline := effectiveBackupDeadline(now.In(offset), 60, nil); deadline.Location() != time.UTC {
		t.Fatalf("deadline is not UTC: %v", deadline)
	}
}

func TestParseBackupRunnerDeadlineLabel(t *testing.T) {
	deadline := parseBackupRunnerDeadline("2026-09-23T15:00:00+03:00")
	if deadline == nil || !deadline.Equal(time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)) || deadline.Location() != time.UTC {
		t.Fatalf("deadline label = %v", deadline)
	}
	for _, label := range []string{"", "tomorrow", "1758628800"} {
		if parsed := parseBackupRunnerDeadline(label); parsed != nil {
			t.Fatalf("invalid deadline label %q parsed as %v", label, parsed)
		}
	}
}

func TestBackupRunOverdueHonoursDeadlineGrace(t *testing.T) {
	now := time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)
	past := now.Add(-time.Minute)
	withinGrace := now.Add(-10 * time.Second)
	future := now.Add(time.Minute)
	pastLabel := past.Format(time.RFC3339)
	for _, test := range []struct {
		name     string
		deadline *time.Time
		label    string
		created  time.Time
		overdue  bool
	}{
		{"persisted deadline passed", &past, "", time.Time{}, true},
		{"persisted deadline within grace", &withinGrace, "", time.Time{}, false},
		{"persisted deadline wins over label", &future, pastLabel, time.Time{}, false},
		{"label deadline passed", nil, pastLabel, time.Time{}, true},
		{"label deadline ahead", nil, future.Format(time.RFC3339), time.Time{}, false},
		{"unreadable label and unknown creation", nil, "later", time.Time{}, false},
		{"legacy runner past maximum run time", nil, "", now.Add(-backupMaxTimeout - time.Minute), true},
		{"legacy runner within maximum run time", nil, "", now.Add(-time.Hour), false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if overdue := backupRunOverdue(test.deadline, test.label, test.created, now); overdue != test.overdue {
				t.Fatalf("overdue = %v, want %v", overdue, test.overdue)
			}
		})
	}
}

func TestBackupPayloadAcceptsOptionalDeadline(t *testing.T) {
	payload, _, err := parseBackupPayload(validBackupPayloadJSON())
	if err != nil || payload.DeadlineAt != nil {
		t.Fatalf("payload without deadline = %#v, %v", payload.DeadlineAt, err)
	}
	raw := strings.TrimSuffix(validBackupPayloadJSON(), "}") + `,"deadlineAt":"2026-09-23T12:00:00Z"}`
	payload, _, err = parseBackupPayload(raw)
	if err != nil {
		t.Fatal(err)
	}
	if payload.DeadlineAt == nil || !payload.DeadlineAt.Equal(time.Date(2026, 9, 23, 12, 0, 0, 0, time.UTC)) {
		t.Fatalf("deadline = %v", payload.DeadlineAt)
	}
}

func TestBackupRunnerConfigOmitsDaemonOnlyDeadline(t *testing.T) {
	payload, _, err := parseBackupPayload(strings.TrimSuffix(validBackupPayloadJSON(), "}") + `,"deadlineAt":"2026-09-23T12:00:00Z"}`)
	if err != nil {
		t.Fatal(err)
	}
	data, err := backupRunnerConfig(payload)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil {
		t.Fatal(err)
	}
	if _, ok := fields["deadlineAt"]; ok {
		t.Fatalf("runner config carries a field older runners reject: %s", data)
	}
	if fields["runId"] == nil || payload.DeadlineAt == nil {
		t.Fatalf("runner config or payload lost data: %s, %v", data, payload.DeadlineAt)
	}
}

func TestBackupRunFailureClassifiesDeadlineAndCancellation(t *testing.T) {
	expired, cancelExpired := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancelExpired()
	status := backupRunFailure(expired, errors.New("wait backup runner: "+expired.Err().Error()), "run", "immutable")
	if status.Status != "failed" || status.Phase != "timeout" || status.Error != "Backup run exceeded its time limit" || status.Fingerprint != "immutable" {
		t.Fatalf("deadline failure = %#v", status)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if status := backupRunFailure(cancelled, cancelled.Err(), "run", "immutable"); status.Status != "cancelled" || status.Phase != "cancelled" {
		t.Fatalf("cancelled run = %#v", status)
	}
	if status := backupRunFailure(context.Background(), errors.New("runner exited 1"), "run", "immutable"); status.Status != "failed" || status.Phase != "failed" || status.Error != "runner exited 1" {
		t.Fatalf("ordinary failure = %#v", status)
	}
}

func TestStartWithExpiredDeadlineFailsWithoutLaunching(t *testing.T) {
	// A nil plugin makes any runner launch panic, proving none is attempted.
	runtime := &backupRuntime{root: t.TempDir(), runs: map[string]*backupRunStatus{}, cancel: map[string]context.CancelFunc{}}
	raw := strings.TrimSuffix(validBackupPayloadJSON(), "}") + `,"deadlineAt":"2020-01-01T00:00:00Z"}`
	status, err := runtime.apply("start", testBackupRunID, raw)
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "failed" || status.Phase != "timeout" || status.Error != "Backup run exceeded its deadline before it started" || status.CompletedAt == nil || status.Fingerprint == "" {
		t.Fatalf("expired start = %#v", status)
	}
	if status.DeadlineAt == nil || !status.DeadlineAt.Equal(time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)) {
		t.Fatalf("expired start deadline = %v", status.DeadlineAt)
	}
	if len(runtime.cancel) != 0 {
		t.Fatal("expired start registered a running run")
	}
	persisted, err := runtime.load(testBackupRunID)
	if err != nil || persisted.Status != "failed" || persisted.Phase != "timeout" {
		t.Fatalf("expired start was not durable: %#v, %v", persisted, err)
	}
	replayed, err := runtime.apply("start", testBackupRunID, raw)
	if err != nil || replayed.Phase != "timeout" {
		t.Fatalf("expired start replay = %#v, %v", replayed, err)
	}
}

func TestStartStillRejectsPreflightReplayWithDifferentFingerprint(t *testing.T) {
	runtime := &backupRuntime{
		root:   t.TempDir(),
		runs:   map[string]*backupRunStatus{testBackupRunID: {RunID: testBackupRunID, Status: "queued", Phase: "preflight_complete", Fingerprint: "another-request"}},
		cancel: map[string]context.CancelFunc{},
	}
	if _, err := runtime.apply("start", testBackupRunID, validBackupPayloadJSON()); err == nil || !strings.Contains(err.Error(), "replayed") {
		t.Fatalf("expected replay rejection, got %v", err)
	}
}

func backupRuntimeWithFakeEngine(t *testing.T) (*backupRuntime, *fakeDockerEngine, string) {
	t.Helper()
	engine, client := newFakeDockerEngine(t)
	storageRoot := t.TempDir()
	runtime := &backupRuntime{
		root:   t.TempDir(),
		plugin: &DockerPlugin{client: client, databaseManager: &managedDatabaseManager{root: storageRoot}},
		runs:   map[string]*backupRunStatus{},
		cancel: map[string]context.CancelFunc{},
	}
	originalLoop := backupWorkspaceLoopDevice
	backupWorkspaceLoopDevice = func(string) (string, error) { return "", nil }
	t.Cleanup(func() { backupWorkspaceLoopDevice = originalLoop })
	return runtime, engine, storageRoot
}

func addBackupRunnerContainer(engine *fakeDockerEngine, running bool, deadlineLabel string) *fakeContainer {
	labels := map[string]string{backupRunnerManagedLabel: "backup-runner", backupRunnerRunLabel: testBackupRunID}
	if deadlineLabel != "" {
		labels[backupRunnerDeadlineLabel] = deadlineLabel
	}
	return engine.addContainer(&fakeContainer{Name: "backup-runner", Labels: labels, Running: running})
}

// seedBackupWorkspace leaves the image and result a restarted daemon finds.
func seedBackupWorkspace(t *testing.T, runtime *backupRuntime, storageRoot, result string) string {
	t.Helper()
	imagePath := filepath.Join(storageRoot, "backups", "images", testBackupRunID+".img")
	work := filepath.Join(runtime.root, testBackupRunID, "work")
	for _, dir := range []string{filepath.Dir(imagePath), work} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(imagePath, []byte("image"), 0600); err != nil {
		t.Fatal(err)
	}
	if result != "" {
		if err := os.WriteFile(filepath.Join(work, "result.json"), []byte(result), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return imagePath
}

func assertBackupWorkspaceReclaimed(t *testing.T, runtime *backupRuntime, imagePath string) {
	t.Helper()
	if _, err := os.Stat(imagePath); !os.IsNotExist(err) {
		t.Fatalf("workspace image was not reclaimed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(runtime.root, testBackupRunID)); !os.IsNotExist(err) {
		t.Fatalf("workspace state was not reclaimed: %v", err)
	}
}

func TestRestartRecoversPreflightResultAsPreflightComplete(t *testing.T) {
	runtime, engine, storageRoot := backupRuntimeWithFakeEngine(t)
	runner := addBackupRunnerContainer(engine, false, "")
	imagePath := seedBackupWorkspace(t, runtime, storageRoot, `{"runId":"`+testBackupRunID+`","status":"completed","phase":"preflight","bytes":0}`)
	status, err := runtime.reconcilePersistedRun(backupRunStatus{RunID: testBackupRunID, Status: "running", Phase: "preflight", ContainerID: runner.ID, Fingerprint: "immutable"})
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "queued" || status.Phase != "preflight_complete" || status.CompletedAt != nil || status.Fingerprint != "immutable" {
		t.Fatalf("recovered preflight = %#v", status)
	}
	assertBackupWorkspaceReclaimed(t, runtime, imagePath)
	persisted, err := runtime.load(testBackupRunID)
	if err != nil || persisted.Phase != "preflight_complete" {
		t.Fatalf("recovered preflight was not durable: %#v, %v", persisted, err)
	}
}

func TestRestartNeverReportsPreflightResultAsFinishedRestore(t *testing.T) {
	runtime, engine, storageRoot := backupRuntimeWithFakeEngine(t)
	runner := addBackupRunnerContainer(engine, false, "")
	imagePath := seedBackupWorkspace(t, runtime, storageRoot, `{"runId":"`+testBackupRunID+`","status":"completed","phase":"preflight","bytes":0}`)
	status, err := runtime.reconcilePersistedRun(backupRunStatus{RunID: testBackupRunID, Status: "running", Phase: "restore", ContainerID: runner.ID, Fingerprint: "immutable"})
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "failed" || status.Phase != "runner_lost" {
		t.Fatalf("restore with a preflight-only result = %#v", status)
	}
	assertBackupWorkspaceReclaimed(t, runtime, imagePath)
}

func TestUnknownRecoveredPreflightCanStillBeStarted(t *testing.T) {
	runtime, engine, storageRoot := backupRuntimeWithFakeEngine(t)
	addBackupRunnerContainer(engine, false, "")
	imagePath := seedBackupWorkspace(t, runtime, storageRoot, `{"runId":"`+testBackupRunID+`","status":"completed","phase":"preflight","bytes":0}`)
	recovered, err := runtime.status(testBackupRunID)
	if err != nil {
		t.Fatal(err)
	}
	if recovered.Status != "queued" || recovered.Phase != "preflight_complete" || recovered.Fingerprint != "" {
		t.Fatalf("recovered preflight = %#v", recovered)
	}
	assertBackupWorkspaceReclaimed(t, runtime, imagePath)

	// A file where the config directory belongs stops the runner before it
	// allocates a real workspace; only the start decision is under test.
	if err := os.MkdirAll(filepath.Join(runtime.root, testBackupRunID), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(runtime.root, testBackupRunID, "config"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	deadlineAt := time.Now().Add(10 * time.Minute).UTC().Truncate(time.Second)
	raw := strings.TrimSuffix(validBackupPayloadJSON(), "}") + `,"deadlineAt":"` + deadlineAt.Format(time.RFC3339) + `"}`
	started, err := runtime.apply("start", testBackupRunID, raw)
	if err != nil {
		t.Fatalf("recovered preflight without a fingerprint must be startable: %v", err)
	}
	if started.Status != "queued" || started.Phase != "queued" || started.Fingerprint == "" {
		t.Fatalf("start = %#v", started)
	}
	// timeoutSeconds is 60, so the run's own limit is earlier than deadlineAt.
	if started.DeadlineAt == nil || !started.DeadlineAt.Before(deadlineAt) || started.DeadlineAt.After(time.Now().Add(time.Minute)) {
		t.Fatalf("start deadline = %v", started.DeadlineAt)
	}
	waitForTerminalBackupStatus(t, runtime)
}

func waitForTerminalBackupStatus(t *testing.T, runtime *backupRuntime) backupRunStatus {
	t.Helper()
	limit := time.Now().Add(5 * time.Second)
	for {
		if status, err := runtime.load(testBackupRunID); err == nil && isTerminalBackupStatus(status.Status) {
			return status
		}
		if time.Now().After(limit) {
			t.Fatal("started run did not finish")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestRestartStopsOverdueRunnerAndReclaimsWorkspace(t *testing.T) {
	runtime, engine, storageRoot := backupRuntimeWithFakeEngine(t)
	runner := addBackupRunnerContainer(engine, true, "")
	imagePath := seedBackupWorkspace(t, runtime, storageRoot, "")
	deadline := time.Now().Add(-time.Hour).UTC()
	status, err := runtime.reconcilePersistedRun(backupRunStatus{RunID: testBackupRunID, Status: "running", Phase: "backup", ContainerID: runner.ID, Fingerprint: "immutable", DeadlineAt: &deadline})
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "failed" || status.Phase != "timeout" || status.Error != "Backup runner exceeded its time limit and was stopped" || status.CompletedAt == nil {
		t.Fatalf("overdue runner = %#v", status)
	}
	if status.ContainerID != runner.ID || status.Fingerprint != "immutable" || status.DeadlineAt == nil || !status.DeadlineAt.Equal(deadline) {
		t.Fatalf("overdue runner lost its identity: %#v", status)
	}
	if engine.countCalls("POST /containers/"+runner.ID+"/stop") != 1 || engine.byName("backup-runner").Running {
		t.Fatalf("overdue runner was not stopped: %v", engine.callLog())
	}
	assertBackupWorkspaceReclaimed(t, runtime, imagePath)
	if persisted, err := runtime.load(testBackupRunID); err != nil || persisted.Phase != "timeout" {
		t.Fatalf("overdue stop was not durable: %#v, %v", persisted, err)
	}
}

func TestRestartUsesRunnerDeadlineLabelWithoutPersistedDeadline(t *testing.T) {
	runtime, engine, storageRoot := backupRuntimeWithFakeEngine(t)
	label := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	runner := addBackupRunnerContainer(engine, true, label)
	seedBackupWorkspace(t, runtime, storageRoot, "")
	status, err := runtime.reconcilePersistedRun(backupRunStatus{RunID: testBackupRunID, Status: "running", Phase: "restore", ContainerID: runner.ID})
	if err != nil {
		t.Fatal(err)
	}
	if status.Phase != "timeout" || status.DeadlineAt == nil || status.DeadlineAt.Format(time.RFC3339) != label {
		t.Fatalf("labelled overdue runner = %#v", status)
	}
}

func TestRestartKeepsRunnerWithinDeadline(t *testing.T) {
	runtime, engine, storageRoot := backupRuntimeWithFakeEngine(t)
	runner := addBackupRunnerContainer(engine, true, "")
	imagePath := seedBackupWorkspace(t, runtime, storageRoot, "")
	deadline := time.Now().Add(time.Hour).UTC()
	status, err := runtime.reconcilePersistedRun(backupRunStatus{RunID: testBackupRunID, Status: "running", Phase: "backup", ContainerID: runner.ID, DeadlineAt: &deadline})
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "running" || status.Phase != "backup" {
		t.Fatalf("runner within its deadline = %#v", status)
	}
	if engine.countCalls("POST /containers/") != 0 {
		t.Fatalf("runner within its deadline was touched: %v", engine.callLog())
	}
	if _, err := os.Stat(imagePath); err != nil {
		t.Fatalf("active workspace was reclaimed: %v", err)
	}
}

func TestUnknownOverdueRunnerIsStoppedByLabel(t *testing.T) {
	runtime, engine, storageRoot := backupRuntimeWithFakeEngine(t)
	label := time.Now().Add(-time.Hour).UTC().Format(time.RFC3339)
	runner := addBackupRunnerContainer(engine, true, label)
	imagePath := seedBackupWorkspace(t, runtime, storageRoot, "")
	status, err := runtime.status(testBackupRunID)
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "failed" || status.Phase != "timeout" || status.ContainerID != runner.ID || status.DeadlineAt == nil {
		t.Fatalf("unknown overdue runner = %#v", status)
	}
	if engine.byName("backup-runner").Running {
		t.Fatal("unknown overdue runner was not stopped")
	}
	assertBackupWorkspaceReclaimed(t, runtime, imagePath)
}

func TestUnknownRunnerRecoveryPersistsLabelledDeadline(t *testing.T) {
	runtime, engine, _ := backupRuntimeWithFakeEngine(t)
	label := time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	runner := addBackupRunnerContainer(engine, true, label)
	status, err := runtime.status(testBackupRunID)
	if err != nil {
		t.Fatal(err)
	}
	if status.Status != "running" || status.Phase != "recovered" || status.ContainerID != runner.ID || status.DeadlineAt == nil || status.DeadlineAt.Format(time.RFC3339) != label {
		t.Fatalf("recovered runner = %#v", status)
	}
	persisted, err := runtime.load(testBackupRunID)
	if err != nil || persisted.DeadlineAt == nil || !persisted.DeadlineAt.Equal(*status.DeadlineAt) {
		t.Fatalf("recovered deadline was not persisted: %#v, %v", persisted, err)
	}
}

func TestStorageProfileAdvertisesBackupDeadlinesWithBackups(t *testing.T) {
	joined := strings.Join(storagePluginForTest().BuildRegisterMessage("node-1").Capabilities, ",")
	if strings.Contains(joined, "database_backups_deadline_v1") {
		t.Fatalf("backup deadlines advertised without a backup handler: %s", joined)
	}
	plugin := storagePluginForTest()
	plugin.RegisterBackupCommandHandler(fakeBackupCommandHandler{})
	if joined := strings.Join(plugin.BuildRegisterMessage("node-1").Capabilities, ","); !strings.Contains(joined, "database_backups_deadline_v1") {
		t.Fatalf("backup deadlines not advertised: %s", joined)
	}
}

func TestBackupRuntimeForInitializesOnceUnderConcurrentFirstCalls(t *testing.T) {
	cfg := &config.Config{}
	cfg.StateDir = t.TempDir()
	storageRoot := t.TempDir()
	plugin := &DockerPlugin{cfg: cfg, client: &Client{}, databaseManager: &managedDatabaseManager{root: storageRoot}}
	t.Cleanup(func() { backupRuntimes.Delete(plugin) })
	stateRoot := filepath.Join(cfg.StateDir, backupStateDirectory)
	imageDir := filepath.Join(storageRoot, "backups", "images")
	for _, dir := range []string{stateRoot, imageDir} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(imageDir, "terminal.img"), []byte("image"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateRoot, "terminal.json"), []byte(`{"runId":"terminal","status":"completed"}`), 0600); err != nil {
		t.Fatal(err)
	}
	var reclaims atomic.Int32
	originalLoop := backupWorkspaceLoopDevice
	backupWorkspaceLoopDevice = func(string) (string, error) {
		reclaims.Add(1)
		// Widen the window in which a second initializer could also see the image.
		time.Sleep(20 * time.Millisecond)
		return "", nil
	}
	t.Cleanup(func() { backupWorkspaceLoopDevice = originalLoop })

	const callers = 8
	start := make(chan struct{})
	results := make([]*backupRuntime, callers)
	var wg sync.WaitGroup
	for i := range callers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			runtime, err := backupRuntimeFor(plugin)
			if err != nil {
				t.Errorf("backupRuntimeFor: %v", err)
			}
			results[i] = runtime
		}()
	}
	close(start)
	wg.Wait()
	for _, runtime := range results {
		if runtime == nil || runtime != results[0] {
			t.Fatalf("concurrent first calls returned different runtimes: %v", results)
		}
	}
	if got := reclaims.Load(); got != 1 {
		t.Fatalf("workspace reconciliation ran %d times, want once", got)
	}
}
