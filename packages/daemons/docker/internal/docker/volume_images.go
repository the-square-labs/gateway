package docker

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"maps"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/client"
	"golang.org/x/sys/unix"
)

const (
	managedVolumeStorageKindLabel = "com.wiolett.gateway.managed-volume-storage-kind"
	managedVolumeCapacityLabel    = "com.wiolett.gateway.managed-volume-capacity-bytes"
	volumeStorageKindRegular      = "regular"
	volumeStorageKindDiskImage    = "disk-image"
	minimumVolumeImageBytes       = int64(256 * 1024 * 1024)
	volumeImageReserveBytes       = int64(1024 * 1024 * 1024)
	volumeImageFstabPath          = "/etc/fstab"
)

type volumeImageRecord struct {
	Name          string `json:"name"`
	ImagePath     string `json:"imagePath"`
	MountPath     string `json:"mountPath"`
	LoopDevice    string `json:"loopDevice,omitempty"`
	CapacityBytes int64  `json:"capacityBytes"`
}

type volumeMetrics struct {
	StorageKind            string `json:"storageKind"`
	UsedBytes              *int64 `json:"usedBytes"`
	CapacityBytes          *int64 `json:"capacityBytes"`
	AvailableBytes         *int64 `json:"availableBytes"`
	UsedInodes             *int64 `json:"usedInodes"`
	TotalInodes            *int64 `json:"totalInodes"`
	RunningAttachmentCount int64  `json:"runningAttachmentCount"`
	CollectedAt            string `json:"collectedAt"`
}

type volumeImageManager struct {
	client    *Client
	logger    *slog.Logger
	root      string
	supported bool
	mu        sync.Mutex
}

func newVolumeImageManager(stateDir string, dockerClient *Client, logger *slog.Logger) (*volumeImageManager, error) {
	root := filepath.Clean(filepath.Join(stateDir, "volume-images"))
	manager := &volumeImageManager{client: dockerClient, logger: logger, root: root}
	if !filepath.IsAbs(root) || root == "/" {
		return nil, errors.New("volume image root must be an absolute non-root path")
	}
	for _, dir := range []string{"images", "mounts", "records"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			return nil, fmt.Errorf("create volume image directory: %w", err)
		}
	}
	manager.supported = manager.preflight()
	if manager.supported {
		if err := manager.reconcile(context.Background()); err != nil {
			manager.supported = false
			logger.Warn("disk-image volume support disabled after reconciliation failure", "error", err)
		}
	}
	return manager, nil
}

func (m *volumeImageManager) preflight() bool {
	if os.Geteuid() != 0 {
		return false
	}
	for _, binary := range []string{"fallocate", "findmnt", "mkfs.ext4", "losetup", "mount", "umount", "mountpoint", "resize2fs"} {
		if _, err := exec.LookPath(binary); err != nil {
			m.logger.Warn("disk-image volume support unavailable", "missing", binary)
			return false
		}
	}
	if _, err := os.Stat("/dev/loop-control"); err != nil {
		m.logger.Warn("disk-image volume support unavailable", "error", err)
		return false
	}
	fstab, err := os.OpenFile(volumeImageFstabPath, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		m.logger.Warn("disk-image volume support unavailable", "fstab", err)
		return false
	}
	_ = fstab.Close()
	probePath := filepath.Join(filepath.Dir(volumeImageFstabPath), fmt.Sprintf(".gateway-volume-images-probe-%d", os.Getpid()))
	probe, err := os.OpenFile(probePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		m.logger.Warn("disk-image volume support unavailable", "fstabDirectory", err)
		return false
	}
	_ = probe.Close()
	if err := os.Remove(probePath); err != nil {
		m.logger.Warn("disk-image volume support unavailable", "fstabDirectory", err)
		return false
	}
	return true
}

func (m *volumeImageManager) recordKey(name string) string {
	sum := sha256.Sum256([]byte(name))
	return hex.EncodeToString(sum[:])
}

func (m *volumeImageManager) recordPath(name string) string {
	return filepath.Join(m.root, "records", m.recordKey(name)+".json")
}

func (m *volumeImageManager) newRecord(name string, capacity int64) volumeImageRecord {
	key := m.recordKey(name)
	return volumeImageRecord{
		Name:          name,
		ImagePath:     filepath.Join(m.root, "images", key+".img"),
		MountPath:     filepath.Join(m.root, "mounts", key),
		CapacityBytes: capacity,
	}
}

func (m *volumeImageManager) saveRecord(record volumeImageRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	target := m.recordPath(record.Name)
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return err
	}
	return os.Rename(tmp, target)
}

func (m *volumeImageManager) loadRecord(name string) (volumeImageRecord, error) {
	data, err := os.ReadFile(m.recordPath(name))
	if err != nil {
		return volumeImageRecord{}, err
	}
	var record volumeImageRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return volumeImageRecord{}, fmt.Errorf("parse volume image record: %w", err)
	}
	if record.Name != name || !pathWithin(m.root, record.ImagePath) || !pathWithin(m.root, record.MountPath) {
		return volumeImageRecord{}, errors.New("invalid volume image record")
	}
	return record, nil
}

func pathWithin(root string, candidate string) bool {
	rel, err := filepath.Rel(root, candidate)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator))
}

func (m *volumeImageManager) ensureCapacity(bytes int64) error {
	var stat unix.Statfs_t
	if err := unix.Statfs(m.root, &stat); err != nil {
		return fmt.Errorf("stat volume image storage: %w", err)
	}
	free := int64(stat.Bavail) * int64(stat.Bsize)
	if free < bytes || free-bytes < volumeImageReserveBytes {
		return errors.New("insufficient node storage capacity after reserve")
	}
	return nil
}

func (m *volumeImageManager) create(ctx context.Context, name string, capacity int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.supported {
		return errors.New("disk-image volumes are not supported on this node")
	}
	if capacity < minimumVolumeImageBytes {
		return fmt.Errorf("disk-image volume capacity must be at least %d bytes", minimumVolumeImageBytes)
	}
	if _, err := m.loadRecord(name); err == nil {
		return fmt.Errorf("volume %q already exists", name)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if _, err := m.client.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{}); err == nil {
		return fmt.Errorf("volume %q already exists", name)
	} else if !cerrdefs.IsNotFound(err) {
		return fmt.Errorf("check existing volume %q: %w", name, err)
	}
	if err := m.ensureCapacity(capacity); err != nil {
		return err
	}
	record := m.newRecord(name, capacity)
	if err := os.MkdirAll(record.MountPath, 0700); err != nil {
		return err
	}
	if err := createVolumeImage(ctx, record); err != nil {
		_ = os.RemoveAll(record.MountPath)
		_ = os.Remove(record.ImagePath)
		return err
	}
	cleanup := true
	defer func() {
		if cleanup {
			_ = m.cleanupStorage(context.Background(), &record, true)
		}
	}()
	if err := m.saveRecord(record); err != nil {
		return fmt.Errorf("save volume image record: %w", err)
	}
	if err := m.ensureFstabEntry(record); err != nil {
		return fmt.Errorf("persist volume image mount: %w", err)
	}
	if err := m.ensureMounted(ctx, &record); err != nil {
		return err
	}
	if err := m.saveRecord(record); err != nil {
		return fmt.Errorf("save mounted volume image record: %w", err)
	}
	labels := volumeImageLabels(capacity)
	created, err := m.client.cli.VolumeCreate(ctx, client.VolumeCreateOptions{
		Name:       name,
		Driver:     "local",
		Labels:     labels,
		DriverOpts: map[string]string{"type": "none", "device": record.MountPath, "o": "bind"},
	})
	if err != nil {
		return fmt.Errorf("create disk-image Docker volume: %w", err)
	}
	if created.Volume.Labels[managedVolumeStorageKindLabel] != volumeStorageKindDiskImage {
		return fmt.Errorf("volume %q appeared concurrently and was left unchanged", name)
	}
	cleanup = false
	return nil
}

func volumeImageLabels(capacity int64) map[string]string {
	return map[string]string{
		managedVolumeLabel:            "true",
		managedVolumeOriginLabel:      "created",
		managedVolumeStorageKindLabel: volumeStorageKindDiskImage,
		managedVolumeCapacityLabel:    fmt.Sprintf("%d", capacity),
	}
}

func createVolumeImage(ctx context.Context, record volumeImageRecord) error {
	file, err := os.OpenFile(record.ImagePath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return fmt.Errorf("create volume storage image: %w", err)
	}
	_ = file.Close()
	if output, err := exec.CommandContext(ctx, "fallocate", "-l", fmt.Sprintf("%d", record.CapacityBytes), record.ImagePath).CombinedOutput(); err != nil {
		return fmt.Errorf("preallocate volume storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if output, err := exec.CommandContext(ctx, "mkfs.ext4", "-q", "-F", record.ImagePath).CombinedOutput(); err != nil {
		return fmt.Errorf("format volume storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (m *volumeImageManager) ensureMounted(ctx context.Context, record *volumeImageRecord) error {
	if mounted(record.MountPath) {
		output, err := exec.CommandContext(ctx, "findmnt", "-n", "-o", "SOURCE", "--target", record.MountPath).CombinedOutput()
		if err != nil {
			return fmt.Errorf("resolve mounted volume image device: %w: %s", err, strings.TrimSpace(string(output)))
		}
		loopDevice := strings.TrimSpace(string(output))
		if !strings.HasPrefix(loopDevice, "/dev/loop") || strings.ContainsAny(loopDevice, " \t\n") {
			return fmt.Errorf("unexpected mounted volume image device %q", loopDevice)
		}
		record.LoopDevice = loopDevice
		return nil
	}
	if err := os.MkdirAll(record.MountPath, 0700); err != nil {
		return err
	}
	loopDevice, err := attachDatabaseLoopDevice(ctx, record.ImagePath)
	if err != nil {
		return err
	}
	record.LoopDevice = loopDevice
	if output, err := exec.CommandContext(ctx, "mount", "-o", "noatime,nodev,nosuid", loopDevice, record.MountPath).CombinedOutput(); err != nil {
		_ = exec.Command("losetup", "-d", loopDevice).Run()
		record.LoopDevice = ""
		return fmt.Errorf("mount volume storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (m *volumeImageManager) reconcile(ctx context.Context) error {
	entries, err := os.ReadDir(filepath.Join(m.root, "records"))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(m.root, "records", entry.Name()))
		if err != nil {
			return err
		}
		var record volumeImageRecord
		if err := json.Unmarshal(data, &record); err != nil {
			return err
		}
		if entry.Name() != filepath.Base(m.recordPath(record.Name)) ||
			!pathWithin(m.root, record.ImagePath) ||
			!pathWithin(m.root, record.MountPath) {
			return fmt.Errorf("invalid disk-image volume record %q", entry.Name())
		}
		if err := m.ensureFstabEntry(record); err != nil {
			return fmt.Errorf("persist disk-image volume %q mount: %w", record.Name, err)
		}
		if err := m.ensureMounted(ctx, &record); err != nil {
			return fmt.Errorf("restore disk-image volume %q: %w", record.Name, err)
		}
		if err := m.saveRecord(record); err != nil {
			return err
		}
	}
	return nil
}

func (m *volumeImageManager) resize(ctx context.Context, name string, target int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(name)
	if err != nil {
		return fmt.Errorf("load disk-image volume: %w", err)
	}
	if target <= record.CapacityBytes {
		return errors.New("disk-image volume capacity can only be increased")
	}
	if err := m.ensureCapacity(target - record.CapacityBytes); err != nil {
		return err
	}
	if err := m.ensureMounted(ctx, &record); err != nil {
		return err
	}
	if output, err := exec.CommandContext(ctx, "fallocate", "-l", fmt.Sprintf("%d", target), record.ImagePath).CombinedOutput(); err != nil {
		return fmt.Errorf("grow volume storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if err := refreshDatabaseLoopDeviceCapacity(ctx, record.LoopDevice); err != nil {
		return err
	}
	if output, err := exec.CommandContext(ctx, "resize2fs", record.LoopDevice).CombinedOutput(); err != nil {
		return fmt.Errorf("grow volume filesystem: %w: %s", err, strings.TrimSpace(string(output)))
	}
	record.CapacityBytes = target
	if err := m.saveRecord(record); err != nil {
		return err
	}
	return nil
}

func (m *volumeImageManager) recreateDefinition(ctx context.Context, record volumeImageRecord, labels map[string]string) error {
	inspected, err := m.client.cli.VolumeInspect(ctx, record.Name, client.VolumeInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect disk-image volume: %w", err)
	}
	originalLabels := maps.Clone(inspected.Volume.Labels)
	if labels == nil {
		labels = maps.Clone(originalLabels)
	}
	labels[managedVolumeLabel] = "true"
	labels[managedVolumeOriginLabel] = "created"
	labels[managedVolumeStorageKindLabel] = volumeStorageKindDiskImage
	labels[managedVolumeCapacityLabel] = fmt.Sprintf("%d", record.CapacityBytes)
	if _, err := m.client.cli.VolumeRemove(ctx, record.Name, client.VolumeRemoveOptions{}); err != nil {
		return fmt.Errorf("remove disk-image volume definition: %w", err)
	}
	_, err = m.client.cli.VolumeCreate(ctx, client.VolumeCreateOptions{
		Name: record.Name, Driver: "local", Labels: labels,
		DriverOpts: map[string]string{"type": "none", "device": record.MountPath, "o": "bind"},
	})
	if err != nil {
		_, restoreErr := m.client.cli.VolumeCreate(context.Background(), client.VolumeCreateOptions{
			Name: record.Name, Driver: "local", Labels: originalLabels,
			DriverOpts: map[string]string{"type": "none", "device": record.MountPath, "o": "bind"},
		})
		if restoreErr != nil {
			return fmt.Errorf("update disk-image volume definition: %w; restore failed: %v", err, restoreErr)
		}
		return fmt.Errorf("update disk-image volume definition: %w", err)
	}
	return nil
}

func (m *volumeImageManager) rename(ctx context.Context, name string, newName string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(name)
	if err != nil {
		return err
	}
	if used, err := m.client.volumeInUse(ctx, name); err != nil {
		return err
	} else if used {
		return fmt.Errorf("volume %q is in use by containers and cannot be renamed", name)
	}
	if _, err := m.client.cli.VolumeInspect(ctx, newName, client.VolumeInspectOptions{}); err == nil {
		return fmt.Errorf("target volume %q already exists", newName)
	} else if !cerrdefs.IsNotFound(err) {
		return fmt.Errorf("check target volume %q: %w", newName, err)
	}
	source, err := m.client.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect disk-image volume: %w", err)
	}
	if _, err := m.client.cli.VolumeCreate(ctx, client.VolumeCreateOptions{
		Name: newName, Driver: "local", Labels: maps.Clone(source.Volume.Labels),
		DriverOpts: map[string]string{"type": "none", "device": record.MountPath, "o": "bind"},
	}); err != nil {
		return fmt.Errorf("create renamed disk-image volume: %w", err)
	}
	if _, err := m.client.cli.VolumeRemove(ctx, name, client.VolumeRemoveOptions{}); err != nil {
		_, _ = m.client.cli.VolumeRemove(context.Background(), newName, client.VolumeRemoveOptions{Force: true})
		return fmt.Errorf("remove old disk-image volume definition: %w", err)
	}
	oldRecordPath := m.recordPath(name)
	record.Name = newName
	if err := m.saveRecord(record); err != nil {
		return fmt.Errorf("save renamed disk-image volume record: %w", err)
	}
	if err := os.Remove(oldRecordPath); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (m *volumeImageManager) updateLabels(ctx context.Context, name string, labels map[string]string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(name)
	if err != nil {
		return err
	}
	if used, err := m.client.volumeInUse(ctx, name); err != nil {
		return err
	} else if used {
		return fmt.Errorf("volume %q is in use by containers and cannot update labels", name)
	}
	current, err := m.client.cli.VolumeInspect(ctx, name, client.VolumeInspectOptions{})
	if err != nil {
		return err
	}
	next := maps.Clone(labels)
	if next == nil {
		next = map[string]string{}
	}
	for _, key := range []string{managedVolumeLabel, managedVolumeOriginLabel, managedVolumeStorageKindLabel, managedVolumeCapacityLabel} {
		if supplied, ok := next[key]; ok && supplied != current.Volume.Labels[key] {
			return fmt.Errorf("label %q is reserved for Gateway-managed volumes", key)
		}
		next[key] = current.Volume.Labels[key]
	}
	return m.recreateDefinition(ctx, record, next)
}

func (m *volumeImageManager) remove(ctx context.Context, name string, force bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(name)
	if err != nil {
		return err
	}
	if _, err := m.client.cli.VolumeRemove(ctx, name, client.VolumeRemoveOptions{Force: force}); err != nil && !cerrdefs.IsNotFound(err) {
		return fmt.Errorf("volume remove: %w", err)
	}
	return m.cleanupStorage(ctx, &record, true)
}

func (m *volumeImageManager) cleanupStorage(ctx context.Context, record *volumeImageRecord, removeImage bool) error {
	if mounted(record.MountPath) {
		if output, err := exec.CommandContext(ctx, "umount", record.MountPath).CombinedOutput(); err != nil {
			return fmt.Errorf("unmount volume storage image: %w: %s", err, strings.TrimSpace(string(output)))
		}
	}
	if record.LoopDevice != "" {
		if output, err := exec.CommandContext(ctx, "losetup", "-d", record.LoopDevice).CombinedOutput(); err != nil {
			return fmt.Errorf("detach volume storage image: %w: %s", err, strings.TrimSpace(string(output)))
		}
	}
	if removeImage {
		if err := m.removeFstabEntry(*record); err != nil {
			return fmt.Errorf("remove volume image mount persistence: %w", err)
		}
		if err := os.Remove(record.ImagePath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		_ = os.RemoveAll(record.MountPath)
		if err := os.Remove(m.recordPath(record.Name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func volumeImageFstabMarker(record volumeImageRecord) string {
	return "# gateway-volume-image " + filepath.Base(record.ImagePath)
}

func escapeFstabPath(value string) string {
	replacer := strings.NewReplacer("\\", `\134`, " ", `\040`, "\t", `\011`, "\n", `\012`)
	return replacer.Replace(value)
}

func volumeImageFstabEntryLine(record volumeImageRecord) string {
	return fmt.Sprintf(
		"%s %s ext4 loop,noatime,nodev,nosuid,nofail 0 0",
		escapeFstabPath(record.ImagePath),
		escapeFstabPath(record.MountPath),
	)
}

func (m *volumeImageManager) ensureFstabEntry(record volumeImageRecord) error {
	data, err := os.ReadFile(volumeImageFstabPath)
	if err != nil {
		return err
	}
	marker := volumeImageFstabMarker(record)
	entryLine := volumeImageFstabEntryLine(record)
	if strings.Contains(string(data), marker+"\n"+entryLine+"\n") {
		return nil
	}
	entry := fmt.Sprintf("%s\n%s\n", marker, entryLine)
	separator := ""
	if len(data) > 0 && data[len(data)-1] != '\n' {
		separator = "\n"
	}
	return replaceFstab(append(append(data, separator...), entry...))
}

func (m *volumeImageManager) removeFstabEntry(record volumeImageRecord) error {
	data, err := os.ReadFile(volumeImageFstabPath)
	if err != nil {
		return err
	}
	marker := volumeImageFstabMarker(record)
	entry := volumeImageFstabEntryLine(record)
	lines := strings.Split(string(data), "\n")
	filtered := make([]string, 0, len(lines))
	for index := 0; index < len(lines); index++ {
		if lines[index] == marker {
			if index+1 < len(lines) && lines[index+1] == entry {
				index++
			}
			continue
		}
		filtered = append(filtered, lines[index])
	}
	return replaceFstab([]byte(strings.Join(filtered, "\n")))
}

func replaceFstab(data []byte) error {
	info, err := os.Stat(volumeImageFstabPath)
	if err != nil {
		return err
	}
	tmp := volumeImageFstabPath + ".gateway-volume-images.tmp"
	if err := os.WriteFile(tmp, data, info.Mode().Perm()); err != nil {
		return err
	}
	if err := os.Rename(tmp, volumeImageFstabPath); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func (m *volumeImageManager) metrics(ctx context.Context, name string) (volumeMetrics, error) {
	attachments, err := m.client.runningVolumeAttachments(ctx, name)
	if err != nil {
		return volumeMetrics{}, err
	}
	result := volumeMetrics{StorageKind: volumeStorageKindRegular, RunningAttachmentCount: attachments, CollectedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	record, err := m.loadRecord(name)
	if errors.Is(err, os.ErrNotExist) {
		used, usageErr := m.client.volumeDiskUsage(ctx, name)
		if usageErr == nil && used >= 0 {
			result.UsedBytes = &used
		}
		return result, nil
	}
	if err != nil {
		return volumeMetrics{}, err
	}
	var stat unix.Statfs_t
	if err := unix.Statfs(record.MountPath, &stat); err != nil {
		return volumeMetrics{}, fmt.Errorf("stat disk-image volume: %w", err)
	}
	capacity := int64(stat.Blocks) * int64(stat.Bsize)
	available := int64(stat.Bavail) * int64(stat.Bsize)
	used := capacity - int64(stat.Bfree)*int64(stat.Bsize)
	totalInodes := int64(stat.Files)
	usedInodes := totalInodes - int64(stat.Ffree)
	result.StorageKind = volumeStorageKindDiskImage
	result.UsedBytes = &used
	result.CapacityBytes = &capacity
	result.AvailableBytes = &available
	result.UsedInodes = &usedInodes
	result.TotalInodes = &totalInodes
	return result, nil
}
