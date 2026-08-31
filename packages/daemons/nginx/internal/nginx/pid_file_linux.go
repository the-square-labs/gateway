//go:build linux

package nginx

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

func trustedPIDOwner(uid uint32) bool {
	return uid == 0 || uid == uint32(os.Geteuid())
}

func validateTrustedPIDParents(parent string) error {
	current := string(filepath.Separator)
	for _, component := range strings.Split(strings.TrimPrefix(parent, string(filepath.Separator)), string(filepath.Separator)) {
		if component == "" {
			continue
		}
		current = filepath.Join(current, component)
		var stat unix.Stat_t
		if err := unix.Lstat(current, &stat); err != nil {
			return err
		}
		if stat.Mode&unix.S_IFMT != unix.S_IFDIR || !trustedPIDOwner(stat.Uid) || stat.Mode&0o022 != 0 {
			return fmt.Errorf("untrusted nginx pid parent %s", current)
		}
	}
	return nil
}

func readTrustedPIDFile(path string) ([]byte, time.Time, error) {
	resolvedParent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("resolve nginx pid parent: %w", err)
	}
	if !filepath.IsAbs(resolvedParent) {
		return nil, time.Time{}, errors.New("nginx pid parent is not absolute")
	}
	if err := validateTrustedPIDParents(resolvedParent); err != nil {
		return nil, time.Time{}, err
	}
	resolvedPath := filepath.Join(resolvedParent, filepath.Base(path))
	fd, err := unix.Open(resolvedPath, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("open authoritative nginx pid file: %w", err)
	}
	file := os.NewFile(uintptr(fd), resolvedPath)
	if file == nil {
		_ = unix.Close(fd)
		return nil, time.Time{}, errors.New("open authoritative nginx pid file")
	}
	defer file.Close()
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return nil, time.Time{}, fmt.Errorf("stat authoritative nginx pid file: %w", err)
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || !trustedPIDOwner(stat.Uid) || stat.Mode&0o022 != 0 {
		return nil, time.Time{}, errors.New("authoritative nginx pid file is not trusted")
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("read authoritative nginx pid file: %w", err)
	}
	return data, time.Unix(stat.Mtim.Sec, stat.Mtim.Nsec), nil
}
