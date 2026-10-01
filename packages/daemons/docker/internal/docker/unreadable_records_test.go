package docker

import (
	"bytes"
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A damaged record file must not block the repair of everything else, and
// nothing named after its id (image, mount point, loop device) is touched.
func TestRepairLeavesUnreadableRecordsAndRepairsTheRest(t *testing.T) {
	loops := newFakeLoops(t)
	var logs bytes.Buffer
	m := newTestDatabaseManager(t, loops)
	m.logger = slog.New(slog.NewTextHandler(&logs, nil))
	images, mounts := filepath.Join(m.root, "images"), filepath.Join(m.root, "mounts")

	live := saveTestDatabase(t, m, "live")
	loops.attach("/dev/loop0", "7:0", live.ImagePath)
	loops.mount("7:0", live.MountPath)
	badRecord := m.recordPath("bad")
	if err := os.WriteFile(badRecord, []byte(`{"id":"bad","imagePa`), 0o600); err != nil {
		t.Fatal(err)
	}
	badImage, badMount := filepath.Join(images, "bad.img"), filepath.Join(mounts, "bad")
	writeFile(t, badImage)
	if err := os.MkdirAll(badMount, 0o700); err != nil {
		t.Fatal(err)
	}
	loops.attach("/dev/loop1", "7:1", badImage)
	loops.mount("7:1", badMount)
	loops.attachDeleted("/dev/loop2", "7:2", filepath.Join(images, "bad.img.old")) // not of any id: an orphan
	loops.attachDeleted("/dev/loop7", "7:7", filepath.Join(images, "gone7.img"))
	loops.mount("7:7", filepath.Join(mounts, "gone7"))
	failed := filepath.Join(images, "failed.img")
	writeFile(t, failed)

	m.repairLoopImages(context.Background())

	if loops.bound("/dev/loop7") || loops.bound("/dev/loop2") || exists(failed) {
		t.Error("orphans were not repaired next to an unreadable record")
	}
	if !loops.bound("/dev/loop1") || !loops.bound("/dev/loop0") || !exists(badImage) || !exists(badMount) || !exists(badRecord) {
		t.Error("the unreadable record, its image, mount point or loop device was touched")
	}
	for _, call := range loops.calls {
		if strings.Contains(call, badMount) || strings.Contains(call, "/dev/loop1") {
			t.Errorf("repair touched the unreadable record's storage: %s", call)
		}
	}
	if !strings.Contains(logs.String(), "cannot be read") || !strings.Contains(logs.String(), badRecord) {
		t.Errorf("unreadable record not reported with its path:\n%s", logs.String())
	}

	// Managed storage: the same for a cluster member record.
	loops = newFakeLoops(t)
	root := t.TempDir()
	logs.Reset()
	storage := &managedStorageManager{root: root, logger: slog.New(slog.NewTextHandler(&logs, nil)), loops: loops.host()}
	for _, dir := range []string{"storage/images", "storage/mounts", "storage/records"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	const damaged = "33333333-3333-4333-8333-333333333333"
	if err := os.WriteFile(storage.recordPath(damaged), []byte("\x00\x00\x00"), 0o600); err != nil {
		t.Fatal(err)
	}
	memberImage := filepath.Join(root, "storage", "images", damaged+"-0.img")
	memberMount := filepath.Join(root, "storage", "mounts", damaged+"-0")
	writeFile(t, memberImage)
	if err := os.MkdirAll(memberMount, 0o700); err != nil {
		t.Fatal(err)
	}
	loops.attach("/dev/loop3", "7:3", memberImage)
	loops.mount("7:3", memberMount)
	orphanImage := filepath.Join(root, "storage", "images", "44444444-4444-4444-8444-444444444444-0.img")
	writeFile(t, orphanImage)
	orphanMount := filepath.Join(root, "storage", "mounts", "44444444-4444-4444-8444-444444444444-1")
	if err := os.MkdirAll(orphanMount, 0o700); err != nil {
		t.Fatal(err)
	}

	storage.repairLoopImages(context.Background())

	if exists(orphanImage) || exists(orphanMount) {
		t.Error("orphans were not repaired next to an unreadable storage record")
	}
	if !loops.bound("/dev/loop3") || !exists(memberImage) || !exists(memberMount) || !exists(storage.recordPath(damaged)) {
		t.Error("the unreadable storage record, its image, mount point or loop device was touched")
	}
	if len(loops.calls) != 0 {
		t.Errorf("repair touched loop devices or mounts: %v", loops.calls)
	}
	if !strings.Contains(logs.String(), storage.recordPath(damaged)) {
		t.Errorf("unreadable storage record not reported with its path:\n%s", logs.String())
	}
}
