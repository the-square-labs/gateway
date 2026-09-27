package docker

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// A relay connection that reaches the dial answered without waiting for the
// manager lock: either the loopback engine port accepted, or the dial itself
// failed. Record or container errors mean it never got that far.
func relayDialAttempt(connection net.Conn, err error) error {
	if err == nil {
		return connection.Close()
	}
	var dialErr *net.OpError
	if !errors.As(err, &dialErr) || dialErr.Op != "dial" {
		return fmt.Errorf("dial error = %w, want a TCP dial attempt", err)
	}
	return nil
}

// runWithin fails the test when run is still blocked after limit. run must
// not use t: it may outlive the test.
func runWithin(t *testing.T, limit time.Duration, name string, run func() error) {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- run() }()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	case <-time.After(limit):
		t.Fatalf("%s waited for the manager lock", name)
	}
}

func newLockTestDatabaseManager(t *testing.T) (*fakeDockerEngine, *managedDatabaseManager) {
	t.Helper()
	engine, client := newFakeDockerEngine(t)
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "records"), 0o700); err != nil {
		t.Fatal(err)
	}
	manager := &managedDatabaseManager{client: client, root: root}
	record := managedDatabaseRecord{
		ID: testLinkDatabaseID, Type: "redis", ContainerID: "db-container", NetworkName: "gateway-db-test",
		ImagePath: filepath.Join(root, "images", testLinkDatabaseID+".img"), MountPath: filepath.Join(root, "mounts", testLinkDatabaseID),
	}
	if err := manager.saveRecord(record); err != nil {
		t.Fatal(err)
	}
	engine.addContainer(&fakeContainer{
		ID: "db-container", Name: "gwdb-test", Running: true,
		Labels:   map[string]string{managedDatabaseLabel: testLinkDatabaseID, managedDatabaseTypeTag: "redis"},
		Networks: map[string]netip.Addr{"gateway-db-test": netip.MustParseAddr("127.0.0.1")},
	})
	return engine, manager
}

func TestManagedDatabaseRelayDialDoesNotWaitForManagerLock(t *testing.T) {
	_, manager := newLockTestDatabaseManager(t)
	manager.mu.Lock()
	defer manager.mu.Unlock()

	runWithin(t, 3*time.Second, "managed database relay dial", func() error {
		return relayDialAttempt(manager.dial(context.Background(), testLinkDatabaseID))
	})
}

func TestManagedDatabaseStatsDoNotHoldManagerLock(t *testing.T) {
	engine, manager := newLockTestDatabaseManager(t)
	sampling := make(chan struct{})
	release := make(chan struct{})
	engine.onStats = func(*fakeContainer) {
		close(sampling)
		<-release
	}
	statsDone := make(chan error, 1)
	go func() {
		_, err := manager.handle(context.Background(), "stats", testLinkDatabaseID, "")
		statsDone <- err
	}()
	select {
	case <-sampling:
	case <-time.After(3 * time.Second):
		t.Fatal("stats sample did not start")
	}

	defer close(release)
	runWithin(t, 3*time.Second, "managed database inspect during a stats sample", func() error {
		_, err := manager.handle(context.Background(), "inspect", testLinkDatabaseID, "")
		return err
	})

	release <- struct{}{}
	if err := <-statsDone; err != nil {
		t.Fatalf("stats: %v", err)
	}
}

func TestManagedStorageRelayDialDoesNotWaitForManagerLock(t *testing.T) {
	engine, client := newFakeDockerEngine(t)
	const storageID = "4c1d2e3f-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
	manager := &managedStorageManager{client: client, root: t.TempDir()}
	if err := os.MkdirAll(filepath.Dir(manager.recordPath(storageID)), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := manager.saveRecord(managedStorageRecord{ID: storageID, ContainerID: "storage-container", NetworkName: "gateway-storage-test"}); err != nil {
		t.Fatal(err)
	}
	engine.addContainer(&fakeContainer{
		ID: "storage-container", Name: "gateway-storage-test-0", Running: true,
		Labels:   map[string]string{managedStorageLabel: storageID, managedStorageMemberLabel: strconv.Itoa(0)},
		Networks: map[string]netip.Addr{"gateway-storage-test": netip.MustParseAddr("127.0.0.1")},
	})
	manager.mu.Lock()
	defer manager.mu.Unlock()

	runWithin(t, 3*time.Second, "managed storage relay dial", func() error {
		return relayDialAttempt(manager.dial(context.Background(), storageID))
	})
}
