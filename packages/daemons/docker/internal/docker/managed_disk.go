package docker

import (
	"fmt"
	"io/fs"
	"path/filepath"
	"strings"
	"sync"
	"syscall"

	"golang.org/x/sys/unix"
)

// Managed databases, managed storage and backup workspaces keep their data in
// image files on one disk (the storage root). The images are promised their
// full size, but they do not occupy it: mkfs and trim punch holes into them,
// and an engine only fills its image over time. A node whose images are
// promised more than its disk holds fills up once they grow, and a full disk
// turns every instance's filesystem read-only at once. Capacity is therefore
// counted against what the images are promised, not against what is free now.

// managedDiskUsage is the storage root's disk as the capacity check sees it.
type managedDiskUsage struct {
	// Total and Free are the filesystem's size and the space this daemon may
	// still write (f_bavail).
	Total int64
	Free  int64
	// Unallocated is the space the image files are promised but do not
	// occupy yet: what they can still take from Free without any new image.
	Unallocated int64
	// Pending is what creates and grows in progress reserved.
	Pending int64
}

// Available is what is left for a new image or a grow once every image may
// take its full size and the reserve is kept.
func (u managedDiskUsage) Available(reserve int64) int64 {
	return u.Free - u.Unallocated - u.Pending - reserve
}

// Oversubscribed reports a disk whose images are promised more than it can
// hold (with its reserve): it fills up before they reach their sizes.
func (u managedDiskUsage) Oversubscribed(reserve int64) bool {
	return u.Available(reserve) < 0
}

// managedDiskReservations holds the space of creates and grows between their
// capacity check and the moment their image has its new size, so that two of
// them (a database and a storage, which have their own locks) cannot both
// take the same free space.
type managedDiskReservations struct {
	mu      sync.Mutex
	next    uint64
	pending map[uint64]int64
}

var managedDiskCapacity = &managedDiskReservations{pending: map[uint64]int64{}}

// managedDiskCapacityError is a refused create or grow. Nothing was changed.
type managedDiskCapacityError struct {
	Refusal   string
	Requested int64
	Usage     managedDiskUsage
	Reserve   int64
}

func (e *managedDiskCapacityError) Error() string {
	u := e.Usage
	if u.Unallocated+u.Pending > 0 {
		return fmt.Sprintf("%s: the node's disk for managed instances has %s free, of which existing instances may still take %s as they fill their disks, and %s stays in reserve; %s more does not fit",
			e.Refusal, formatDiskBytes(u.Free), formatDiskBytes(u.Unallocated+u.Pending), formatDiskBytes(e.Reserve), formatDiskBytes(e.Requested))
	}
	return fmt.Sprintf("%s: the node's disk for managed instances has %s free and %s stays in reserve; %s more does not fit",
		e.Refusal, formatDiskBytes(u.Free), formatDiskBytes(e.Reserve), formatDiskBytes(e.Requested))
}

// reserve checks that bytes more fit on the disk of root next to the full
// sizes of the images already there, and holds them until release is called.
func (r *managedDiskReservations) reserve(root string, bytes, reserve int64, statfs func(string, *unix.Statfs_t) error, refusal string) (func(), error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	usage, err := readManagedDiskUsage(root, statfs)
	if err != nil {
		return nil, err
	}
	for _, pending := range r.pending {
		usage.Pending += pending
	}
	if bytes > usage.Available(reserve) {
		return nil, &managedDiskCapacityError{Refusal: refusal, Requested: bytes, Usage: usage, Reserve: reserve}
	}
	r.next++
	id := r.next
	r.pending[id] = bytes
	return func() {
		r.mu.Lock()
		delete(r.pending, id)
		r.mu.Unlock()
	}, nil
}

// usage reads the disk of root with the reservations in progress.
func (r *managedDiskReservations) usage(root string, statfs func(string, *unix.Statfs_t) error) (managedDiskUsage, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	usage, err := readManagedDiskUsage(root, statfs)
	if err != nil {
		return usage, err
	}
	for _, pending := range r.pending {
		usage.Pending += pending
	}
	return usage, nil
}

func readManagedDiskUsage(root string, statfs func(string, *unix.Statfs_t) error) (managedDiskUsage, error) {
	if statfs == nil {
		statfs = unix.Statfs
	}
	var stat unix.Statfs_t
	if err := statfs(root, &stat); err != nil {
		return managedDiskUsage{}, fmt.Errorf("stat the disk for managed instances: %w", err)
	}
	unallocated, err := unallocatedImageBytes(root)
	if err != nil {
		return managedDiskUsage{}, err
	}
	return managedDiskUsage{
		Total:       int64(stat.Blocks) * int64(stat.Bsize),
		Free:        int64(stat.Bavail) * int64(stat.Bsize),
		Unallocated: unallocated,
	}, nil
}

// unallocatedImageBytes adds up, over every file on root's filesystem below
// root, the part of its size it does not occupy. Instance mounts below root
// are other filesystems and are not entered.
func unallocatedImageBytes(root string) (int64, error) {
	rootDev, _, err := fileIdentity(root)
	if err != nil {
		return 0, fmt.Errorf("stat the disk for managed instances: %w", err)
	}
	var total int64
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			// A file removed while it is read, or a directory this daemon
			// cannot list, holds nothing it can count.
			if path == root {
				return err
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok {
			return nil
		}
		if uint64(stat.Dev) != rootDev {
			if entry.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		if gap := info.Size() - int64(stat.Blocks)*512; gap > 0 {
			total += gap
		}
		return nil
	})
	if err != nil {
		return 0, fmt.Errorf("read the image sizes of managed instances: %w", err)
	}
	return total, nil
}

func formatDiskBytes(bytes int64) string {
	const gib = 1024 * 1024 * 1024
	if bytes < 0 {
		bytes = 0
	}
	if bytes >= gib {
		return fmt.Sprintf("%.1f GiB", float64(bytes)/gib)
	}
	return fmt.Sprintf("%d MiB", bytes/mebibyte)
}

// managedDiskOversubscription is what inspect reports while the node's disk
// is promised more than it holds; nil when it is not.
func managedDiskOversubscription(root string, reserve int64, statfs func(string, *unix.Statfs_t) error) map[string]any {
	usage, err := managedDiskCapacity.usage(root, statfs)
	if err != nil || !usage.Oversubscribed(reserve) {
		return nil
	}
	return map[string]any{
		"totalBytes":    usage.Total,
		"freeBytes":     usage.Free,
		"promisedBytes": usage.Unallocated + usage.Pending,
		"shortBytes":    -usage.Available(reserve),
	}
}

// readOnlyMount reports whether the filesystem mounted at path no longer
// takes writes, and why: mounted read-only, or an ext4 that stopped writing
// after an I/O error or an aborted journal ("emergency_ro", or "ro" on older
// kernels, which mark the whole superblock read-only).
func (h *loopHost) readOnlyMount(path string) (bool, string) {
	mounts, err := h.mounts()
	if err != nil {
		return false, ""
	}
	path = canonicalLoopPath(path)
	var visible *mountEntry
	for i := range mounts {
		if mounts[i].MountPoint == path {
			visible = &mounts[i] // the last one is visible
		}
	}
	if visible == nil {
		return false, ""
	}
	for _, option := range strings.Split(visible.SuperOptions, ",") {
		switch option {
		case "emergency_ro", "shutdown":
			return true, option
		case "ro":
			return true, "the filesystem was switched to read-only"
		}
	}
	for _, option := range strings.Split(visible.Options, ",") {
		if option == "ro" {
			return true, "mounted read-only"
		}
	}
	return false, ""
}
