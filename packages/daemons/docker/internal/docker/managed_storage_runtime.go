package docker

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"golang.org/x/sys/unix"
)

const managedStorageRootFilesystem = "gateway-managed-storage-root"

type managedStorageManager struct {
	client         *Client
	logger         *slog.Logger
	root           string
	reserve        int64
	statFilesystem func(string, *unix.Statfs_t) error
	// chown overrides runtime-user ownership changes (tests run unprivileged).
	chown func(string, int, int) error
	// probeServed overrides the served-certificate probe (tests).
	probeServed func(ctx context.Context, address, protocol string) (servedCertificate, error)
	mu          sync.Mutex
	// generations and tlsReloads let a certificate reload wait without mu
	// (see handleTLSReload); generations is guarded by mu.
	generations lifecycleGenerations
	tlsReloads  resourceLocks
}

// stageTLS writes the legacy MinIO certs directory. Every file is replaced
// through a temporary file and a rename: MinIO rereads the directory on
// SIGHUP, and an in-place truncate could expose a half-written key.
func (m *managedStorageManager) stageTLS(record managedStorageRecord, tlsConfig managedStorageTLS) (string, error) {
	directory := filepath.Join(m.root, "storage", "tls", fmt.Sprintf("%s-%d", record.ID, record.MemberIndex))
	if err := os.MkdirAll(filepath.Join(directory, "CAs"), 0700); err != nil {
		return "", err
	}
	for _, file := range []struct{ name, content string }{
		{"CAs/gateway-ca.crt", tlsConfig.CAPEM},
		{"private.key", tlsConfig.KeyPEM},
		{"public.crt", tlsConfig.CertPEM},
	} {
		if err := writeFileAtomically(filepath.Join(directory, file.name), []byte(file.content), 0600, nil); err != nil {
			return "", fmt.Errorf("stage managed storage TLS %s: %w", file.name, err)
		}
	}
	return directory, nil
}

func (m *managedStorageManager) stageSFTPHostKey(record managedStorageRecord, hostKeyPEM string) (string, error) {
	directory := filepath.Join(m.root, "storage", "sftp", fmt.Sprintf("%s-%d", record.ID, record.MemberIndex))
	if err := os.MkdirAll(directory, 0700); err != nil {
		return "", err
	}
	path := filepath.Join(directory, "host-key")
	if err := os.WriteFile(path, []byte(hostKeyPEM), 0600); err != nil {
		return "", fmt.Errorf("stage managed storage SFTP host key: %w", err)
	}
	return path, nil
}

func (m *managedStorageManager) ensureCapacity(bytes int64) error {
	var stat unix.Statfs_t
	if err := m.filesystemStats(m.root, &stat); err != nil {
		return fmt.Errorf("stat storage root: %w", err)
	}
	free := int64(stat.Bavail) * int64(stat.Bsize)
	if free < bytes || free-bytes < m.reserve {
		return errors.New("insufficient managed storage capacity after reserve")
	}
	return nil
}

func (m *managedStorageManager) filesystemStats(path string, stat *unix.Statfs_t) error {
	if m.statFilesystem != nil {
		return m.statFilesystem(path, stat)
	}
	return unix.Statfs(path, stat)
}

func (m *managedStorageManager) storageRootHealthMount() (*pb.DiskMount, error) {
	var stat unix.Statfs_t
	if err := m.filesystemStats(m.root, &stat); err != nil {
		return nil, fmt.Errorf("stat managed storage root for health: %w", err)
	}
	blockSize := int64(stat.Bsize)
	total := int64(stat.Blocks) * blockSize
	free := int64(stat.Bavail) * blockSize
	// The wizard must not advertise bytes reserved for recovery and other
	// storage-manager work. This marker is explicitly allocatable capacity;
	// managed workload mounts below remain raw ext4 filesystem metrics.
	allocatable := max(int64(0), free-m.reserve)
	used := total - allocatable
	usagePercent := 0.0
	if total > 0 {
		usagePercent = float64(used) / float64(total) * 100
	}
	return &pb.DiskMount{
		MountPoint:   m.root,
		Filesystem:   managedStorageRootFilesystem,
		TotalBytes:   total,
		UsedBytes:    used,
		FreeBytes:    allocatable,
		UsagePercent: usagePercent,
	}, nil
}

func (m *managedStorageManager) createImage(ctx context.Context, record managedStorageRecord) error {
	file, err := os.OpenFile(record.ImagePath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return fmt.Errorf("create managed storage image: %w", err)
	}
	defer file.Close()
	if output, err := exec.CommandContext(ctx, "fallocate", "-l", fmt.Sprintf("%d", record.StorageBytes), record.ImagePath).CombinedOutput(); err != nil {
		return fmt.Errorf("preallocate managed storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync managed storage image: %w", err)
	}
	args := []string{"-q", "-F"}
	if record.engine() == managedStorageEngineSeaweedFS {
		// SeaweedFS runs unprivileged, so root-reserved blocks would only be
		// unusable space; its own minFreeSpace guard keeps metadata headroom.
		args = append(args, "-m", "0")
	}
	if output, err := exec.CommandContext(ctx, "mkfs.ext4", append(args, record.ImagePath)...).CombinedOutput(); err != nil {
		return fmt.Errorf("format managed storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (m *managedStorageManager) ensureMounted(ctx context.Context, record *managedStorageRecord) error {
	if mounted(record.MountPath) {
		return nil
	}
	if err := os.MkdirAll(record.MountPath, 0700); err != nil {
		return err
	}
	loop, err := attachDatabaseLoopDevice(ctx, record.ImagePath)
	if err != nil {
		return err
	}
	record.LoopDevice = loop
	if output, err := exec.CommandContext(ctx, "mount", "-o", "noatime", loop, record.MountPath).CombinedOutput(); err != nil {
		_ = exec.Command("losetup", "-d", loop).Run()
		record.LoopDevice = ""
		return fmt.Errorf("mount managed storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (m *managedStorageManager) ensureStorageSize(ctx context.Context, record *managedStorageRecord, target int64) error {
	if err := m.ensureMounted(ctx, record); err != nil {
		return err
	}
	info, err := os.Stat(record.ImagePath)
	if err != nil {
		return err
	}
	if target < info.Size() {
		return errors.New("managed storage cannot be reduced")
	}
	if target == info.Size() {
		return nil
	}
	if err := m.ensureCapacity(target - info.Size()); err != nil {
		return err
	}
	if output, err := exec.CommandContext(ctx, "fallocate", "-l", fmt.Sprintf("%d", target), record.ImagePath).CombinedOutput(); err != nil {
		return fmt.Errorf("grow managed storage image: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if output, err := exec.CommandContext(ctx, "losetup", "-c", record.LoopDevice).CombinedOutput(); err != nil {
		return fmt.Errorf("refresh managed storage loop device: %w: %s", err, strings.TrimSpace(string(output)))
	}
	if output, err := exec.CommandContext(ctx, "resize2fs", record.LoopDevice).CombinedOutput(); err != nil {
		return fmt.Errorf("resize managed storage filesystem: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func (m *managedStorageManager) startContainer(ctx context.Context, id string) error {
	inspect, err := m.client.cli.ContainerInspect(ctx, id, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return err
	}
	if inspect.Container.State != nil && inspect.Container.State.Running {
		return nil
	}
	if _, err := m.client.cli.ContainerStart(ctx, id, mobyclient.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("start managed storage container: %w", err)
	}
	return nil
}

func (m *managedStorageManager) createNetwork(ctx context.Context, record managedStorageRecord) error {
	_, err := m.client.cli.NetworkInspect(ctx, record.NetworkName, mobyclient.NetworkInspectOptions{})
	if err == nil {
		return nil
	}
	_, err = m.client.cli.NetworkCreate(ctx, record.NetworkName, mobyclient.NetworkCreateOptions{Driver: "bridge", Internal: !record.PublishS3 && record.PeerBindAddress == "", Labels: map[string]string{managedStorageLabel: record.ID}})
	if err != nil {
		return fmt.Errorf("create managed storage network: %w", err)
	}
	return nil
}

func (m *managedStorageManager) remove(ctx context.Context, record *managedStorageRecord, deleteData bool) error {
	if record.ContainerID != "" {
		if err := m.client.RemoveContainer(ctx, record.ContainerID, true); err != nil && !isNotFoundErr(err) {
			return err
		}
	}
	if record.NetworkName != "" {
		_, _ = m.client.cli.NetworkRemove(ctx, record.NetworkName, mobyclient.NetworkRemoveOptions{})
	}
	record.DesiredRunning = false
	record.Removed = true
	record.ContainerID = ""
	// A removed workload cannot be started again, so staged secrets (root
	// identity, TLS keys, SFTP host key) have no further use.
	if record.engine() == managedStorageEngineSeaweedFS {
		if err := m.removeSeaweedFSStaging(*record); err != nil {
			return err
		}
	}
	if deleteData {
		for _, directory := range []string{"tls", "sftp"} {
			_ = os.RemoveAll(filepath.Join(m.root, "storage", directory, fmt.Sprintf("%s-%d", record.ID, record.MemberIndex)))
		}
		return m.cleanupStorage(ctx, record, true)
	}
	return m.saveRecord(*record)
}

func (m *managedStorageManager) cleanupStorage(ctx context.Context, record *managedStorageRecord, removeImage bool) error {
	if mounted(record.MountPath) {
		if output, err := exec.CommandContext(ctx, "umount", record.MountPath).CombinedOutput(); err != nil {
			return fmt.Errorf("unmount managed storage: %w: %s", err, strings.TrimSpace(string(output)))
		}
	}
	if record.LoopDevice != "" {
		_ = exec.CommandContext(ctx, "losetup", "-d", record.LoopDevice).Run()
	}
	if removeImage {
		if err := os.Remove(record.ImagePath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		_ = os.Remove(record.MountPath)
		if err := os.Remove(m.recordPath(record.ID)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func (m *managedStorageManager) reconcile(ctx context.Context) error {
	entries, err := os.ReadDir(filepath.Join(m.root, "storage", "records"))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		record, err := m.loadRecord(strings.TrimSuffix(entry.Name(), ".json"))
		if err != nil {
			return err
		}
		if record.Removed || !record.DesiredRunning {
			continue
		}
		if err := m.ensureMounted(ctx, &record); err != nil {
			return err
		}
		if err := m.startContainer(ctx, record.ContainerID); err != nil {
			return err
		}
		if err := m.saveRecord(record); err != nil {
			return err
		}
	}
	return nil
}

func (m *managedStorageManager) recordPath(id string) string {
	return filepath.Join(m.root, "storage", "records", id+".json")
}
func (m *managedStorageManager) loadRecord(id string) (managedStorageRecord, error) {
	raw, err := os.ReadFile(m.recordPath(id))
	if err != nil {
		return managedStorageRecord{}, err
	}
	var record managedStorageRecord
	if err := json.Unmarshal(raw, &record); err != nil {
		return managedStorageRecord{}, fmt.Errorf("decode managed storage record: %w", err)
	}
	if record.ID != id || !managedStorageIDPattern.MatchString(record.ID) {
		return managedStorageRecord{}, errors.New("managed storage record identity is invalid")
	}
	return record, nil
}
func (m *managedStorageManager) saveRecord(record managedStorageRecord) error {
	raw, err := json.Marshal(record)
	if err != nil {
		return err
	}
	temporary := m.recordPath(record.ID) + ".pending"
	if err := os.WriteFile(temporary, raw, 0600); err != nil {
		return err
	}
	return os.Rename(temporary, m.recordPath(record.ID))
}
func (m *managedStorageManager) storageStatus(ctx context.Context, record managedStorageRecord) string {
	if record.Removed {
		return "deleted"
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil || inspect.Container.State == nil || !inspect.Container.State.Running {
		return "stopped"
	}
	if err := m.checkReady(ctx, record); err != nil {
		return "starting"
	}
	return "ready"
}

func (m *managedStorageManager) waitForReady(ctx context.Context, record managedStorageRecord) error {
	timeout := 90 * time.Second
	if record.engine() == managedStorageEngineSeaweedFS {
		timeout = seaweedfsReadyTimeout
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	var lastErr error
	for {
		if err := m.checkReady(ctx, record); err == nil {
			return nil
		} else {
			lastErr = err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("managed storage readiness check timed out: %w", lastErr)
		case <-ticker.C:
		}
	}
}

func managedStorageHealthPath(record managedStorageRecord) string {
	if record.engine() == managedStorageEngineSeaweedFS {
		return "/healthz"
	}
	if record.MemberCount > 1 {
		return "/minio/health/cluster"
	}
	return "/minio/health/ready"
}

func (m *managedStorageManager) checkReady(ctx context.Context, record managedStorageRecord) error {
	if record.engine() == managedStorageEngineSeaweedFS {
		return m.checkSeaweedFSReady(ctx, record)
	}
	endpoint, err := m.privateEndpoint(ctx, record)
	if err != nil {
		return err
	}
	scheme := "http"
	transport := http.DefaultTransport.(*http.Transport).Clone()
	if record.TLSEnabled {
		caPEM, err := os.ReadFile(filepath.Join(m.root, "storage", "tls", fmt.Sprintf("%s-%d", record.ID, record.MemberIndex), "CAs", "gateway-ca.crt"))
		if err != nil {
			return fmt.Errorf("read managed storage health CA: %w", err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caPEM) {
			return errors.New("managed storage health CA is invalid")
		}
		transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool, ServerName: record.TLSServerName}
		scheme = "https"
	}
	return probeManagedStorageHealth(ctx, transport, scheme+"://"+endpoint+managedStorageHealthPath(record))
}

// checkSeaweedFSReady requires the in-container healthcheck (master leader,
// filer store, volume server, S3 listener) to report healthy and the S3
// listener to answer over the private network with the expected TLS identity.
func (m *managedStorageManager) checkSeaweedFSReady(ctx context.Context, record managedStorageRecord) error {
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil || inspect.Container.State == nil || !inspect.Container.State.Running {
		return errors.New("managed storage container is not running")
	}
	if inspect.Container.State.Health == nil || inspect.Container.State.Health.Status != container.Healthy {
		status := "unknown"
		if inspect.Container.State.Health != nil {
			status = string(inspect.Container.State.Health.Status)
		}
		return fmt.Errorf("managed storage container health is %s", status)
	}
	endpoint, err := m.privateEndpoint(ctx, record)
	if err != nil {
		return err
	}
	transport, scheme, err := m.seaweedfsTransport(record)
	if err != nil {
		return err
	}
	return probeManagedStorageHealth(ctx, transport, scheme+"://"+endpoint+managedStorageHealthPath(record))
}

func probeManagedStorageHealth(ctx context.Context, transport *http.Transport, target string) error {
	defer transport.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	response, err := (&http.Client{Transport: transport, Timeout: 3 * time.Second}).Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("managed storage health returned HTTP %d", response.StatusCode)
	}
	return nil
}
func (m *managedStorageManager) marshalManagedStorageDetail(ctx context.Context, record managedStorageRecord, status string) (string, error) {
	privateEndpoint := ""
	if !record.Removed && record.ContainerID != "" {
		if endpoint, err := m.privateEndpoint(ctx, record); err == nil {
			privateEndpoint = endpoint
		}
	}
	return jsonString(map[string]any{
		"status": status, "id": record.ID, "operationId": record.OperationID,
		"engine": record.engine(), "image": record.Image,
		"containerName": record.ContainerName, "memberIndex": record.MemberIndex,
		"privateEndpoint": privateEndpoint, "publishS3": record.PublishS3,
		"peerPublished": record.PeerBindAddress != "", "peerBindAddress": record.PeerBindAddress,
		"publishedPort": record.PublishedPort, "storageBytes": record.StorageBytes,
		"nanoCPUs": record.NanoCPUs, "memoryBytes": record.MemoryBytes,
		"memorySwapBytes": record.MemorySwapBytes, "ftpPort": record.FTPPort,
		"ftpPassivePortStart": record.FTPPassiveStart, "ftpPassivePortCount": record.FTPPassiveCount,
		"sftpPort": record.SFTPPort,
	})
}
func jsonString(value any) (string, error) { raw, err := json.Marshal(value); return string(raw), err }
