//go:build linux

package nginx

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

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

func readTrustedPIDFile(path string) ([]byte, error) {
	resolvedParent, err := filepath.EvalSymlinks(filepath.Dir(path))
	if err != nil {
		return nil, fmt.Errorf("resolve nginx pid parent: %w", err)
	}
	if !filepath.IsAbs(resolvedParent) {
		return nil, errors.New("nginx pid parent is not absolute")
	}
	if err := validateTrustedPIDParents(resolvedParent); err != nil {
		return nil, err
	}
	resolvedPath := filepath.Join(resolvedParent, filepath.Base(path))
	fd, err := unix.Open(resolvedPath, unix.O_RDONLY|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0)
	if err != nil {
		return nil, fmt.Errorf("open authoritative nginx pid file: %w", err)
	}
	file := os.NewFile(uintptr(fd), resolvedPath)
	if file == nil {
		_ = unix.Close(fd)
		return nil, errors.New("open authoritative nginx pid file")
	}
	defer file.Close()
	var stat unix.Stat_t
	if err := unix.Fstat(fd, &stat); err != nil {
		return nil, fmt.Errorf("stat authoritative nginx pid file: %w", err)
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || !trustedPIDOwner(stat.Uid) || stat.Mode&0o022 != 0 || stat.Nlink != 1 {
		return nil, errors.New("authoritative nginx pid file is not trusted")
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, fmt.Errorf("read authoritative nginx pid file: %w", err)
	}
	return data, nil
}

// pidRuntimeDir is the only directory a pid directory is created in
// (replaceable in tests).
var pidRuntimeDir = "/run"

// createPIDDirectory creates the missing directory of pidFile as root, when
// it is a directory of /run (/var/run included), as the nginx service would
// at its start.
func createPIDDirectory(pidFile string) error {
	if pidRepairEUID() != 0 {
		return errors.New("only root creates nginx's pid directory")
	}
	directory := filepath.Dir(pidFile)
	parent, err := filepath.EvalSymlinks(filepath.Dir(directory))
	if err != nil {
		return err
	}
	if parent != pidRuntimeDir {
		return fmt.Errorf("nginx pid directory %s is not in %s", directory, pidRuntimeDir)
	}
	var stat unix.Stat_t
	if err := unix.Lstat(parent, &stat); err != nil {
		return err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFDIR || !trustedPIDOwner(stat.Uid) || stat.Mode&0o022 != 0 {
		return fmt.Errorf("untrusted nginx pid parent %s", parent)
	}
	parentFD, err := unix.Open(parent, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(parentFD)
	name := filepath.Base(directory)
	if err := unix.Mkdirat(parentFD, name, 0o755); err != nil {
		if errors.Is(err, unix.EEXIST) {
			return nil
		}
		return fmt.Errorf("create nginx pid directory %s: %w", directory, err)
	}
	created, err := unix.Openat(parentFD, name, unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(created)
	return unix.Fchmod(created, 0o755)
}

// removeForeignEmptyPIDFile removes an empty pid file the daemon cannot write
// from a pid directory that is the daemon's own, so nginx -t creates it again
// for the daemon's user. An empty pid file names no process.
func removeForeignEmptyPIDFile(pidFile string) error {
	directory, err := unix.Open(filepath.Dir(pidFile), unix.O_RDONLY|unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(directory)
	var stat unix.Stat_t
	if err := unix.Fstat(directory, &stat); err != nil {
		return err
	}
	euid := uint32(pidRepairEUID())
	if stat.Uid != euid {
		return errors.New("the nginx pid directory is not the daemon's")
	}
	name := filepath.Base(pidFile)
	if err := unix.Fstatat(directory, name, &stat, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	if stat.Mode&unix.S_IFMT != unix.S_IFREG || stat.Size != 0 || stat.Nlink != 1 {
		return errors.New("the nginx pid file is not an empty file")
	}
	if stat.Uid == euid && stat.Mode&0o200 != 0 {
		return errors.New("the nginx pid file is the daemon's")
	}
	return unix.Unlinkat(directory, name, 0)
}
