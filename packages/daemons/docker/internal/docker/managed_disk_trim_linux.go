package docker

import (
	"fmt"
	"unsafe"

	"golang.org/x/sys/unix"
)

// fitrim is FITRIM, _IOWR('X', 121, struct fstrim_range).
const fitrim = 0xC0185879

type fstrimRange struct {
	Start  uint64
	Len    uint64
	MinLen uint64
}

// trimFilesystem tells the filesystem mounted at path to discard its free
// blocks (what fstrim does). On a loop-mounted image the discard punches holes
// into the image file, so the space of deleted data goes back to the node's
// disk. It returns how many bytes the filesystem reported as trimmed.
func trimFilesystem(path string) (int64, error) {
	fd, err := unix.Open(path, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return 0, fmt.Errorf("open %s for trim: %w", path, err)
	}
	defer unix.Close(fd)
	trim := fstrimRange{Len: ^uint64(0)}
	if _, _, errno := unix.Syscall(unix.SYS_IOCTL, uintptr(fd), fitrim, uintptr(unsafe.Pointer(&trim))); errno != 0 {
		return 0, fmt.Errorf("trim %s: %w", path, errno)
	}
	return int64(trim.Len), nil
}
