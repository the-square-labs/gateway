package docker

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const storageCopyTestJobID = "22222222-2222-4222-8222-222222222222"

func validStorageCopyPayload() storageCopyPayload {
	return storageCopyPayload{
		JobID:         storageCopyTestJobID,
		Version:       1,
		Mode:          "copy",
		AllBuckets:    false,
		Buckets:       []string{"assets", "backups"},
		CreateBuckets: true,
		Source: storageCopyEndpoint{
			ConnectionID: "source-connection", Endpoint: "https://10.0.0.5:9000", Region: "us-east-1",
			AccessKeyID: "root", SecretAccessKey: "source-secret", ForcePathStyle: true, CAPEM: "-----BEGIN CERTIFICATE-----",
			RelayRouteID: storageCopyTestJobID,
		},
		Destination: storageCopyEndpoint{
			ConnectionID: "destination-connection", Endpoint: "https://s3.eu-central-1.amazonaws.com", Region: "eu-central-1",
			AccessKeyID: "AKIA", SecretAccessKey: "destination-secret",
		},
		Limits:    storageCopyLimits{TimeoutSeconds: 3600, CPUCores: 1, MemoryMB: 1024, Transfers: 4},
		ToolImage: "registry.example.test/backup-runner@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	}
}

func storageCopyPayloadJSON(t *testing.T, mutate func(*storageCopyPayload)) string {
	t.Helper()
	payload := validStorageCopyPayload()
	if mutate != nil {
		mutate(&payload)
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestStorageCopyPayloadAcceptsTypedCopyJob(t *testing.T) {
	payload, err := parseStorageCopyPayload(storageCopyPayloadJSON(t, nil))
	if err != nil {
		t.Fatalf("valid payload rejected: %v", err)
	}
	if payload.Mode != "copy" || len(payload.Buckets) != 2 {
		t.Fatalf("unexpected payload %+v", payload)
	}
	all, err := parseStorageCopyPayload(storageCopyPayloadJSON(t, func(p *storageCopyPayload) {
		p.AllBuckets, p.Buckets, p.Mode = true, nil, "sync"
	}))
	if err != nil || !all.AllBuckets {
		t.Fatalf("all-bucket sync rejected: %v", err)
	}
}

func TestStorageCopyPayloadRejectsUnsafeOrAmbiguousRequests(t *testing.T) {
	cases := map[string]func(*storageCopyPayload){
		"mode":                  func(p *storageCopyPayload) { p.Mode = "move" },
		"mutable image":         func(p *storageCopyPayload) { p.ToolImage = "registry.example.test/backup-runner:latest" },
		"both bucket selectors": func(p *storageCopyPayload) { p.AllBuckets = true },
		"no bucket selector":    func(p *storageCopyPayload) { p.Buckets = nil },
		"bucket path":           func(p *storageCopyPayload) { p.Buckets = []string{"assets/../etc"} },
		"bucket traversal":      func(p *storageCopyPayload) { p.Buckets = []string{"a..b"} },
		"bucket control char":   func(p *storageCopyPayload) { p.Buckets = []string{"assets\n"} },
		"duplicate bucket":      func(p *storageCopyPayload) { p.Buckets = []string{"assets", "assets"} },
		"foreign relay route":   func(p *storageCopyPayload) { p.Destination.RelayRouteID = "33333333-3333-4333-8333-333333333333" },
		"same connection":       func(p *storageCopyPayload) { p.Destination.ConnectionID = p.Source.ConnectionID },
		"endpoint userinfo":     func(p *storageCopyPayload) { p.Source.Endpoint = "https://user:pass@10.0.0.5:9000" },
		"endpoint scheme":       func(p *storageCopyPayload) { p.Source.Endpoint = "file:///etc/passwd" },
		"endpoint query":        func(p *storageCopyPayload) { p.Source.Endpoint = "https://s3.example.test/?x=1" },
		"credential newline":    func(p *storageCopyPayload) { p.Source.SecretAccessKey = "secret\n[remote]" },
		"timeout":               func(p *storageCopyPayload) { p.Limits.TimeoutSeconds = int((8 * 24 * time.Hour).Seconds()) },
		"transfers":             func(p *storageCopyPayload) { p.Limits.Transfers = 0 },
		"memory":                func(p *storageCopyPayload) { p.Limits.MemoryMB = 64 },
		"version":               func(p *storageCopyPayload) { p.Version = 2 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := parseStorageCopyPayload(storageCopyPayloadJSON(t, mutate))
			if err == nil || !strings.HasPrefix(err.Error(), "STORAGE_COPY_INVALID") {
				t.Fatalf("expected STORAGE_COPY_INVALID, got %v", err)
			}
		})
	}
	raw := strings.Replace(storageCopyPayloadJSON(t, nil), `"mode":"copy"`, `"mode":"copy","command":"sh -c id"`, 1)
	if _, err := parseStorageCopyPayload(raw); err == nil {
		t.Fatal("unknown fields such as a command must be rejected")
	}
}

func TestStorageCopyRunnerConfigCarriesOnlyTheCopyProgram(t *testing.T) {
	payload := validStorageCopyPayload()
	deadline := time.Now().Add(time.Hour)
	payload.DeadlineAt = &deadline
	payload.AllBuckets, payload.Buckets = true, nil
	data, err := storageCopyRunnerConfigJSON(payload)
	if err != nil {
		t.Fatal(err)
	}
	var config map[string]json.RawMessage
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatal(err)
	}
	if string(config["kind"]) != `"storage_copy"` || string(config["buckets"]) != `[]` || string(config["allBuckets"]) != "true" {
		t.Fatalf("unexpected runner config %s", data)
	}
	for _, daemonOnly := range []string{"toolImage", "deadlineAt"} {
		if _, ok := config[daemonOnly]; ok {
			t.Fatalf("runner config must not carry %s: %s", daemonOnly, data)
		}
	}
}

func TestStorageCopyRelayRoutesRewriteOnlyRelayEndpoints(t *testing.T) {
	runtime := newStorageCopyRuntime(&DockerPlugin{}, t.TempDir())
	opened := map[string]string{}
	closed := 0
	runtime.openRelay = func(_ context.Context, _ *DockerPlugin, kind, id string) (string, func(), error) {
		opened[kind] = id
		return "127.0.0.1:40123", func() { closed++ }, nil
	}
	payload := validStorageCopyPayload()
	payload.Source.Endpoint = "https://10.0.0.5:9000/base"
	closers, err := runtime.prepareRelays(context.Background(), &payload)
	if err != nil {
		t.Fatal(err)
	}
	if opened[storageCopySourceRelayKind] != storageCopyTestJobID || len(opened) != 1 {
		t.Fatalf("expected only the source relay route, got %v", opened)
	}
	if payload.Source.Endpoint != "https://127.0.0.1:40123/base" {
		t.Fatalf("source endpoint not rewritten to the relay: %s", payload.Source.Endpoint)
	}
	if payload.Destination.Endpoint != "https://s3.eu-central-1.amazonaws.com" {
		t.Fatalf("external destination must stay direct: %s", payload.Destination.Endpoint)
	}
	for _, close := range closers {
		close()
	}
	if closed != 1 {
		t.Fatalf("relay closers = %d", closed)
	}
}

func TestStorageCopyRelayFailureClosesOpenedRoutes(t *testing.T) {
	runtime := newStorageCopyRuntime(&DockerPlugin{}, t.TempDir())
	closed := 0
	runtime.openRelay = func(_ context.Context, _ *DockerPlugin, kind, _ string) (string, func(), error) {
		if kind == storageCopyDestinationRelayKind {
			return "", nil, errors.New("backup relay route is unavailable")
		}
		return "127.0.0.1:40123", func() { closed++ }, nil
	}
	payload := validStorageCopyPayload()
	payload.Destination.RelayRouteID = storageCopyTestJobID
	if _, err := runtime.prepareRelays(context.Background(), &payload); err == nil {
		t.Fatal("expected destination relay failure")
	}
	if closed != 1 {
		t.Fatalf("source relay must be closed after the destination failed, closed=%d", closed)
	}
}

func TestStorageCopyResultIsBoundToTheJob(t *testing.T) {
	good := `{"jobId":"` + storageCopyTestJobID + `","status":"completed","phase":"completed","report":{"clean":true},"progress":{"bytes":10}}`
	status, err := parseStorageCopyResult([]byte(good), storageCopyTestJobID)
	if err != nil || status.Status != "completed" || string(status.Report) != `{"clean":true}` {
		t.Fatalf("valid result rejected: %v %+v", err, status)
	}
	for name, raw := range map[string]string{
		"other job":   `{"jobId":"33333333-3333-4333-8333-333333333333","status":"completed","phase":"completed"}`,
		"running":     `{"jobId":"` + storageCopyTestJobID + `","status":"running","phase":"copying"}`,
		"extra field": `{"jobId":"` + storageCopyTestJobID + `","status":"failed","phase":"x","exec":"id"}`,
		"report type": `{"jobId":"` + storageCopyTestJobID + `","status":"completed","phase":"completed","report":[1]}`,
	} {
		if _, err := parseStorageCopyResult([]byte(raw), storageCopyTestJobID); err == nil {
			t.Fatalf("%s: expected rejection", name)
		}
	}
	failed, err := parseStorageCopyResult([]byte(`{"jobId":"`+storageCopyTestJobID+`","status":"failed","phase":"copying","error":"auth failed secret=abc\nnext"}`), storageCopyTestJobID)
	if err != nil || strings.Contains(failed.Error, "abc") || strings.Contains(failed.Error, "\n") {
		t.Fatalf("runner error must be sanitized: %v %q", err, failed.Error)
	}
}

func TestStorageCopyProgressIsBoundedJSON(t *testing.T) {
	dir := t.TempDir()
	if readStorageCopyProgress(dir) != nil {
		t.Fatal("missing progress must be nil")
	}
	write := func(content string) {
		if err := os.WriteFile(filepath.Join(dir, "progress.json"), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write(`{"phase":"copying","bucket":"assets","bytes":1048576,"objects":3}`)
	progress := readStorageCopyProgress(dir)
	if progress == nil || storageCopyProgressPhase(progress) != "copying" {
		t.Fatalf("progress not parsed: %s", progress)
	}
	write(`not json`)
	if readStorageCopyProgress(dir) != nil {
		t.Fatal("invalid progress must be ignored")
	}
	write(`{"padding":"` + strings.Repeat("x", storageCopyProgressMaxBytes) + `"}`)
	if readStorageCopyProgress(dir) != nil {
		t.Fatal("oversized progress must be ignored")
	}
}

func waitForStorageCopyStatus(t *testing.T, runtime *storageCopyRuntime, want string) storageCopyStatus {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		status, err := runtime.status(storageCopyTestJobID)
		if err == nil && status.Status == want {
			return status
		}
		time.Sleep(10 * time.Millisecond)
	}
	status, err := runtime.status(storageCopyTestJobID)
	t.Fatalf("status never became %s: %+v %v", want, status, err)
	return status
}

func TestStorageCopyCancelStopsTheRunnerAndReportsCancelled(t *testing.T) {
	runtime := newStorageCopyRuntime(&DockerPlugin{}, t.TempDir())
	var executions atomic.Int32
	started := make(chan struct{})
	runtime.execute = func(ctx context.Context, jobID string, _ storageCopyPayload, workdir string) (storageCopyStatus, error) {
		executions.Add(1)
		if err := os.MkdirAll(filepath.Join(workdir, "work"), 0700); err != nil {
			return storageCopyStatus{}, err
		}
		_ = os.WriteFile(filepath.Join(workdir, "work", "progress.json"), []byte(`{"phase":"copying","bytes":42}`), 0600)
		close(started)
		<-ctx.Done()
		return storageCopyStatus{}, ctx.Err()
	}
	raw := storageCopyPayloadJSON(t, nil)
	status, err := runtime.apply("copy_start", storageCopyTestJobID, raw)
	if err != nil || status.Status != "running" {
		t.Fatalf("start = %+v, %v", status, err)
	}
	<-started
	running, err := runtime.apply("copy_status", storageCopyTestJobID, "")
	if err != nil || running.Phase != "copying" || !strings.Contains(string(running.Progress), `"bytes":42`) {
		t.Fatalf("running status must carry runner progress: %+v %v", running, err)
	}
	// A replayed start must not launch a second runner.
	if _, err := runtime.apply("copy_start", storageCopyTestJobID, raw); err != nil {
		t.Fatal(err)
	}
	cancelling, err := runtime.apply("copy_cancel", storageCopyTestJobID, "")
	if err != nil || cancelling.Phase != "cancelling" {
		t.Fatalf("cancel = %+v, %v", cancelling, err)
	}
	final := waitForStorageCopyStatus(t, runtime, "cancelled")
	if final.CompletedAt == nil || executions.Load() != 1 {
		t.Fatalf("unexpected final status %+v (executions=%d)", final, executions.Load())
	}
	if !strings.Contains(string(final.Progress), `"bytes":42`) {
		t.Fatalf("final status keeps the last progress: %s", final.Progress)
	}
	if _, err := os.Stat(filepath.Join(runtime.root, storageCopyTestJobID)); !os.IsNotExist(err) {
		t.Fatalf("work directory must be removed, stat err=%v", err)
	}
	persisted, err := runtime.load(storageCopyTestJobID)
	if err != nil || persisted.Status != "cancelled" {
		t.Fatalf("terminal status must be persisted: %+v %v", persisted, err)
	}
}

func TestStorageCopyDeadlineFailsTheJob(t *testing.T) {
	runtime := newStorageCopyRuntime(&DockerPlugin{}, t.TempDir())
	runtime.execute = func(ctx context.Context, _ string, _ storageCopyPayload, _ string) (storageCopyStatus, error) {
		<-ctx.Done()
		return storageCopyStatus{}, ctx.Err()
	}
	raw := storageCopyPayloadJSON(t, func(p *storageCopyPayload) {
		deadline := time.Now().Add(50 * time.Millisecond)
		p.DeadlineAt = &deadline
	})
	if _, err := runtime.apply("copy_start", storageCopyTestJobID, raw); err != nil {
		t.Fatal(err)
	}
	final := waitForStorageCopyStatus(t, runtime, "failed")
	if final.Phase != "timeout" {
		t.Fatalf("expected timeout phase, got %+v", final)
	}
}

func TestStorageCopyRunnerResultBecomesTheJobStatus(t *testing.T) {
	runtime := newStorageCopyRuntime(&DockerPlugin{}, t.TempDir())
	runtime.execute = func(_ context.Context, jobID string, payload storageCopyPayload, _ string) (storageCopyStatus, error) {
		if payload.Source.SecretAccessKey != "source-secret" {
			return storageCopyStatus{}, errors.New("payload not forwarded")
		}
		return parseStorageCopyResult([]byte(`{"jobId":"`+jobID+`","status":"completed","phase":"completed","report":{"clean":false}}`), jobID)
	}
	if _, err := runtime.apply("copy_start", storageCopyTestJobID, storageCopyPayloadJSON(t, nil)); err != nil {
		t.Fatal(err)
	}
	final := waitForStorageCopyStatus(t, runtime, "completed")
	if string(final.Report) != `{"clean":false}` || final.StartedAt == nil || final.DeadlineAt == nil {
		t.Fatalf("unexpected completed status %+v", final)
	}
	encoded, _ := json.Marshal(final)
	if strings.Contains(string(encoded), "secret") {
		t.Fatalf("status must never carry credentials: %s", encoded)
	}
}

func TestStorageCopyStatusAfterDaemonRestartInterruptsTheRunner(t *testing.T) {
	root := t.TempDir()
	runtime := newStorageCopyRuntime(&DockerPlugin{}, root)
	stopped := []string{}
	runtime.stopRunner = func(jobID, containerID string) (bool, error) {
		stopped = append(stopped, jobID+"/"+containerID)
		return true, nil
	}
	started := time.Now().UTC()
	if err := runtime.persist(storageCopyStatus{JobID: storageCopyTestJobID, Status: "running", Phase: "running", StartedAt: &started, ContainerID: "runner-1"}); err != nil {
		t.Fatal(err)
	}
	status, err := runtime.apply("copy_status", storageCopyTestJobID, "")
	if err != nil || status.Status != "failed" || status.Phase != "interrupted" || status.CompletedAt == nil {
		t.Fatalf("expected interrupted failure, got %+v %v", status, err)
	}
	if len(stopped) != 1 || stopped[0] != storageCopyTestJobID+"/runner-1" {
		t.Fatalf("the orphaned runner must be stopped: %v", stopped)
	}

	// A runner that finished while the daemon was down keeps its own result.
	second := newStorageCopyRuntime(&DockerPlugin{}, t.TempDir())
	second.stopRunner = func(string, string) (bool, error) { return true, nil }
	if err := second.persist(storageCopyStatus{JobID: storageCopyTestJobID, Status: "running", Phase: "running"}); err != nil {
		t.Fatal(err)
	}
	work := filepath.Join(second.root, storageCopyTestJobID, "work")
	if err := os.MkdirAll(work, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(work, "result.json"), []byte(`{"jobId":"`+storageCopyTestJobID+`","status":"completed","phase":"completed","report":{"clean":true}}`), 0600); err != nil {
		t.Fatal(err)
	}
	recovered, err := second.status(storageCopyTestJobID)
	if err != nil || recovered.Status != "completed" || string(recovered.Report) != `{"clean":true}` {
		t.Fatalf("finished result must be recovered: %+v %v", recovered, err)
	}
}

func TestStorageCopyUnknownJobIsReportedAsUnknown(t *testing.T) {
	runtime := newStorageCopyRuntime(&DockerPlugin{}, t.TempDir())
	runtime.stopRunner = func(string, string) (bool, error) { return false, nil }
	if _, err := runtime.apply("copy_status", storageCopyTestJobID, ""); err == nil || err.Error() != storageCopyUnknownJob {
		t.Fatalf("expected %s, got %v", storageCopyUnknownJob, err)
	}
	if _, err := runtime.apply("copy_start", "not-a-uuid", ""); err == nil {
		t.Fatal("expected invalid job id to be rejected")
	}
	if _, err := runtime.apply("copy_start", "33333333-3333-4333-8333-333333333333", storageCopyPayloadJSON(t, nil)); err == nil {
		t.Fatal("expected mismatched job id to be rejected")
	}
	if _, err := runtime.apply("exec", storageCopyTestJobID, ""); err == nil {
		t.Fatal("expected unknown action to be rejected")
	}
}

func TestStorageCopyRefusesBeyondExecutorCapacity(t *testing.T) {
	runtime := newStorageCopyRuntime(&DockerPlugin{}, t.TempDir())
	for index := 0; index < storageCopyMaxActive; index++ {
		runtime.cancel[time.Now().String()+string(rune('a'+index))] = func() {}
	}
	_, err := runtime.apply("copy_start", storageCopyTestJobID, storageCopyPayloadJSON(t, nil))
	if err == nil || !strings.HasPrefix(err.Error(), "STORAGE_COPY_CAPACITY") {
		t.Fatalf("expected capacity refusal, got %v", err)
	}
}

func TestStorageCopyPruneKeepsRecentAndActiveJobs(t *testing.T) {
	runtime := newStorageCopyRuntime(&DockerPlugin{}, t.TempDir())
	old := time.Now().Add(-40 * 24 * time.Hour)
	recent := time.Now().Add(-time.Hour)
	statuses := []storageCopyStatus{
		{JobID: "11111111-1111-4111-8111-111111111111", Status: "completed", CompletedAt: &old},
		{JobID: "33333333-3333-4333-8333-333333333333", Status: "failed", CompletedAt: &recent},
		{JobID: "44444444-4444-4444-8444-444444444444", Status: "running"},
	}
	for _, status := range statuses {
		if err := runtime.persist(status); err != nil {
			t.Fatal(err)
		}
	}
	runtime.pruneTerminal()
	if _, err := runtime.load(statuses[0].JobID); err == nil {
		t.Fatal("old terminal status must be pruned")
	}
	for _, status := range statuses[1:] {
		if _, err := runtime.load(status.JobID); err != nil {
			t.Fatalf("%s must be kept: %v", status.JobID, err)
		}
	}
}

func TestStorageCopyActionsAreRecognized(t *testing.T) {
	for _, action := range []string{"copy_start", "copy_status", "copy_cancel"} {
		if !isStorageCopyAction(action) {
			t.Fatalf("%s must route to the storage copy runtime", action)
		}
	}
	for _, action := range []string{"start", "status", "cancel", "preflight", "copy"} {
		if isStorageCopyAction(action) {
			t.Fatalf("%s must stay a backup action", action)
		}
	}
}

func TestStorageProfileAdvertisesStorageCopyWithBackups(t *testing.T) {
	if joined := strings.Join(storagePluginForTest().BuildRegisterMessage("node-1").Capabilities, ","); strings.Contains(joined, storageCopyCapability) {
		t.Fatalf("storage copy advertised without a backup handler: %s", joined)
	}
	plugin := storagePluginForTest()
	plugin.RegisterBackupCommandHandler(fakeBackupCommandHandler{})
	if joined := strings.Join(plugin.BuildRegisterMessage("node-1").Capabilities, ","); !strings.Contains(joined, storageCopyCapability) {
		t.Fatalf("storage copy not advertised: %s", joined)
	}
}

func TestStorageCopyRefusesAStartThatArrivesTooLate(t *testing.T) {
	runtime := newStorageCopyRuntime(&DockerPlugin{}, t.TempDir())
	runtime.execute = func(context.Context, string, storageCopyPayload, string) (storageCopyStatus, error) {
		t.Fatal("an expired start must not run")
		return storageCopyStatus{}, nil
	}
	raw := storageCopyPayloadJSON(t, func(p *storageCopyPayload) {
		startBy := time.Now().Add(-storageCopyStartGrace - time.Minute)
		p.StartBy = &startBy
	})
	_, err := runtime.apply("copy_start", storageCopyTestJobID, raw)
	if err == nil || !strings.HasPrefix(err.Error(), storageCopyStartExpired) || !strings.Contains(err.Error(), "clock") {
		t.Fatalf("expected an expired start to be rejected naming the clock, got %v", err)
	}
	if _, err := runtime.load(storageCopyTestJobID); err == nil {
		t.Fatal("a rejected start must leave no job state")
	}
}

func TestStorageCopyCancelBeforeStartKeepsALateStartFromRunning(t *testing.T) {
	runtime := newStorageCopyRuntime(&DockerPlugin{}, t.TempDir())
	runtime.stopRunner = func(string, string) (bool, error) { return false, nil }
	runtime.execute = func(context.Context, string, storageCopyPayload, string) (storageCopyStatus, error) {
		t.Fatal("a start after its cancellation must not run")
		return storageCopyStatus{}, nil
	}
	cancelled, err := runtime.apply("copy_cancel", storageCopyTestJobID, "")
	if err != nil || cancelled.Status != "cancelled" || cancelled.Phase != "cancelled_before_start" {
		t.Fatalf("cancel of a not yet started job must record it: %+v %v", cancelled, err)
	}
	late, err := runtime.apply("copy_start", storageCopyTestJobID, storageCopyPayloadJSON(t, nil))
	if err != nil || late.Status != "cancelled" {
		t.Fatalf("late start must report the cancellation: %+v %v", late, err)
	}
	// Also after a daemon restart.
	restarted := newStorageCopyRuntime(&DockerPlugin{}, runtime.root)
	restarted.execute = runtime.execute
	if status, err := restarted.apply("copy_start", storageCopyTestJobID, storageCopyPayloadJSON(t, nil)); err != nil || status.Status != "cancelled" {
		t.Fatalf("persisted cancellation must survive a restart: %+v %v", status, err)
	}
}

func TestStorageCopyRecoveryDeletesCredentialsOfJobsItDoesNotRun(t *testing.T) {
	root := t.TempDir()
	runtime := newStorageCopyRuntime(&DockerPlugin{}, root)
	stopped := []string{}
	runtime.stopRunner = func(jobID, _ string) (bool, error) {
		stopped = append(stopped, jobID)
		return false, nil
	}
	finished := "11111111-1111-4111-8111-111111111111"
	unknown := "33333333-3333-4333-8333-333333333333"
	running := "44444444-4444-4444-8444-444444444444"
	old := time.Now().Add(-40 * 24 * time.Hour)
	for _, jobID := range []string{finished, unknown, running} {
		for _, file := range []string{"config/config.json", "work/rclone-copy.conf"} {
			path := filepath.Join(root, jobID, file)
			if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte("secret_access_key = x"), 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := os.MkdirAll(filepath.Join(root, "not-a-job"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := runtime.persist(storageCopyStatus{JobID: finished, Status: "completed", CompletedAt: &old}); err != nil {
		t.Fatal(err)
	}
	if err := runtime.persist(storageCopyStatus{JobID: running, Status: "running", Phase: "running"}); err != nil {
		t.Fatal(err)
	}
	runtime.recoverLeftovers()
	runtime.pruneTerminal()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() {
			t.Fatalf("work directory %s must be deleted", entry.Name())
		}
	}
	if status, err := runtime.load(running); err != nil || status.Status != "failed" || status.Phase != "interrupted" {
		t.Fatalf("a job running at restart must be interrupted: %+v %v", status, err)
	}
	if _, err := runtime.load(finished); err == nil {
		t.Fatal("an old finished job must be forgotten")
	}
	if strings.Join(stopped, ",") != unknown+","+running {
		t.Fatalf("runners of unknown and interrupted jobs must be stopped, got %v", stopped)
	}
}

func TestStorageCopyPruneDeletesWorkDirectoriesOfFinishedJobs(t *testing.T) {
	runtime := newStorageCopyRuntime(&DockerPlugin{}, t.TempDir())
	recent := time.Now().Add(-time.Hour)
	if err := runtime.persist(storageCopyStatus{JobID: storageCopyTestJobID, Status: "failed", CompletedAt: &recent}); err != nil {
		t.Fatal(err)
	}
	config := filepath.Join(runtime.root, storageCopyTestJobID, "config", "config.json")
	if err := os.MkdirAll(filepath.Dir(config), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(config, []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	runtime.pruneTerminal()
	if _, err := os.Stat(filepath.Join(runtime.root, storageCopyTestJobID)); !os.IsNotExist(err) {
		t.Fatalf("work directory of a finished job must be deleted, stat err=%v", err)
	}
	if _, err := runtime.load(storageCopyTestJobID); err != nil {
		t.Fatalf("a recent finished status is kept: %v", err)
	}
}

func TestStorageCopyToleratesANodeClockAheadWithinTheGrace(t *testing.T) {
	runtime := newStorageCopyRuntime(&DockerPlugin{}, t.TempDir())
	runtime.execute = func(_ context.Context, jobID string, _ storageCopyPayload, _ string) (storageCopyStatus, error) {
		return parseStorageCopyResult([]byte(`{"jobId":"`+jobID+`","status":"completed","phase":"completed"}`), jobID)
	}
	raw := storageCopyPayloadJSON(t, func(p *storageCopyPayload) {
		// Gateway's startBy already lies in this node's past, but within the grace.
		startBy := time.Now().Add(-storageCopyStartGrace + time.Minute)
		p.StartBy = &startBy
	})
	if _, err := runtime.apply("copy_start", storageCopyTestJobID, raw); err != nil {
		t.Fatalf("a start within the clock grace must run: %v", err)
	}
	waitForStorageCopyStatus(t, runtime, "completed")
}

func TestStorageCopyPrunesFinishedStatusesWhileRunning(t *testing.T) {
	runtime := newStorageCopyRuntime(&DockerPlugin{}, t.TempDir())
	runtime.stopRunner = func(string, string) (bool, error) { return false, nil }
	clock := time.Now().UTC()
	runtime.now = func() time.Time { return clock }
	at := func(age time.Duration) *time.Time {
		value := clock.Add(-age)
		return &value
	}
	oldRecord := "11111111-1111-4111-8111-111111111111"
	recentFinished := "33333333-3333-4333-8333-333333333333"
	oldFinished := "44444444-4444-4444-8444-444444444444"
	for _, status := range []storageCopyStatus{
		{JobID: oldRecord, Status: "cancelled", Phase: "cancelled_before_start", CompletedAt: at(25 * time.Hour)},
		{JobID: recentFinished, Status: "completed", Phase: "completed", CompletedAt: at(25 * time.Hour)},
		{JobID: oldFinished, Status: "failed", Phase: "failed", CompletedAt: at(8 * 24 * time.Hour)},
	} {
		copy := status
		if err := runtime.persist(copy); err != nil {
			t.Fatal(err)
		}
		runtime.jobs[copy.JobID] = &copy
	}
	// Any command drives the periodic pass.
	if _, err := runtime.apply("copy_status", storageCopyTestJobID, ""); err == nil {
		t.Fatal("expected the probed job to be unknown")
	}
	if _, err := runtime.load(oldRecord); err == nil || runtime.jobs[oldRecord] != nil {
		t.Fatal("a cancel record older than a day must be forgotten")
	}
	if _, err := runtime.load(oldFinished); err == nil || runtime.jobs[oldFinished] != nil {
		t.Fatal("a finished status older than its retention must be forgotten")
	}
	if _, err := runtime.load(recentFinished); err != nil {
		t.Fatalf("a finished status within its retention is kept: %v", err)
	}
	// The pass is throttled, then runs again once the interval elapsed.
	stale := "55555555-5555-4555-8555-555555555555"
	if err := runtime.persist(storageCopyStatus{JobID: stale, Status: "cancelled", Phase: "cancelled_before_start", CompletedAt: at(48 * time.Hour)}); err != nil {
		t.Fatal(err)
	}
	_, _ = runtime.apply("copy_status", storageCopyTestJobID, "")
	if _, err := runtime.load(stale); err != nil {
		t.Fatal("pruning must not run on every command")
	}
	clock = clock.Add(storageCopyPruneInterval + time.Second)
	_, _ = runtime.apply("copy_status", storageCopyTestJobID, "")
	if _, err := runtime.load(stale); err == nil {
		t.Fatal("pruning must run again after its interval")
	}
}
