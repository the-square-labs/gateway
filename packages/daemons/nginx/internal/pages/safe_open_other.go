//go:build !darwin && !dragonfly && !freebsd && !linux && !netbsd && !openbsd && !solaris

package pages

import "os"

func openNoFollow(path string, flags int, mode os.FileMode) (*os.File, error) {
	info, err := os.Lstat(path)
	if err != nil && !os.IsNotExist(err) {
		return nil, err
	}
	if err == nil && info.Mode()&os.ModeSymlink != 0 {
		return nil, errUnsafePagesPath
	}
	return os.OpenFile(path, flags, mode)
}
