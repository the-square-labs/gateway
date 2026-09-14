package docker

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/mount"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

const (
	backupStateDirectory = "backups"
	backupDefaultTimeout = time.Hour
	backupMaxTimeout     = 24 * time.Hour
	backupMaxWorkspace   = int64(1 << 40)
	backupMinWorkspace   = int64(1 << 30)
	backupResultMaxBytes = 512 * 1024
)

const (
	backupRunnerManagedLabel = "wiolett.gateway.managed"
	backupRunnerRunLabel     = "wiolett.gateway.backup-run-id"
)

type backupPayload struct {
	RunID                   string          `json:"runId"`
	Version                 int             `json:"version"`
	Direction               string          `json:"direction"`
	Engine                  string          `json:"engine"`
	Source                  backupEndpoint  `json:"source"`
	Destination             backupEndpoint  `json:"destination"`
	Staging                 *backupEndpoint `json:"staging,omitempty"`
	RestoreTarget           *backupEndpoint `json:"restoreTarget,omitempty"`
	Limits                  backupLimits    `json:"limits"`
	ToolImage               string          `json:"toolImage"`
	RestoreArtifact         json.RawMessage `json:"restoreArtifact,omitempty"`
	RedisStaging            *backupEndpoint `json:"redisStaging,omitempty"`
	RedisStageImage         string          `json:"redisStageImage,omitempty"`
	RedisStageAdvertiseHost string          `json:"redisStageAdvertiseHost,omitempty"`
}

type backupEndpoint struct {
	ConnectionID         string `json:"connectionId"`
	Provider             string `json:"provider,omitempty"`
	Host                 string `json:"host"`
	Port                 int    `json:"port"`
	Database             string `json:"database,omitempty"`
	Username             string `json:"username,omitempty"`
	Password             string `json:"password,omitempty"`
	TLS                  bool   `json:"tls,omitempty"`
	CAPEM                string `json:"caPem,omitempty"`
	ServerName           string `json:"serverName,omitempty"`
	Endpoint             string `json:"endpoint,omitempty"`
	NativeEndpoint       string `json:"nativeEndpoint,omitempty"`
	Region               string `json:"region,omitempty"`
	Bucket               string `json:"bucket,omitempty"`
	Prefix               string `json:"prefix,omitempty"`
	AccessKeyID          string `json:"accessKeyId,omitempty"`
	SecretAccessKey      string `json:"secretAccessKey,omitempty"`
	SessionToken         string `json:"sessionToken,omitempty"`
	PrivateKey           string `json:"privateKey,omitempty"`
	Passphrase           string `json:"passphrase,omitempty"`
	HostKeyFingerprint   string `json:"hostKeyFingerprint,omitempty"`
	BasePath             string `json:"basePath,omitempty"`
	ImplicitTLS          bool   `json:"implicitTls,omitempty"`
	ForcePathStyle       bool   `json:"forcePathStyle,omitempty"`
	RelayRouteID         string `json:"relayRouteId,omitempty"`
	ManagedDatabaseID    string `json:"managedDatabaseId,omitempty"`
	NewManagedDatabaseID string `json:"newManagedDatabaseId,omitempty"`
}

type backupLimits struct {
	WorkspaceBytes int64 `json:"workspaceBytes"`
	TimeoutSeconds int   `json:"timeoutSeconds"`
	CPUCores       int64 `json:"cpuCores"`
	MemoryMB       int64 `json:"memoryMb"`
}

type backupRunStatus struct {
	RunID          string          `json:"runId"`
	Status         string          `json:"status"`
	Phase          string          `json:"phase"`
	StartedAt      *time.Time      `json:"startedAt,omitempty"`
	CompletedAt    *time.Time      `json:"completedAt,omitempty"`
	Bytes          int64           `json:"bytes,omitempty"`
	Manifest       json.RawMessage `json:"manifest,omitempty"`
	Error          string          `json:"error,omitempty"`
	Fingerprint    string          `json:"fingerprint,omitempty"`
	ContainerID    string          `json:"containerId,omitempty"`
	CleanupPending bool            `json:"cleanupPending,omitempty"`
	CleanupError   string          `json:"cleanupError,omitempty"`
}

type backupRuntime struct {
	plugin *DockerPlugin
	root   string
	mu     sync.Mutex
	runs   map[string]*backupRunStatus
	cancel map[string]context.CancelFunc
}

// backupWorkspace is a non-sparse ext4 image in the same storage root and
// reservation domain as managed databases. A Docker bind mount alone cannot
// enforce workspaceBytes.
type backupWorkspace struct {
	imagePath  string
	mountPath  string
	loopDevice string
}

var backupRuntimes sync.Map // map[*DockerPlugin]*backupRuntime; avoids parent-owned DockerPlugin edits.

// Installed by the parent relay integration. It keeps this chunk compilable
// until relay_tunnel.go lands in this isolated worktree.
type BackupRelayOpen func(context.Context, *DockerPlugin, string, string) (string, func(), error)

var OpenBackupRelayRouteForBackup BackupRelayOpen = func(_ context.Context, _ *DockerPlugin, _ string, _ string) (string, func(), error) {
	return "", nil, errors.New("backup relay support is not integrated")
}

var backupWorkspaceUnmount = func(mountPath string) error {
	return exec.Command("umount", mountPath).Run()
}

var backupWorkspaceLoopDevice = func(imagePath string) (string, error) {
	output, err := exec.Command("losetup", "-j", imagePath).CombinedOutput()
	if err != nil {
		return "", err
	}
	return loopDeviceFromLosetupAssociation(output), nil
}

var backupWorkspaceDetach = func(loopDevice string) error {
	return exec.Command("losetup", "-d", loopDevice).Run()
}

func backupRuntimeFor(plugin *DockerPlugin) (*backupRuntime, error) {
	if plugin == nil || plugin.cfg == nil || plugin.client == nil {
		return nil, errors.New("backup runtime is not initialized")
	}
	if existing, ok := backupRuntimes.Load(plugin); ok {
		return existing.(*backupRuntime), nil
	}
	root := filepath.Join(plugin.cfg.StateDir, backupStateDirectory)
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, fmt.Errorf("create backup state directory: %w", err)
	}
	runtime := &backupRuntime{plugin: plugin, root: root, runs: map[string]*backupRunStatus{}, cancel: map[string]context.CancelFunc{}}
	runtime.reconcileWorkspaces()
	actual, _ := backupRuntimes.LoadOrStore(plugin, runtime)
	return actual.(*backupRuntime), nil
}

// A daemon restart can interrupt defer-based teardown. Only terminal or
// orphaned workspaces are reclaimed here; an active runner may still need its
// mounted ext4 image and is reconciled through its persisted status instead.
func (r *backupRuntime) reconcileWorkspaces() {
	if r.plugin.databaseManager == nil {
		return
	}
	imageDir := filepath.Join(r.plugin.databaseManager.root, "backups", "images")
	images, err := filepath.Glob(filepath.Join(imageDir, "*.img"))
	if err != nil {
		return
	}
	for _, imagePath := range images {
		runID := strings.TrimSuffix(filepath.Base(imagePath), ".img")
		status, statusErr := r.load(runID)
		if statusErr != nil {
			// A missing status must not be treated as an orphan until the Docker
			// ownership labels prove that no runner is still alive.
			if r.plugin.client == nil {
				continue
			}
			status, statusErr = r.status(runID)
		}
		if statusErr != nil || (status.Status != "completed" && status.Status != "failed" && status.Status != "cancelled") {
			continue
		}
		_, _ = r.reconcileTerminalCleanup(status, true)
	}
}

func (r *backupRuntime) removeWorkspace(runID, imagePath string) error {
	if r.plugin.databaseManager == nil {
		return errors.New("managed storage manager is not initialized")
	}
	r.plugin.databaseManager.mu.Lock()
	defer r.plugin.databaseManager.mu.Unlock()
	return r.removeWorkspaceLocked(runID, imagePath)
}

func (r *backupRuntime) removeWorkspaceLocked(runID, imagePath string) error {
	mountPath := filepath.Join(r.root, runID, "work")
	if mounted(mountPath) {
		if err := backupWorkspaceUnmount(mountPath); err != nil {
			return fmt.Errorf("unmount backup workspace: %w", err)
		}
	}
	loopDevice, err := backupWorkspaceLoopDevice(imagePath)
	if err != nil {
		return fmt.Errorf("inspect backup workspace loop device: %w", err)
	}
	if loopDevice != "" {
		if err := backupWorkspaceDetach(loopDevice); err != nil {
			return fmt.Errorf("detach backup workspace loop device: %w", err)
		}
	}
	if err := os.Remove(imagePath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove backup workspace image: %w", err)
	}
	if err := os.RemoveAll(filepath.Join(r.root, runID)); err != nil {
		return fmt.Errorf("remove backup workspace state: %w", err)
	}
	return nil
}

func (r *backupRuntime) apply(action, runID, raw string) (backupRunStatus, error) {
	if _, err := uuid.Parse(runID); err != nil {
		return backupRunStatus{}, errors.New("backup run id must be a UUID")
	}
	switch action {
	case "status":
		return r.status(runID)
	case "cancel":
		return r.cancelRun(runID)
	case "preflight", "start":
		payload, fingerprint, err := parseBackupPayload(raw)
		if err != nil {
			if action == "preflight" && payload.RunID == runID {
				if persistErr := r.persistPreflightFailure(runID, "validation", err); persistErr != nil {
					return backupRunStatus{}, persistErr
				}
			}
			return backupRunStatus{}, err
		}
		if payload.RunID != runID {
			if action == "preflight" {
				if persistErr := r.persistPreflightFailure(runID, "validation", errors.New("backup run id does not match immutable request")); persistErr != nil {
					return backupRunStatus{}, persistErr
				}
			}
			return backupRunStatus{}, errors.New("backup run id does not match immutable request")
		}
		if action == "preflight" {
			return r.preflight(runID, payload, fingerprint)
		}
		return r.start(runID, payload, fingerprint)
	default:
		return backupRunStatus{}, errors.New("backup action is not allowed")
	}
}

func (r *backupRuntime) persistPreflightFailure(runID, phase string, err error) error {
	now := time.Now().UTC()
	status := backupRunStatus{
		RunID:       runID,
		Status:      "failed",
		Phase:       phase,
		Error:       sanitizeBackupError(err.Error()),
		CompletedAt: &now,
	}
	r.mu.Lock()
	r.runs[runID] = &status
	r.mu.Unlock()
	return r.persist(status)
}

func parseBackupPayload(raw string) (backupPayload, string, error) {
	var payload backupPayload
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil {
		return payload, "", errors.New("backup configuration is invalid JSON")
	}
	if err := payload.validate(); err != nil {
		return payload, "", err
	}
	sum := sha256.Sum256([]byte(raw))
	return payload, hex.EncodeToString(sum[:]), nil
}

func (p backupPayload) validate() error {
	if _, err := uuid.Parse(p.RunID); err != nil || p.Version != 1 || (p.Direction != "backup" && p.Direction != "restore") || (p.Engine != "postgres" && p.Engine != "redis" && p.Engine != "clickhouse") {
		return errors.New("backup version, direction, or engine is invalid")
	}
	if !strings.Contains(p.ToolImage, "@sha256:") {
		return errors.New("backup tool image must be an immutable digest reference")
	}
	if err := p.Limits.validate(); err != nil {
		return err
	}
	if p.Direction == "backup" && p.Source.ConnectionID == "" {
		return errors.New("backup source is required")
	}
	if p.Direction == "backup" {
		if err := p.Source.validateDatabase(); err != nil {
			return fmt.Errorf("source: %w", err)
		}
	}
	if err := p.Destination.validateDestination(); err != nil {
		return fmt.Errorf("destination: %w", err)
	}
	if p.Destination.Provider == "sftp" && !strings.HasPrefix(p.Destination.HostKeyFingerprint, "SHA256:") {
		return errors.New("sftp destination requires SHA256 host key fingerprint")
	}
	if p.Engine == "clickhouse" && p.Destination.Provider != "s3" && p.Staging == nil {
		return errors.New("clickhouse file-protocol destination requires S3 staging")
	}
	if p.Engine == "clickhouse" && p.Staging != nil && p.Staging.Provider != "s3" {
		return errors.New("clickhouse staging must use S3")
	}
	if p.Direction == "restore" && p.RestoreTarget == nil {
		return errors.New("restore requires a new target")
	}
	if p.Direction == "restore" && p.Engine == "redis" && p.RestoreTarget != nil && p.RestoreTarget.ManagedDatabaseID == "" {
		if p.RedisStageAdvertiseHost == "" || isBackupLoopbackHost(p.RedisStageAdvertiseHost) {
			return errors.New("external Redis restore requires an executor-reachable staging address")
		}
	}
	return nil
}

func isBackupLoopbackHost(value string) bool {
	value = strings.TrimSpace(strings.ToLower(value))
	return value == "localhost" || value == "::1" || strings.HasPrefix(value, "127.")
}

func (l backupLimits) validate() error {
	if l.WorkspaceBytes < backupMinWorkspace || l.WorkspaceBytes > backupMaxWorkspace {
		return errors.New("backup workspace limit is outside allowed bounds")
	}
	if l.TimeoutSeconds < int(time.Minute.Seconds()) || time.Duration(l.TimeoutSeconds)*time.Second > backupMaxTimeout {
		return errors.New("backup timeout is outside allowed bounds")
	}
	if l.CPUCores < 1 || l.CPUCores > 32 || l.MemoryMB < 128 || l.MemoryMB > 262144 {
		return errors.New("backup runtime limit is outside allowed bounds")
	}
	return nil
}

func (e backupEndpoint) validateDatabase() error {
	if e.ConnectionID == "" || e.Host == "" || e.Port < 1 || e.Port > 65535 {
		return errors.New("database endpoint is incomplete")
	}
	return nil
}

func (e backupEndpoint) validateDestination() error {
	if e.ConnectionID == "" || (e.Provider != "s3" && e.Provider != "ftp" && e.Provider != "ftps" && e.Provider != "sftp") {
		return errors.New("destination provider is invalid")
	}
	if !isSafeBackupPath(e.Prefix, false) || !isSafeBackupBasePath(e.BasePath) || !isSafeBackupPath(e.Bucket, false) {
		return errors.New("destination path is invalid")
	}
	if e.Provider == "s3" && (e.Bucket == "" || e.Endpoint == "") {
		return errors.New("s3 destination is incomplete")
	}
	if e.Provider != "s3" && (e.Host == "" || e.Port < 1 || e.Port > 65535) {
		return errors.New("file destination is incomplete")
	}
	return nil
}

func isSafeBackupBasePath(value string) bool {
	if value == "" {
		return true
	}
	return isSafeBackupPath(strings.TrimPrefix(value, "/"), false)
}

func isSafeBackupPath(value string, allowEmpty bool) bool {
	if value == "" {
		return allowEmpty
	}
	if strings.HasPrefix(value, "/") || strings.Contains(value, "\\") {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "" || segment == "." || segment == ".." {
			return false
		}
		for _, character := range segment {
			if character < 0x20 || character == 0x7f {
				return false
			}
		}
	}
	return true
}

func (r *backupRuntime) preflight(runID string, payload backupPayload, fingerprint string) (backupRunStatus, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	status, err := r.runTool(ctx, runID, payload, fingerprint, "preflight")
	if err != nil {
		if status.CleanupPending {
			now := time.Now().UTC()
			status.RunID, status.Status, status.Phase, status.Error, status.CompletedAt = runID, "failed", "preflight", sanitizeBackupError(err.Error()), &now
			r.mu.Lock()
			r.runs[runID] = &status
			r.mu.Unlock()
			if persistErr := r.persist(status); persistErr != nil {
				return backupRunStatus{}, persistErr
			}
			return status, err
		}
		return backupRunStatus{}, err
	}
	if status.Status != "completed" {
		now := time.Now().UTC()
		status.CompletedAt = &now
		r.mu.Lock()
		r.runs[runID] = &status
		r.mu.Unlock()
		if persistErr := r.persist(status); persistErr != nil {
			return backupRunStatus{}, persistErr
		}
		return status, errors.New(status.Error)
	}
	if status.CleanupPending {
		now := time.Now().UTC()
		status.Status, status.Phase, status.Error, status.CompletedAt = "failed", "cleanup", status.CleanupError, &now
		r.mu.Lock()
		r.runs[runID] = &status
		r.mu.Unlock()
		if persistErr := r.persist(status); persistErr != nil {
			return backupRunStatus{}, persistErr
		}
		return status, errors.New(status.Error)
	}
	status.Status, status.Phase = "queued", "preflight_complete"
	status.CompletedAt = nil
	if err := r.persist(status); err != nil {
		return backupRunStatus{}, err
	}
	return status, nil
}

func (r *backupRuntime) start(runID string, payload backupPayload, fingerprint string) (backupRunStatus, error) {
	r.mu.Lock()
	if r.runs[runID] == nil {
		if persisted, err := r.load(runID); err == nil {
			r.runs[runID] = &persisted
		}
	}
	if existing := r.runs[runID]; existing != nil {
		if existing.Fingerprint != fingerprint {
			r.mu.Unlock()
			return backupRunStatus{}, errors.New("backup run id was replayed with different immutable request")
		}
		if existing.Phase != "preflight_complete" {
			copy := *existing
			r.mu.Unlock()
			return copy, nil
		}
		delete(r.runs, runID)
	}
	started := time.Now().UTC()
	status := &backupRunStatus{RunID: runID, Status: "queued", Phase: "queued", StartedAt: &started, Fingerprint: fingerprint}
	r.runs[runID] = status
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(payload.Limits.TimeoutSeconds)*time.Second)
	r.cancel[runID] = cancel
	r.mu.Unlock()
	if err := r.persist(*status); err != nil {
		r.mu.Lock()
		delete(r.runs, runID)
		delete(r.cancel, runID)
		r.mu.Unlock()
		return backupRunStatus{}, err
	}
	go func() {
		result, err := r.runTool(ctx, runID, payload, fingerprint, payload.Direction)
		if err != nil {
			cleanupPending, cleanupError := result.CleanupPending, result.CleanupError
			if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
				result = backupRunStatus{RunID: runID, Status: "cancelled", Phase: "cancelled", Fingerprint: fingerprint}
			} else {
				result = backupRunStatus{RunID: runID, Status: "failed", Phase: "failed", Error: sanitizeBackupError(err.Error()), Fingerprint: fingerprint}
			}
			result.CleanupPending, result.CleanupError = cleanupPending, cleanupError
		}
		now := time.Now().UTC()
		result.CompletedAt = &now
		r.mu.Lock()
		r.runs[runID] = &result
		delete(r.cancel, runID)
		r.mu.Unlock()
		_ = r.persist(result)
	}()
	return *status, nil
}

func (r *backupRuntime) runTool(ctx context.Context, runID string, payload backupPayload, fingerprint, operation string) (status backupRunStatus, err error) {
	workdir := filepath.Join(r.root, runID)
	if err := os.MkdirAll(workdir, 0700); err != nil {
		return backupRunStatus{}, err
	}
	configDir := filepath.Join(workdir, "config")
	resultDir := filepath.Join(workdir, "work")
	if err := os.MkdirAll(configDir, 0700); err != nil {
		return backupRunStatus{}, err
	}
	if err := os.Chown(configDir, 65532, 65532); err != nil {
		return backupRunStatus{}, fmt.Errorf("own backup configuration directory: %w", err)
	}
	workspace, err := r.allocateWorkspace(ctx, runID, resultDir, payload.Limits.WorkspaceBytes)
	if err != nil {
		return backupRunStatus{}, err
	}
	defer func() {
		if cleanupErr := cleanupBackupWorkspace(workspace, workdir); cleanupErr != nil {
			status.CleanupPending = true
			status.CleanupError = sanitizeBackupError(cleanupErr.Error())
		}
	}()
	stageCleanup, err := r.startRedisStage(ctx, runID, &payload, resultDir)
	if err != nil {
		return backupRunStatus{}, err
	}
	defer stageCleanup()
	nativeStorageCleanup, err := r.prepareBackupNativeS3(ctx, &payload)
	if err != nil {
		return backupRunStatus{}, err
	}
	defer nativeStorageCleanup()
	closers, err := r.prepareRelayEndpoints(ctx, &payload)
	if err != nil {
		return backupRunStatus{}, err
	}
	defer func() {
		for _, close := range closers {
			close()
		}
	}()
	configPath := filepath.Join(configDir, "config.json")
	data, err := json.Marshal(payload)
	if err != nil {
		return backupRunStatus{}, err
	}
	if err := os.WriteFile(configPath, data, 0600); err != nil {
		return backupRunStatus{}, err
	}
	if err := os.Chown(configPath, 65532, 65532); err != nil {
		return backupRunStatus{}, fmt.Errorf("own backup configuration: %w", err)
	}
	if err := r.plugin.client.EnsureImage(ctx, payload.ToolImage, ""); err != nil {
		return backupRunStatus{}, fmt.Errorf("ensure backup runner image: %w", err)
	}
	pids := int64(256)
	created, err := r.plugin.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config:     &container.Config{Image: payload.ToolImage, Cmd: []string{operation}, Labels: map[string]string{backupRunnerManagedLabel: "backup-runner", backupRunnerRunLabel: runID}},
		HostConfig: &container.HostConfig{NetworkMode: "host", ReadonlyRootfs: true, CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges:true"}, Resources: container.Resources{Memory: payload.Limits.MemoryMB * 1024 * 1024, NanoCPUs: payload.Limits.CPUCores * 1_000_000_000, PidsLimit: &pids}, Mounts: []mount.Mount{{Type: mount.TypeBind, Source: configDir, Target: "/run/gateway-backup", ReadOnly: true}, {Type: mount.TypeBind, Source: resultDir, Target: "/work"}}},
	})
	if err != nil {
		return backupRunStatus{}, fmt.Errorf("create backup runner: %w", err)
	}
	defer r.plugin.client.cli.ContainerRemove(context.Background(), created.ID, mobyclient.ContainerRemoveOptions{Force: true})
	if err := r.recordRunnerContainer(runID, operation, created.ID); err != nil {
		return backupRunStatus{}, err
	}
	if _, err := r.plugin.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
		return backupRunStatus{}, fmt.Errorf("start backup runner: %w", err)
	}
	wait := r.plugin.client.cli.ContainerWait(ctx, created.ID, mobyclient.ContainerWaitOptions{Condition: container.WaitConditionNotRunning})
	select {
	case err := <-wait.Error:
		if err != nil {
			return backupRunStatus{}, fmt.Errorf("wait backup runner: %w", err)
		}
	case result := <-wait.Result:
		if result.StatusCode != 0 {
			if resultData, readErr := os.ReadFile(filepath.Join(resultDir, "result.json")); readErr == nil {
				if terminal, parseErr := parseBackupRunnerResult(resultData, runID, fingerprint); parseErr == nil {
					return terminal, nil
				}
			}
			lines, _ := r.plugin.client.ContainerLogs(context.Background(), created.ID, 100, false, "", "")
			return backupRunStatus{}, fmt.Errorf("backup runner exited %d: %s", result.StatusCode, sanitizeBackupError(strings.Join(lines, " ")))
		}
	case <-ctx.Done():
		return backupRunStatus{}, ctx.Err()
	}
	resultData, err := os.ReadFile(filepath.Join(resultDir, "result.json"))
	if err != nil {
		return backupRunStatus{}, errors.New("backup runner did not write result")
	}
	return parseBackupRunnerResult(resultData, runID, fingerprint)
}

func (r *backupRuntime) recordRunnerContainer(runID, operation, containerID string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if current := r.runs[runID]; current != nil {
		current.Status, current.Phase, current.ContainerID = "running", operation, containerID
		return r.persist(*current)
	}
	return nil
}

func cleanupBackupWorkspace(workspace *backupWorkspace, workdir string) error {
	if err := workspace.close(); err != nil {
		return err
	}
	return os.RemoveAll(workdir)
}

func (r *backupRuntime) allocateWorkspace(ctx context.Context, runID, mountPath string, bytes int64) (*backupWorkspace, error) {
	manager := r.plugin.databaseManager
	if manager == nil {
		return nil, errors.New("managed storage manager is not initialized")
	}
	manager.mu.Lock()
	defer manager.mu.Unlock()
	root := filepath.Join(manager.root, "backups")
	imageDir := filepath.Join(root, "images")
	if err := os.MkdirAll(imageDir, 0700); err != nil {
		return nil, fmt.Errorf("create backup workspace image directory: %w", err)
	}
	if err := manager.ensureCapacity(bytes); err != nil {
		return nil, fmt.Errorf("reserve backup workspace: %w", err)
	}
	imagePath := filepath.Join(imageDir, runID+".img")
	image, err := os.OpenFile(imagePath, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("create backup workspace image: %w", err)
	}
	defer image.Close()
	removeImage := true
	defer func() {
		if removeImage {
			_ = os.Remove(imagePath)
		}
	}()
	if output, err := exec.CommandContext(ctx, "fallocate", "-l", strconv.FormatInt(bytes, 10), imagePath).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("allocate bounded backup workspace: %w: %s", err, sanitizeBackupError(string(output)))
	}
	if err := image.Sync(); err != nil {
		return nil, fmt.Errorf("sync backup workspace image: %w", err)
	}
	if output, err := exec.CommandContext(ctx, "mkfs.ext4", "-q", "-F", imagePath).CombinedOutput(); err != nil {
		return nil, fmt.Errorf("format bounded backup workspace: %w: %s", err, sanitizeBackupError(string(output)))
	}
	if err := os.MkdirAll(mountPath, 0700); err != nil {
		return nil, fmt.Errorf("create backup workspace mount point: %w", err)
	}
	loopDevice, err := attachDatabaseLoopDevice(ctx, imagePath)
	if err != nil {
		return nil, fmt.Errorf("attach backup workspace loop device: %w", err)
	}
	if output, err := exec.CommandContext(ctx, "mount", "-o", "noatime", loopDevice, mountPath).CombinedOutput(); err != nil {
		_ = exec.Command("losetup", "-d", loopDevice).Run()
		return nil, fmt.Errorf("mount bounded backup workspace: %w: %s", err, sanitizeBackupError(string(output)))
	}
	if err := os.Chown(mountPath, 65532, 65532); err != nil {
		_ = exec.Command("umount", mountPath).Run()
		_ = exec.Command("losetup", "-d", loopDevice).Run()
		return nil, fmt.Errorf("own backup workspace: %w", err)
	}
	removeImage = false
	return &backupWorkspace{imagePath: imagePath, mountPath: mountPath, loopDevice: loopDevice}, nil
}

func (w *backupWorkspace) close() error {
	if w == nil {
		return nil
	}
	if mounted(w.mountPath) {
		if err := backupWorkspaceUnmount(w.mountPath); err != nil {
			return fmt.Errorf("unmount backup workspace: %w", err)
		}
	}
	if w.loopDevice != "" {
		if err := backupWorkspaceDetach(w.loopDevice); err != nil {
			return fmt.Errorf("detach backup workspace loop device: %w", err)
		}
	}
	if err := os.Remove(w.imagePath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("remove backup workspace image: %w", err)
	}
	return nil
}

func (r *backupRuntime) startRedisStage(ctx context.Context, runID string, payload *backupPayload, workdir string) (func(), error) {
	if payload.Direction != "restore" || payload.Engine != "redis" || payload.RestoreTarget == nil {
		return func() {}, nil
	}
	if !strings.Contains(payload.RedisStageImage, "@sha256:") {
		return nil, errors.New("immutable Redis staging image is required for external Redis restore")
	}
	if err := r.plugin.client.EnsureImage(ctx, payload.RedisStageImage, ""); err != nil {
		return nil, err
	}
	stageMemory, redisMaxMemory, err := redisStageMemoryLimits(payload.Limits.MemoryMB)
	if err != nil {
		return nil, err
	}
	port := 6379
	stageHost := ""
	hostConfig := &container.HostConfig{ReadonlyRootfs: true, CapDrop: []string{"ALL"}, SecurityOpt: []string{"no-new-privileges:true"}, Resources: container.Resources{Memory: stageMemory, NanoCPUs: 500_000_000}}
	var networking *network.NetworkingConfig
	if payload.RestoreTarget.ManagedDatabaseID == "" {
		allocated, err := allocateBackupStagePort()
		if err != nil {
			return nil, err
		}
		port = allocated
		stageHost = payload.RedisStageAdvertiseHost
		hostConfig.NetworkMode = "host"
	} else {
		if r.plugin.databaseManager == nil {
			return nil, errors.New("managed database runtime is not initialized")
		}
		record, err := r.plugin.databaseManager.loadRecord(payload.RestoreTarget.ManagedDatabaseID)
		if err != nil || record.Type != "redis" || record.NetworkName == "" {
			return nil, errors.New("managed Redis restore target network is unavailable")
		}
		networking = &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{record.NetworkName: {}}}
	}
	secretBytes := make([]byte, 24)
	if _, err := rand.Read(secretBytes); err != nil {
		return nil, err
	}
	password := hex.EncodeToString(secretBytes)
	pids := int64(128)
	hostConfig.Resources.PidsLimit = &pids
	stageDir := filepath.Join(workdir, "redis-stage")
	if err := os.MkdirAll(stageDir, 0700); err != nil {
		return nil, err
	}
	if err := os.Chown(stageDir, 65532, 65532); err != nil {
		return nil, err
	}
	stageConfig := filepath.Join(stageDir, "redis.conf")
	configText := "bind 0.0.0.0\nport " + strconv.Itoa(port) + "\ndir /work/redis-stage\ndbfilename dump.rdb\nappendonly no\nsave \"\"\nmaxmemory " + strconv.FormatInt(redisMaxMemory, 10) + "\nmaxmemory-policy noeviction\nrequirepass " + password + "\n"
	if err := os.WriteFile(stageConfig, []byte(configText), 0600); err != nil {
		return nil, err
	}
	if err := os.Chown(stageConfig, 65532, 65532); err != nil {
		return nil, err
	}
	command := "until [ -f /work/redis-stage/dump.rdb ]; do sleep 0.1; done; exec redis-server /work/redis-stage/redis.conf"
	created, err := r.plugin.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config: &container.Config{Image: payload.RedisStageImage, User: "65532:65532", Cmd: []string{"sh", "-ec", command}, Labels: map[string]string{"wiolett.gateway.managed": "backup-redis-stage", "wiolett.gateway.backup-run-id": runID}},
		HostConfig: func() *container.HostConfig {
			hostConfig.Mounts = []mount.Mount{{Type: mount.TypeBind, Source: workdir, Target: "/work"}}
			return hostConfig
		}(),
		NetworkingConfig: networking,
	})
	if err != nil {
		return nil, fmt.Errorf("create Redis staging container: %w", err)
	}
	if _, err := r.plugin.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
		_, _ = r.plugin.client.cli.ContainerRemove(context.Background(), created.ID, mobyclient.ContainerRemoveOptions{Force: true})
		return nil, err
	}
	if networking != nil {
		inspect, inspectErr := r.plugin.client.cli.ContainerInspect(ctx, created.ID, mobyclient.ContainerInspectOptions{})
		if inspectErr != nil || inspect.Container.NetworkSettings == nil {
			_, _ = r.plugin.client.cli.ContainerRemove(context.Background(), created.ID, mobyclient.ContainerRemoveOptions{Force: true})
			return nil, errors.New("inspect managed Redis staging network")
		}
		for _, endpoint := range inspect.Container.NetworkSettings.Networks {
			if endpoint != nil && endpoint.IPAddress.IsValid() {
				stageHost = endpoint.IPAddress.String()
				break
			}
		}
		if stageHost == "" {
			_, _ = r.plugin.client.cli.ContainerRemove(context.Background(), created.ID, mobyclient.ContainerRemoveOptions{Force: true})
			return nil, errors.New("managed Redis staging container has no private address")
		}
	}
	payload.RedisStaging = &backupEndpoint{ConnectionID: "redis-stage", Host: stageHost, Port: port, Password: password}
	return func() {
		_, _ = r.plugin.client.cli.ContainerRemove(context.Background(), created.ID, mobyclient.ContainerRemoveOptions{Force: true})
	}, nil
}

func redisStageMemoryLimits(memoryMB int64) (int64, int64, error) {
	const reserveBytes = int64(32 * 1024 * 1024)
	approved := memoryMB * 1024 * 1024
	if approved <= reserveBytes {
		return 0, 0, errors.New("approved Redis staging memory is too small")
	}
	return approved, approved - reserveBytes, nil
}

func allocateBackupStagePort() (int, error) {
	const minPort = 20000
	const portRange = 20000
	for range 32 {
		var bytes [2]byte
		if _, err := rand.Read(bytes[:]); err != nil {
			return 0, err
		}
		raw := int(bytes[0])<<8 | int(bytes[1])
		port := minPort + raw%portRange
		listener, err := net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IPv4zero, Port: port})
		if err == nil {
			_ = listener.Close()
			return port, nil
		}
	}
	return 0, errors.New("no bounded Redis staging port is available")
}

func (r *backupRuntime) status(runID string) (backupRunStatus, error) {
	r.mu.Lock()
	if current := r.runs[runID]; current != nil {
		status := *current
		r.mu.Unlock()
		if isTerminalBackupStatus(status.Status) {
			return r.reconcileTerminalCleanup(status, false)
		}
		return status, nil
	}
	r.mu.Unlock()
	status, err := r.load(runID)
	if err != nil {
		return r.recoverUnknownRun(runID)
	}
	if isTerminalBackupStatus(status.Status) {
		return r.reconcileTerminalCleanup(status, false)
	}
	return r.reconcilePersistedRun(status)
}

func isTerminalBackupStatus(status string) bool {
	return status == "completed" || status == "failed" || status == "cancelled"
}

func (r *backupRuntime) recoverUnknownRun(runID string) (backupRunStatus, error) {
	containers, err := r.plugin.client.cli.ContainerList(context.Background(), mobyclient.ContainerListOptions{
		All: true,
		Filters: mobyclient.Filters{}.
			Add("label", backupRunnerManagedLabel+"=backup-runner").
			Add("label", backupRunnerRunLabel+"="+runID),
	})
	if err != nil {
		return backupRunStatus{}, fmt.Errorf("inspect unknown backup run: %w", err)
	}
	for _, candidate := range containers.Items {
		if candidate.State == "running" {
			status := backupRunStatus{RunID: runID, Status: "running", Phase: "recovered", ContainerID: candidate.ID}
			if err := r.persist(status); err != nil {
				return backupRunStatus{}, err
			}
			return status, nil
		}
		status := backupRunStatus{RunID: runID, ContainerID: candidate.ID}
		if terminal, resultErr := r.readPersistedRunnerResult(status); resultErr == nil {
			return r.reconcileTerminalCleanup(terminal, true)
		}
		status.Status, status.Phase, status.Error = "failed", "runner_lost", "Backup runner exited without a verified result"
		now := time.Now().UTC()
		status.CompletedAt = &now
		return r.reconcileTerminalCleanup(status, true)
	}
	if terminal, resultErr := r.readPersistedRunnerResult(backupRunStatus{RunID: runID}); resultErr == nil {
		return r.reconcileTerminalCleanup(terminal, true)
	}
	return backupRunStatus{}, errors.New("BACKUP_RUN_UNKNOWN")
}

func (r *backupRuntime) reconcilePersistedRun(status backupRunStatus) (backupRunStatus, error) {
	if status.Status == "queued" && status.Phase == "preflight_complete" && status.ContainerID == "" {
		return status, nil
	}
	if status.ContainerID == "" {
		return r.recoverUnknownRun(status.RunID)
	}
	inspect, err := r.plugin.client.cli.ContainerInspect(context.Background(), status.ContainerID, mobyclient.ContainerInspectOptions{})
	if err == nil {
		labels := map[string]string(nil)
		if inspect.Container.Config != nil {
			labels = inspect.Container.Config.Labels
		}
		if labels[backupRunnerManagedLabel] != "backup-runner" || labels[backupRunnerRunLabel] != status.RunID {
			return backupRunStatus{}, errors.New("BACKUP_RUN_UNKNOWN")
		}
		if inspect.Container.State != nil && inspect.Container.State.Running {
			return status, nil
		}
	} else if !isNotFoundErr(err) {
		return backupRunStatus{}, fmt.Errorf("inspect persisted backup runner: %w", err)
	}
	if terminal, resultErr := r.readPersistedRunnerResult(status); resultErr == nil {
		return r.reconcileTerminalCleanup(terminal, true)
	}
	status.Status, status.Phase, status.Error = "failed", "runner_lost", "Backup runner exited without a verified result"
	now := time.Now().UTC()
	status.CompletedAt = &now
	return r.reconcileTerminalCleanup(status, true)
}

func (r *backupRuntime) readPersistedRunnerResult(status backupRunStatus) (backupRunStatus, error) {
	data, err := os.ReadFile(filepath.Join(r.root, status.RunID, "work", "result.json"))
	if err != nil {
		return backupRunStatus{}, err
	}
	return parseBackupRunnerResult(data, status.RunID, status.Fingerprint)
}

func (r *backupRuntime) reconcileTerminalCleanup(status backupRunStatus, force bool) (backupRunStatus, error) {
	if !force && !status.CleanupPending {
		return status, nil
	}
	if r.plugin == nil || r.plugin.databaseManager == nil {
		status.CleanupPending = true
		status.CleanupError = "managed storage manager is not initialized"
	} else if err := r.removeWorkspace(status.RunID, filepath.Join(r.plugin.databaseManager.root, "backups", "images", status.RunID+".img")); err != nil {
		status.CleanupPending = true
		status.CleanupError = sanitizeBackupError(err.Error())
	} else {
		status.CleanupPending = false
		status.CleanupError = ""
	}
	if err := r.persist(status); err != nil {
		return backupRunStatus{}, err
	}
	r.mu.Lock()
	if r.runs != nil {
		updated := status
		r.runs[status.RunID] = &updated
	}
	r.mu.Unlock()
	return status, nil
}
func (r *backupRuntime) cancelRun(runID string) (backupRunStatus, error) {
	r.mu.Lock()
	cancel := r.cancel[runID]
	current := r.runs[runID]
	r.mu.Unlock()
	if current == nil {
		recovered, err := r.status(runID)
		if err != nil {
			return backupRunStatus{}, err
		}
		if recovered.Status == "completed" || recovered.Status == "failed" || recovered.Status == "cancelled" {
			return recovered, nil
		}
		current = &recovered
	}
	if cancel != nil {
		cancel()
	} else if current.ContainerID != "" {
		stopTimeout := 10
		stopContext, stopCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer stopCancel()
		if _, err := r.plugin.client.cli.ContainerStop(stopContext, current.ContainerID, mobyclient.ContainerStopOptions{Timeout: &stopTimeout}); err != nil && !isNotFoundErr(err) {
			return backupRunStatus{}, fmt.Errorf("cancel recovered backup runner: %w", err)
		}
	}
	result := *current
	result.Status, result.Phase = "running", "cancelling"
	if err := r.persist(result); err != nil {
		return backupRunStatus{}, err
	}
	return result, nil
}
func (r *backupRuntime) persist(status backupRunStatus) error {
	data, err := json.Marshal(status)
	if err != nil {
		return err
	}
	path := filepath.Join(r.root, status.RunID+".json")
	temporary := path + ".tmp"
	if err := os.WriteFile(temporary, data, 0600); err != nil {
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}
func (r *backupRuntime) load(runID string) (backupRunStatus, error) {
	data, err := os.ReadFile(filepath.Join(r.root, runID+".json"))
	if err != nil {
		return backupRunStatus{}, errors.New("backup run is unknown")
	}
	var status backupRunStatus
	if err := json.Unmarshal(data, &status); err != nil {
		return backupRunStatus{}, err
	}
	return status, nil
}

func (r *backupRuntime) prepareRelayEndpoints(ctx context.Context, payload *backupPayload) ([]func(), error) {
	closers := make([]func(), 0, 3)
	open := func(ownerKind string, endpoint *backupEndpoint) error {
		if endpoint.RelayRouteID == "" {
			return nil
		}
		address, close, err := OpenBackupRelayRouteForBackup(ctx, r.plugin, ownerKind, endpoint.RelayRouteID)
		if err != nil {
			return err
		}
		if err := endpoint.replaceWithRelay(address); err != nil {
			close()
			return err
		}
		closers = append(closers, close)
		return nil
	}
	if payload.Direction == "backup" {
		if err := open("database_backup_source", &payload.Source); err != nil {
			return nil, err
		}
	}
	if err := open("storage_backup_target", &payload.Destination); err != nil {
		return nil, err
	}
	if payload.Staging != nil {
		if err := open("storage_backup_staging", payload.Staging); err != nil {
			return nil, err
		}
	}
	if payload.Direction == "restore" && payload.RestoreTarget != nil {
		if err := open("database_backup_restore", payload.RestoreTarget); err != nil {
			return nil, err
		}
	}
	return closers, nil
}

func (e *backupEndpoint) replaceWithRelay(address string) error {
	host, portText, err := net.SplitHostPort(address)
	if err != nil {
		return errors.New("backup relay returned invalid address")
	}
	port, err := strconv.Atoi(portText)
	if err != nil || port < 1 || port > 65535 {
		return errors.New("backup relay returned invalid port")
	}
	e.Host, e.Port = host, port
	if e.Provider == "s3" {
		endpoint, err := url.Parse(e.Endpoint)
		if err != nil || endpoint.Scheme == "" {
			return errors.New("s3 relay requires an absolute endpoint")
		}
		endpoint.Host = net.JoinHostPort(host, portText)
		e.Endpoint = endpoint.String()
	}
	return nil
}

func parseBackupRunnerResult(data []byte, runID, fingerprint string) (backupRunStatus, error) {
	if len(data) > backupResultMaxBytes {
		return backupRunStatus{}, errors.New("backup runner output exceeded limit")
	}
	var status backupRunStatus
	decoder := json.NewDecoder(strings.NewReader(string(data)))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&status); err != nil {
		return backupRunStatus{}, errors.New("backup runner returned invalid result")
	}
	if status.RunID != runID || (status.Status != "completed" && status.Status != "failed" && status.Status != "cancelled") {
		return backupRunStatus{}, errors.New("backup runner result is invalid")
	}
	status.Fingerprint = fingerprint
	status.Error = sanitizeBackupError(status.Error)
	return status, nil
}
func sanitizeBackupError(value string) string {
	value = strings.ReplaceAll(value, "\n", " ")
	for _, key := range []string{"password=", "secret=", "token=", "privateKey="} {
		if index := strings.Index(strings.ToLower(value), strings.ToLower(key)); index >= 0 {
			value = value[:index] + key + "[redacted]"
		}
	}
	if len(value) > 2048 {
		value = value[:2048]
	}
	return value
}
