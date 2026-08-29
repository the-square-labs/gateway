package docker

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	mobyclient "github.com/moby/moby/client"
	"golang.org/x/sys/unix"
)

func (m *managedDatabaseManager) ensureCapacity(bytes int64) error {
	var stat unix.Statfs_t
	if err := unix.Statfs(m.root, &stat); err != nil {
		return fmt.Errorf("stat database storage: %w", err)
	}
	free := int64(stat.Bavail) * int64(stat.Bsize)
	if free < bytes || free-bytes < m.reserve {
		return fmt.Errorf("insufficient database storage capacity after reserve")
	}
	return nil
}

func (m *managedDatabaseManager) createImage(ctx context.Context, record managedDatabaseRecord) error {
	file, err := os.OpenFile(record.ImagePath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return fmt.Errorf("create storage image: %w", err)
	}
	defer file.Close()
	if output, err := exec.CommandContext(ctx, "fallocate", "-l", fmt.Sprintf("%d", record.StorageSize), record.ImagePath).CombinedOutput(); err != nil {
		return fmt.Errorf("preallocate non-sparse storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync storage image: %w", err)
	}
	if output, err := exec.CommandContext(ctx, "mkfs.ext4", "-q", "-F", record.ImagePath).CombinedOutput(); err != nil {
		return fmt.Errorf("format database storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (m *managedDatabaseManager) ensureMounted(ctx context.Context, record *managedDatabaseRecord) error {
	if mounted(record.MountPath) {
		return nil
	}
	if err := os.MkdirAll(record.MountPath, 0700); err != nil {
		return fmt.Errorf("create database mount point: %w", err)
	}
	loopDevice, err := attachDatabaseLoopDevice(ctx, record.ImagePath)
	if err != nil {
		return err
	}
	record.LoopDevice = loopDevice
	if record.LoopDevice == "" {
		return errors.New("losetup did not return a loop device")
	}
	if output, err := exec.CommandContext(ctx, "mount", "-o", "noatime", record.LoopDevice, record.MountPath).CombinedOutput(); err != nil {
		_ = exec.Command("losetup", "-d", record.LoopDevice).Run()
		record.LoopDevice = ""
		return fmt.Errorf("mount database storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// ensureStorageSize converges both layers of the managed database volume: the
// backing image and the mounted ext4 filesystem. A loop device caches the
// backing file capacity, so it must be refreshed after fallocate before
// resize2fs can see the new space.
func (m *managedDatabaseManager) ensureStorageSize(ctx context.Context, record *managedDatabaseRecord, targetSize int64) error {
	if err := m.ensureMounted(ctx, record); err != nil {
		return err
	}
	info, err := os.Stat(record.ImagePath)
	if err != nil {
		return fmt.Errorf("stat managed database storage image: %w", err)
	}
	if targetSize < info.Size() {
		return errors.New("managed database storage cannot be reduced")
	}
	if targetSize > info.Size() {
		if err := m.ensureCapacity(targetSize - info.Size()); err != nil {
			return err
		}
		if output, err := exec.CommandContext(ctx, "fallocate", "-l", fmt.Sprintf("%d", targetSize), record.ImagePath).CombinedOutput(); err != nil {
			return fmt.Errorf("grow managed database storage image: %w: %s", err, strings.TrimSpace(string(output)))
		}
	}
	if err := refreshDatabaseLoopDeviceCapacity(ctx, record.LoopDevice); err != nil {
		return err
	}
	if output, err := exec.CommandContext(ctx, "resize2fs", record.LoopDevice).CombinedOutput(); err != nil {
		return fmt.Errorf("grow managed database filesystem: %w: %s", err, strings.TrimSpace(string(output)))
	}
	record.StorageSize = targetSize
	return nil
}

func refreshDatabaseLoopDeviceCapacity(ctx context.Context, loopDevice string) error {
	if loopDevice == "" {
		return errors.New("managed database loop device is not attached")
	}
	if output, err := exec.CommandContext(ctx, "losetup", "-c", loopDevice).CombinedOutput(); err != nil {
		return fmt.Errorf("refresh managed database loop device capacity: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func attachDatabaseLoopDevice(ctx context.Context, imagePath string) (string, error) {
	output, err := exec.CommandContext(ctx, "losetup", "--find", "--show", "--nooverlap", imagePath).CombinedOutput()
	if err == nil {
		loopDevice := loopDeviceFromLosetupOutput(output)
		if loopDevice == "" {
			return "", errors.New("losetup did not return a loop device")
		}
		return loopDevice, nil
	}

	// Restricted LXC guests can expose a bounded set of loop block devices
	// while the shared kernel's /dev/loop-control still reports an earlier,
	// guest-invisible device. In that topology --find fails even though one of
	// the explicitly delegated loop devices is free. Fall back to the visible
	// device nodes without weakening the ordinary host path above.
	if loopDevice, visibleErr := attachVisibleDatabaseLoopDevice(ctx, imagePath); visibleErr == nil {
		return loopDevice, nil
	}

	// Minimal BusyBox images do not implement GNU's --find/--show flags. The
	// database installer supports regular Ubuntu hosts first, and falls back to
	// the portable two-step form for these local/DIND environments.
	if !strings.Contains(strings.ToLower(string(output)), "unrecognized option") {
		return "", fmt.Errorf("attach database storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	found, findErr := exec.CommandContext(ctx, "losetup", "-f").CombinedOutput()
	if findErr != nil {
		return "", fmt.Errorf("find free database loop device: %w: %s", findErr, strings.TrimSpace(string(found)))
	}
	loopDevice := loopDeviceFromLosetupOutput(found)
	if loopDevice == "" {
		return "", errors.New("losetup did not return a free loop device")
	}
	if attached, attachErr := exec.CommandContext(ctx, "losetup", loopDevice, imagePath).CombinedOutput(); attachErr != nil {
		return "", fmt.Errorf("attach database storage image: %w: %s", attachErr, strings.TrimSpace(string(attached)))
	}
	return loopDevice, nil
}

func attachVisibleDatabaseLoopDevice(ctx context.Context, imagePath string) (string, error) {
	candidates, err := filepath.Glob("/dev/loop[0-9]*")
	if err != nil {
		return "", fmt.Errorf("list visible database loop devices: %w", err)
	}
	sort.Strings(candidates)
	return attachDatabaseLoopDeviceFromCandidates(ctx, imagePath, candidates)
}

func attachDatabaseLoopDeviceFromCandidates(ctx context.Context, imagePath string, candidates []string) (string, error) {
	visible := make(map[string]struct{}, len(candidates))
	for _, candidate := range candidates {
		visible[candidate] = struct{}{}
	}

	if output, err := exec.CommandContext(ctx, "losetup", "-j", imagePath).CombinedOutput(); err == nil {
		if existing := loopDeviceFromLosetupAssociation(output); existing != "" {
			if _, ok := visible[existing]; ok {
				return existing, nil
			}
		}
	}

	for _, candidate := range candidates {
		if output, err := exec.CommandContext(ctx, "losetup", candidate).CombinedOutput(); err == nil {
			continue
		} else if !strings.Contains(strings.ToLower(string(output)), "no such file or directory") &&
			!strings.Contains(strings.ToLower(string(output)), "no such device") {
			continue
		}
		if output, err := exec.CommandContext(ctx, "losetup", candidate, imagePath).CombinedOutput(); err == nil {
			return candidate, nil
		} else if !strings.Contains(strings.ToLower(string(output)), "device or resource busy") {
			continue
		}
	}
	return "", errors.New("no visible free database loop device is available")
}

func loopDeviceFromLosetupOutput(output []byte) string {
	for _, line := range strings.Split(string(output), "\n") {
		candidate := strings.TrimSpace(line)
		if strings.HasPrefix(candidate, "/dev/loop") && !strings.ContainsAny(candidate, " \t") {
			return candidate
		}
	}
	return ""
}

func loopDeviceFromLosetupAssociation(output []byte) string {
	for _, line := range strings.Split(string(output), "\n") {
		candidate, _, ok := strings.Cut(strings.TrimSpace(line), ":")
		if ok && strings.HasPrefix(candidate, "/dev/loop") && !strings.ContainsAny(candidate, " \t") {
			return candidate
		}
	}
	return ""
}

func mounted(path string) bool {
	return exec.Command("mountpoint", "-q", path).Run() == nil
}

func (m *managedDatabaseManager) createNetwork(ctx context.Context, name string) error {
	_, err := m.client.cli.NetworkInspect(ctx, name, mobyclient.NetworkInspectOptions{})
	if err == nil {
		return nil
	}
	_, err = m.client.cli.NetworkCreate(ctx, name, mobyclient.NetworkCreateOptions{
		Driver: "bridge",
		Labels: map[string]string{managedDatabaseLabel: name},
	})
	if err != nil {
		return fmt.Errorf("create managed database network: %w", err)
	}
	return nil
}
