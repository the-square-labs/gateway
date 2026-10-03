package docker

import (
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
)

func newTestStorageEngine(t *testing.T) (*managedStorageManager, *fakeEngineDocker, *fakeLoops, string) {
	t.Helper()
	loops := newFakeLoops(t)
	root := t.TempDir()
	docker := &fakeEngineDocker{t: t, calls: &loops.calls, running: map[string]bool{"s1": false}, policy: map[string]string{}}
	m := &managedStorageManager{root: root, logger: slog.New(slog.DiscardHandler), loops: loops.host(), client: docker.client(),
		chown: func(string, int, int) error { return nil }}
	if err := os.MkdirAll(filepath.Join(root, "storage", "records"), 0o700); err != nil {
		t.Fatal(err)
	}
	const id = "11111111-1111-4111-8111-111111111111"
	record := managedStorageRecord{
		ID: id, ContainerID: "s1", DesiredRunning: true, OperationID: "22222222-2222-4222-8222-222222222222",
		ImagePath: filepath.Join(root, "storage", "images", id+"-0.img"),
		MountPath: filepath.Join(root, "storage", "mounts", id+"-0"),
	}
	writeFile(t, record.ImagePath)
	if err := m.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	return m, docker, loops, id
}

type inspectedStorage struct {
	Status       string `json:"status"`
	OperationID  string `json:"operationId"`
	EngineExited bool   `json:"engineExited"`
}

func inspectStorage(t *testing.T, m *managedStorageManager, id string) inspectedStorage {
	t.Helper()
	detail, err := m.handle(context.Background(), "inspect", id, "")
	if err != nil {
		t.Fatal(err)
	}
	var inspected inspectedStorage
	if err := json.Unmarshal([]byte(detail), &inspected); err != nil {
		t.Fatal(err)
	}
	return inspected
}

// An engine that keeps exiting runs most of the time (the supervisor starts it
// after every exit) without ever serving. It is reported stopped, not starting,
// until it serves or is started on purpose.
func TestStorageEngineThatKeepsExitingIsStopped(t *testing.T) {
	m, docker, _, id := newTestStorageEngine(t)
	ctx := context.Background()

	// Started when the daemon starts: it is starting.
	if err := m.startStoppedEngine(ctx, id, ""); err != nil {
		t.Fatal(err)
	}
	if got := inspectStorage(t, m, id); got.Status != "starting" || got.EngineExited {
		t.Fatalf("after a start: %+v, want starting", got)
	}

	// It exits on its own and the supervisor starts it again.
	docker.running["s1"] = false
	if err := m.startStoppedEngine(ctx, id, "s1"); err != nil {
		t.Fatal(err)
	}
	if !docker.running["s1"] {
		t.Fatal("supervisor did not start the engine")
	}
	if got := inspectStorage(t, m, id); got.Status != "stopped" || !got.EngineExited {
		t.Fatalf("after an exit: %+v, want stopped with engineExited", got)
	}

	// A restart starts it on purpose: starting again.
	if _, err := m.handle(ctx, "restart", id, ""); err != nil {
		t.Fatal(err)
	}
	if got := inspectStorage(t, m, id); got.Status != "starting" || got.EngineExited {
		t.Fatalf("after a restart: %+v, want starting", got)
	}
}

// A restart is recorded with its operation, and the same restart sent again
// (its answer was lost) does not stop the engine a second time.
func TestStorageRestartIsAppliedOncePerOperation(t *testing.T) {
	m, docker, loops, id := newTestStorageEngine(t)
	ctx := context.Background()
	docker.running["s1"] = true
	const restartOperation = "33333333-3333-4333-8333-333333333333"
	payload, _ := json.Marshal(map[string]any{"version": 1, "engine": managedStorageEngineMinIO, "operationId": restartOperation})

	for range 2 {
		if _, err := m.handle(ctx, "restart", id, string(payload)); err != nil {
			t.Fatal(err)
		}
	}

	stops := 0
	for _, call := range loops.calls {
		if call == "stop s1" {
			stops++
		}
	}
	if stops != 1 {
		t.Fatalf("calls = %v, want the engine stopped once", loops.calls)
	}
	if got := inspectStorage(t, m, id); got.OperationID != restartOperation {
		t.Fatalf("operationId = %q, want the restart's %q", got.OperationID, restartOperation)
	}

	// A restart without an operation (an older Gateway) restarts as before.
	if _, err := m.handle(ctx, "restart", id, ""); err != nil {
		t.Fatal(err)
	}
	if got := inspectStorage(t, m, id); got.OperationID != restartOperation {
		t.Fatalf("operationId = %q after a restart without one", got.OperationID)
	}
}
