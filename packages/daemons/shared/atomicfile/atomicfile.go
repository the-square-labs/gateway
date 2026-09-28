// Package atomicfile replaces files so that a crash, a power loss or a kill -9 at any moment leaves either the old
// or the new content, never an empty or partial file: the content goes to a temporary file in the same directory,
// is flushed to disk, then renamed over the target, and the directory entry is flushed too.
//
// A rename replaces the file's inode. A file bind-mounted into a running container keeps showing the old inode, so
// configuration a container reads live through a single-file bind mount is written in place instead.
package atomicfile

import (
	"errors"
	"os"
	"path/filepath"
)

// WriteFile replaces path with data, with permissions perm (not subject to the umask).
func WriteFile(path string, data []byte, perm os.FileMode) error {
	return Write(path, perm, func(file *os.File) error {
		_, err := file.Write(data)
		return err
	})
}

// Write replaces path with what write puts into the temporary file. write may also prepare the file through its
// name (ownership); it must not close it.
func Write(path string, perm os.FileMode, write func(*os.File) error) (err error) {
	directory := filepath.Dir(path)
	temporary, err := os.CreateTemp(directory, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer func() {
		if err != nil {
			_ = os.Remove(name)
		}
	}()
	if err = temporary.Chmod(perm); err == nil {
		err = write(temporary)
	}
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(name, path); err != nil {
		return err
	}
	return SyncDir(directory)
}

// SyncDir flushes a directory's entries (a rename or a removal in it) to disk.
func SyncDir(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	err = directory.Sync()
	if closeErr := directory.Close(); err == nil {
		err = closeErr
	}
	if errors.Is(err, os.ErrInvalid) {
		// Some filesystems cannot sync a directory; the rename itself stays atomic.
		return nil
	}
	return err
}
