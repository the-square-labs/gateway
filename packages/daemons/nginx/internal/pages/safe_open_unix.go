//go:build darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package pages

import (
	"fmt"
	"os"

	"golang.org/x/sys/unix"
)

func openNoFollow(path string, flags int, mode os.FileMode) (*os.File, error) {
	fd, err := unix.Open(path, flags|unix.O_NOFOLLOW, uint32(mode.Perm()))
	if err != nil {
		return nil, &os.PathError{Op: "open", Path: path, Err: err}
	}
	file := os.NewFile(uintptr(fd), path)
	if file == nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("open %s without following symlinks: invalid file descriptor", path)
	}
	return file, nil
}
