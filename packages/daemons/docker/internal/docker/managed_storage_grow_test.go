package docker

import (
	"context"
	"errors"
	"os"
	"slices"
	"strconv"
	"strings"
	"testing"

	"golang.org/x/sys/unix"
)

// growTestStorage is a storage whose image is 5 bytes ("image") on a node with
// room to grow it; hostCalls records the host tools a grow runs.
func growTestStorage(t *testing.T) (*managedStorageManager, *managedStorageRecord, *[]string, *string) {
	t.Helper()
	m, _, _, id := newTestStorageEngine(t)
	record, err := m.loadRecord(id)
	if err != nil {
		t.Fatal(err)
	}
	record.StorageBytes = 5
	m.statFilesystem = func(_ string, stat *unix.Statfs_t) error {
		stat.Bsize, stat.Blocks, stat.Bavail = 1, 1<<20, 1<<20
		return nil
	}
	var calls []string
	failing := ""
	m.runHostCommand = func(_ context.Context, name string, args ...string) ([]byte, error) {
		calls = append(calls, name)
		if name == failing {
			return []byte(name + ": device busy"), errors.New("exit status 1")
		}
		if name == "fallocate" {
			size, err := strconv.ParseInt(args[1], 10, 64)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.Truncate(args[2], size); err != nil {
				t.Fatal(err)
			}
		}
		return nil, nil
	}
	return m, &record, &calls, &failing
}

// A grow that failed after the image was extended is finished by the retry
// of the same size: the loop device and the filesystem are grown then too.
func TestManagedStorageGrowRetryFinishesAnInterruptedResize(t *testing.T) {
	m, record, calls, failing := growTestStorage(t)
	ctx := context.Background()

	*failing = "resize2fs"
	if err := m.ensureStorageSize(ctx, record, 64); err == nil {
		t.Fatal("a grow whose filesystem resize failed succeeded")
	}
	if want := []string{"fallocate", "losetup", "resize2fs"}; !slices.Equal(*calls, want) {
		t.Fatalf("first grow ran %v, want %v", *calls, want)
	}
	if record.StorageBytes != 5 {
		t.Fatalf("a failed grow recorded %d bytes", record.StorageBytes)
	}

	*failing, *calls = "", nil
	if err := m.ensureStorageSize(ctx, record, 64); err != nil {
		t.Fatal(err)
	}
	if want := []string{"losetup", "resize2fs"}; !slices.Equal(*calls, want) {
		t.Fatalf("retry ran %v, want %v", *calls, want)
	}
}

// A grow to the size the storage already has does nothing.
func TestManagedStorageGrowToTheAppliedSizeRunsNothing(t *testing.T) {
	m, record, calls, _ := growTestStorage(t)
	if err := m.ensureStorageSize(context.Background(), record, 5); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 0 {
		t.Fatalf("grow to the applied size ran %v", *calls)
	}
}

// A grow the node has no room for changes nothing, and the next grow that
// fits works.
func TestManagedStorageGrowWithoutRoomChangesNothing(t *testing.T) {
	m, record, calls, _ := growTestStorage(t)
	m.reserve = 1 << 20
	if err := m.ensureStorageSize(context.Background(), record, 64); err == nil || !strings.Contains(err.Error(), "insufficient managed storage capacity") {
		t.Fatalf("grow without room: %v", err)
	}
	if info, err := os.Stat(record.ImagePath); err != nil || info.Size() != 5 {
		t.Fatalf("image after a refused grow: %v %v", info, err)
	}
	if len(*calls) != 0 {
		t.Fatalf("refused grow ran %v", *calls)
	}
	m.reserve = 0
	if err := m.ensureStorageSize(context.Background(), record, 64); err != nil {
		t.Fatal(err)
	}
}

// A size below an image an unfinished grow left larger is refused with the
// size to grow to.
func TestManagedStorageGrowBelowAnUnfinishedGrowNamesTheImageSize(t *testing.T) {
	m, record, _, failing := growTestStorage(t)
	*failing = "losetup"
	if err := m.ensureStorageSize(context.Background(), record, 64); err == nil {
		t.Fatal("a grow whose loop device refresh failed succeeded")
	}
	err := m.ensureStorageSize(context.Background(), record, 32)
	if err == nil || !strings.Contains(err.Error(), "at least that size") || !strings.Contains(err.Error(), "64 bytes") {
		t.Fatalf("grow below the image: %v", err)
	}
}
