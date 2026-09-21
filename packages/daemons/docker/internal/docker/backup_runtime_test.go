package docker

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
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
	status, err := parseBackupRunnerResult(data, "11111111-1111-4111-8111-111111111111", "request-fingerprint")
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
