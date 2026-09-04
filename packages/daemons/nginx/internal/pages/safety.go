package pages

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

var errUnsafePagesPath = errors.New("unsafe Pages storage path")

func ensureDirectory(path string, mode os.FileMode) error {
	cleaned := filepath.Clean(path)
	missing := make([]string, 0, 2)
	for current := cleaned; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		if err == nil {
			if err := validateDirectoryInfo(current, info); err != nil {
				return err
			}
			break
		}
		if !os.IsNotExist(err) {
			return err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return fmt.Errorf("%w: cannot create %s", errUnsafePagesPath, cleaned)
		}
		missing = append(missing, current)
	}
	for index := len(missing) - 1; index >= 0; index-- {
		current := missing[index]
		if err := os.Mkdir(current, mode); err != nil && !os.IsExist(err) {
			return err
		}
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		if err := validateDirectoryInfo(current, info); err != nil {
			return err
		}
	}
	return chmodNoFollowDirectory(cleaned, mode)
}

func validateDirectoryInfo(path string, info os.FileInfo) error {
	if info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("%w: symlink at %s", errUnsafePagesPath, path)
	}
	if !info.IsDir() {
		return fmt.Errorf("%w: non-directory at %s", errUnsafePagesPath, path)
	}
	return nil
}

func lstatRegular(path string) (os.FileInfo, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%w: symlink at %s", errUnsafePagesPath, path)
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: non-regular file at %s", errUnsafePagesPath, path)
	}
	return info, nil
}

func readFileNoFollow(path string) ([]byte, error) {
	if _, err := lstatRegular(path); err != nil {
		return nil, err
	}
	file, err := openNoFollow(path, os.O_RDONLY, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	if _, err := lstatRegularFile(file, path); err != nil {
		return nil, err
	}
	return io.ReadAll(file)
}

func chmodNoFollowRegular(path string, mode os.FileMode) error {
	if _, err := lstatRegular(path); err != nil {
		return err
	}
	file, err := openNoFollow(path, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := lstatRegularFile(file, path)
	if err != nil {
		return err
	}
	if info.Mode()&(os.ModePerm|os.ModeSetuid|os.ModeSetgid|os.ModeSticky) == mode {
		return nil
	}
	return file.Chmod(mode)
}

func chmodNoFollowDirectory(path string, mode os.FileMode) error {
	file, err := openNoFollow(path, os.O_RDONLY, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if err := validateDirectoryInfo(path, info); err != nil {
		return err
	}
	if info.Mode()&(os.ModePerm|os.ModeSetuid|os.ModeSetgid|os.ModeSticky) == mode {
		return nil
	}
	return file.Chmod(mode)
}

func lstatRegularFile(file *os.File, path string) (os.FileInfo, error) {
	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fmt.Errorf("%w: non-regular file at %s", errUnsafePagesPath, path)
	}
	return info, nil
}

func fileSHA256NoFollow(path string) (string, error) {
	if _, err := lstatRegular(path); err != nil {
		return "", err
	}
	file, err := openNoFollow(path, os.O_RDONLY, 0)
	if err != nil {
		return "", err
	}
	defer file.Close()
	if _, err := lstatRegularFile(file, path); err != nil {
		return "", err
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func fileSHA256Reader(file *os.File) (string, error) {
	if _, err := file.Seek(0, 0); err != nil {
		return "", err
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}
