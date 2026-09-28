package docker

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
)

// A storage or database whose container was removed (or whose record is unreadable) must not keep the whole
// node offline at daemon start: startup reconcile skips it and the node comes up.
func TestManagedRuntimeStartupSkipsBrokenRecords(t *testing.T) {
	_, client := newFakeDockerEngine(t)
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg := &config.Config{Docker: config.DockerConfig{Database: config.DatabaseConfig{StorageRoot: t.TempDir()}}}

	storage, err := newManagedStorageManager(cfg, client, logger)
	if err != nil {
		t.Fatal(err)
	}
	missing := managedStorageRecord{
		ID:             "11111111-1111-4111-8111-111111111111",
		ContainerID:    "876773e5b4edc6b719f9810b6952de4cb297fe95942010e6aac96000000000000",
		ImagePath:      filepath.Join(storage.root, "storage", "images", "missing.img"),
		MountPath:      filepath.Join(storage.root, "storage", "mounts", "missing"),
		DesiredRunning: true,
	}
	writeRecord(t, storage.recordPath(missing.ID), missing)
	if err := os.WriteFile(filepath.Join(storage.root, "storage", "records", "22222222-2222-4222-8222-222222222222.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := storage.reconcile(context.Background()); err != nil {
		t.Fatalf("storage startup reconcile failed on one broken record: %v", err)
	}

	databases, err := newManagedDatabaseManager(cfg, client, logger)
	if err != nil {
		t.Fatal(err)
	}
	brokenDatabase := managedDatabaseRecord{
		ID:             "33333333-3333-4333-8333-333333333333",
		Type:           "postgres",
		ContainerID:    "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9",
		DesiredRunning: true,
	}
	writeRecord(t, databases.recordPath(brokenDatabase.ID), brokenDatabase)
	if err := databases.reconcile(context.Background()); err != nil {
		t.Fatalf("database startup reconcile failed on one broken record: %v", err)
	}
}

func writeRecord(t *testing.T, path string, record any) {
	t.Helper()
	raw, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatal(err)
	}
}
