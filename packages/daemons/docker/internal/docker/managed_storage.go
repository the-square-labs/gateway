package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
)

const (
	managedStorageLabel          = "wiolett.gateway.managed-storage.id"
	managedStorageMemberLabel    = "wiolett.gateway.managed-storage.member-index"
	managedStorageCommandTimeout = 13 * time.Minute
	minimumStorageBytes          = 1024 * 1024 * 1024
	maximumStorageBytes          = 16 * 1024 * 1024 * 1024 * 1024
	maximumStorageMemoryBytes    = 512 * 1024 * 1024 * 1024
	minimumStorageNanoCPUs       = 100_000_000
	maximumStorageNanoCPUs       = 256_000_000_000
	trustedMinioImage            = "quay.io/minio/minio@sha256:a1ea29fa28355559ef137d71fc570e508a214ec84ff8083e39bc5428980b015e"
	minioCatalogID               = "minio-release-2025-04-22"
)

var (
	managedStorageIDPattern  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	managedStorageKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$`)
)

type managedStorageCommand struct {
	Version int `json:"version"`
	// Engine is empty or "minio" for version 1 and "seaweedfs" for version 2.
	// decodeManagedStorageCommand normalizes it for workload commands.
	Engine          string                  `json:"engine,omitempty"`
	OperationID     string                  `json:"operationId"`
	Image           string                  `json:"image"`
	ImageCatalogID  string                  `json:"imageCatalogId"`
	RootCredentials managedStorageRootCreds `json:"rootCredentials"`
	Resources       managedStorageResources `json:"resources"`
	PublishS3       bool                    `json:"publishS3"`
	PublishedPort   uint16                  `json:"publishedPort"`
	PeerBindAddress string                  `json:"peerBindAddress"`
	RelayEnabled    bool                    `json:"relayEnabled"`
	MemberIndex     int                     `json:"memberIndex"`
	Members         []managedStorageMember  `json:"members"`
	TLS             *managedStorageTLS      `json:"tls,omitempty"`
	FTP             *managedStorageFTP      `json:"ftp,omitempty"`
	SFTP            *managedStorageSFTP     `json:"sftp,omitempty"`
	IAM             *managedStorageIAM      `json:"iam,omitempty"`
	DeleteData      bool                    `json:"deleteData,omitempty"`
}

type managedStorageRootCreds struct {
	AccessKey string `json:"accessKey"`
	SecretKey string `json:"secretKey"`
}

type managedStorageResources struct {
	NanoCPUs        int64 `json:"nanoCPUs"`
	MemoryBytes     int64 `json:"memoryBytes"`
	MemorySwapBytes int64 `json:"memorySwapBytes"`
	StorageBytes    int64 `json:"storageBytes"`
}

type managedStorageMember struct {
	MemberIndex int    `json:"memberIndex"`
	Endpoint    string `json:"endpoint"`
}

type managedStorageTLS struct {
	CertPEM    string `json:"certPem"`
	KeyPEM     string `json:"keyPem"`
	CAPEM      string `json:"caPem"`
	ServerName string `json:"serverName"`
}

// External FTP/SFTP transport details are typed. The runtime renders them only
// as MinIO's fixed FTP/SFTP flags, an owned SFTP host-key mount, and explicit
// public Docker port bindings; no caller-provided Docker argv or bind is used.
type managedStorageFTP struct {
	Port             uint16 `json:"port"`
	PassivePortStart uint16 `json:"passivePortStart"`
	PassivePortCount uint16 `json:"passivePortCount"`
}

type managedStorageSFTP struct {
	Port       uint16 `json:"port"`
	HostKeyPEM string `json:"hostKeyPem"`
}

type managedStorageIAM struct {
	Action          string `json:"action"`
	TargetAccessKey string `json:"targetAccessKey"`
	TargetSecretKey string `json:"targetSecretKey"`
	Name            string `json:"name"`
	Policy          string `json:"policy"`
	ExpiresAt       string `json:"expiresAt"`
	// Principal is the SeaweedFS IAM user that owns one Gateway-issued key
	// (see managed_storage_seaweedfs_iam.go). MinIO ignores it.
	Principal string `json:"principal,omitempty"`
}

// managedStorageRecord intentionally has no root credentials or IAM secrets.
// It is sufficient to recover the derived local storage and container after a
// daemon restart without turning the state file into a credential store.
type managedStorageRecord struct {
	ID string `json:"id"`
	// Engine is empty for records written before SeaweedFS existed; those are
	// MinIO. Use record.engine() rather than the raw field.
	Engine          string `json:"engine,omitempty"`
	ContainerID     string `json:"containerId"`
	ContainerName   string `json:"containerName"`
	NetworkName     string `json:"networkName"`
	ImagePath       string `json:"imagePath"`
	MountPath       string `json:"mountPath"`
	LoopDevice      string `json:"loopDevice,omitempty"`
	StorageBytes    int64  `json:"storageBytes"`
	NanoCPUs        int64  `json:"nanoCPUs"`
	MemoryBytes     int64  `json:"memoryBytes"`
	MemorySwapBytes int64  `json:"memorySwapBytes"`
	Image           string `json:"image"`
	MemberIndex     int    `json:"memberIndex"`
	MemberCount     int    `json:"memberCount"`
	PublishS3       bool   `json:"publishS3"`
	PeerBindAddress string `json:"peerBindAddress,omitempty"`
	PublishedPort   uint16 `json:"publishedPort,omitempty"`
	TLSEnabled      bool   `json:"tlsEnabled"`
	TLSServerName   string `json:"tlsServerName,omitempty"`
	FTPPort         uint16 `json:"ftpPort,omitempty"`
	FTPPassiveStart uint16 `json:"ftpPassivePortStart,omitempty"`
	FTPPassiveCount uint16 `json:"ftpPassivePortCount,omitempty"`
	SFTPPort        uint16 `json:"sftpPort,omitempty"`
	DesiredRunning  bool   `json:"desiredRunning"`
	Removed         bool   `json:"removed"`
	OperationID     string `json:"operationId"`
}

func newManagedStorageManager(cfg *config.Config, client *Client, logger *slog.Logger) (*managedStorageManager, error) {
	root := filepath.Clean(cfg.Docker.Database.StorageRoot)
	if !filepath.IsAbs(root) || root == "/" {
		return nil, errors.New("storage root must be an absolute non-root path")
	}
	for _, dir := range []string{"storage/images", "storage/mounts", "storage/records"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			return nil, fmt.Errorf("create managed storage directory: %w", err)
		}
	}
	if cfg.Docker.Database.ReserveBytes < 0 {
		return nil, errors.New("storage reserve bytes cannot be negative")
	}
	return &managedStorageManager{client: client, logger: logger, root: root, reserve: cfg.Docker.Database.ReserveBytes}, nil
}

func (p *DockerPlugin) handleManagedStorageCommand(cmd *pb.DockerStorageCommand, result *pb.CommandResult) {
	if p.storageManager == nil {
		result.Success = false
		result.Error = "managed storage runtime is not initialized"
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), managedStorageCommandTimeout)
	defer cancel()
	detail, err := p.storageManager.handle(ctx, cmd.GetAction(), cmd.GetManagedStorageId(), cmd.GetConfigJson())
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		return
	}
	result.Detail = detail
}

func (m *managedStorageManager) handle(ctx context.Context, action, id, configJSON string) (string, error) {
	if !managedStorageIDPattern.MatchString(id) {
		return "", errors.New("managed storage id must be a UUID")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	switch action {
	case "create":
		input, err := parseManagedStorageCommand(configJSON, true)
		if err != nil {
			return "", err
		}
		record, err := m.create(ctx, id, input)
		if err != nil {
			return "", err
		}
		if len(input.Members) > 1 {
			return m.marshalManagedStorageDetail(ctx, record, "creating")
		}
		return m.marshalManagedStorageDetail(ctx, record, "ready")
	case "update":
		input, err := parseManagedStorageCommand(configJSON, false)
		if err != nil {
			return "", err
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if record.Removed {
			return "", errors.New("managed storage was removed")
		}
		if input.Engine != record.engine() {
			return "", fmt.Errorf("managed storage engine mismatch: record is %s, update is %s", record.engine(), input.Engine)
		}
		if err := m.update(ctx, &record, input); err != nil {
			return "", err
		}
		if err := m.saveRecord(record); err != nil {
			return "", err
		}
		return m.marshalManagedStorageDetail(ctx, record, m.storageStatus(ctx, record))
	case "start", "restart":
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if record.Removed {
			return "", errors.New("managed storage was removed")
		}
		if err := m.ensureMounted(ctx, &record); err != nil {
			return "", err
		}
		if action == "restart" {
			_ = m.client.StopContainer(ctx, record.ContainerID, 20)
		}
		if err := m.startContainer(ctx, record.ContainerID); err != nil {
			return "", err
		}
		record.DesiredRunning = true
		if err := m.saveRecord(record); err != nil {
			return "", err
		}
		return m.marshalManagedStorageDetail(ctx, record, "running")
	case "stop":
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if err := m.client.StopContainer(ctx, record.ContainerID, 20); err != nil {
			return "", err
		}
		record.DesiredRunning = false
		if err := m.saveRecord(record); err != nil {
			return "", err
		}
		return m.marshalManagedStorageDetail(ctx, record, "stopped")
	case "remove", "delete_data":
		record, err := m.loadRecord(id)
		if errors.Is(err, os.ErrNotExist) {
			return `{"status":"missing"}`, nil
		}
		if err != nil {
			return "", err
		}
		deleteData := action == "delete_data"
		if !deleteData && configJSON != "" {
			var lifecycle struct {
				DeleteData bool `json:"deleteData"`
			}
			if json.Unmarshal([]byte(configJSON), &lifecycle) == nil {
				deleteData = lifecycle.DeleteData
			}
		}
		if err := m.remove(ctx, &record, deleteData); err != nil {
			return "", err
		}
		if deleteData {
			return `{"status":"deleted","dataDeleted":true}`, nil
		}
		return `{"status":"deleted","dataDeleted":false}`, nil
	case "inspect":
		record, err := m.loadRecord(id)
		if errors.Is(err, os.ErrNotExist) {
			return `{"status":"missing"}`, nil
		}
		if err != nil {
			return "", err
		}
		return m.marshalManagedStorageDetail(ctx, record, m.storageStatus(ctx, record))
	case "iam_create_key", "iam_list_keys", "iam_remove_key":
		input, err := parseManagedStorageIAMCommand(configJSON)
		if err != nil {
			return "", err
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if record.Removed {
			return "", errors.New("managed storage was removed")
		}
		if input.Engine != "" && input.Engine != record.engine() {
			return "", fmt.Errorf("managed storage engine mismatch: record is %s, IAM command is %s", record.engine(), input.Engine)
		}
		if record.engine() == managedStorageEngineSeaweedFS {
			return m.handleSeaweedFSIAM(ctx, action, record, input)
		}
		return m.handleIAM(ctx, action, record, input)
	default:
		return "", fmt.Errorf("unsupported managed storage action: %s", action)
	}
}

// decodeManagedStorageCommand parses the shared JSON envelope. Version 1 is the
// MinIO contract and version 2 the SeaweedFS contract; an old daemon rejects
// version 2 on its own version check, so a SeaweedFS payload can never be
// misread as a MinIO one.
func decodeManagedStorageCommand(raw string) (managedStorageCommand, error) {
	var input managedStorageCommand
	if raw == "" {
		return input, errors.New("managed storage config is required")
	}
	if err := json.Unmarshal([]byte(raw), &input); err != nil {
		return input, fmt.Errorf("parse managed storage config: %w", err)
	}
	if input.Version != 1 && input.Version != 2 {
		return input, errors.New("managed storage config version must be 1 or 2")
	}
	if input.OperationID != "" && !managedStorageIDPattern.MatchString(input.OperationID) {
		return input, errors.New("managed storage operation id must be a UUID")
	}
	return input, nil
}

// normalizeWorkloadEngine binds the payload version to its engine for create
// and update commands.
func normalizeWorkloadEngine(input *managedStorageCommand) error {
	switch input.Version {
	case 1:
		if input.Engine != "" && input.Engine != managedStorageEngineMinIO {
			return errors.New("managed storage config version 1 is only valid for the MinIO engine")
		}
		input.Engine = managedStorageEngineMinIO
	case 2:
		if input.Engine != managedStorageEngineSeaweedFS {
			return errors.New("managed storage config version 2 requires engine seaweedfs")
		}
	}
	return nil
}

// parseManagedStorageIAMCommand accepts either payload version: the IAM
// envelope is shared and the stored record decides the engine. A present
// engine field must still match the record (checked by the caller).
func parseManagedStorageIAMCommand(raw string) (managedStorageCommand, error) {
	input, err := decodeManagedStorageCommand(raw)
	if err != nil {
		return input, err
	}
	if input.Engine != "" && input.Engine != managedStorageEngineMinIO && input.Engine != managedStorageEngineSeaweedFS {
		return input, errors.New("managed storage engine is not supported")
	}
	if input.TLS != nil {
		transport, err := managedStorageTLSTransport(input.TLS)
		if err != nil {
			return input, err
		}
		transport.CloseIdleConnections()
	}
	return input, nil
}

func parseManagedStorageCommand(raw string, creating bool) (managedStorageCommand, error) {
	input, err := decodeManagedStorageCommand(raw)
	if err != nil {
		return input, err
	}
	if err := normalizeWorkloadEngine(&input); err != nil {
		return input, err
	}
	if input.Engine == managedStorageEngineSeaweedFS {
		return input, validateSeaweedFSCommand(input, creating)
	}
	if !creating {
		if err := validateManagedStorageTransport(input); err != nil {
			return input, err
		}
		if input.PublishS3 && input.PublishedPort == 0 {
			return input, errors.New("public managed storage requires a published port")
		}
		return input, nil
	}
	if input.ImageCatalogID != minioCatalogID || input.Image != trustedMinioImage {
		return input, errors.New("managed storage image must be a trusted digest-pinned MinIO catalog image")
	}
	if input.RootCredentials.AccessKey == "" || input.RootCredentials.SecretKey == "" {
		return input, errors.New("managed storage root credentials are required")
	}
	if input.PublishS3 && input.PublishedPort == 0 {
		return input, errors.New("public managed storage requires a published port")
	}
	if len(input.Members) > 1 {
		if input.PublishedPort == 0 || !validStoragePeerBindAddress(input.PeerBindAddress) {
			return input, errors.New("distributed managed storage requires a concrete peer bind address and port")
		}
	} else if !input.PublishS3 && (input.PublishedPort != 0 || input.PeerBindAddress != "") {
		return input, errors.New("private single-node storage cannot publish a host port")
	}
	if input.MemberIndex < 0 || input.MemberIndex > 9999 {
		return input, errors.New("managed storage member index is invalid")
	}
	if err := validateManagedStorageResources(input.Resources, 256*1024*1024); err != nil {
		return input, err
	}
	if err := validateManagedStorageTransport(input); err != nil {
		return input, err
	}
	for _, member := range input.Members {
		if member.MemberIndex < 0 || member.MemberIndex > 9999 || !validStorageMemberEndpoint(member.Endpoint) {
			return input, errors.New("managed storage member endpoint is invalid")
		}
	}
	return input, nil
}

func validateManagedStorageResources(resources managedStorageResources, minimumMemory int64) error {
	if resources.StorageBytes < minimumStorageBytes || resources.StorageBytes > maximumStorageBytes {
		return errors.New("managed storage size is outside the supported range")
	}
	if resources.NanoCPUs < minimumStorageNanoCPUs || resources.NanoCPUs > maximumStorageNanoCPUs {
		return errors.New("managed storage CPU limit is outside the supported range")
	}
	if resources.MemoryBytes < minimumMemory || resources.MemoryBytes > maximumStorageMemoryBytes {
		return errors.New("managed storage memory limit is outside the supported range")
	}
	if resources.MemorySwapBytes != 0 && resources.MemorySwapBytes < resources.MemoryBytes {
		return errors.New("managed storage swap limit must be zero or at least memory limit")
	}
	return nil
}

func validateManagedStorageTransport(input managedStorageCommand) error {
	if input.TLS != nil && (input.TLS.CertPEM == "" || input.TLS.KeyPEM == "" || input.TLS.CAPEM == "" || input.TLS.ServerName == "") {
		return errors.New("managed storage TLS requires certificate, key, CA and server name")
	}
	if input.FTP != nil && (input.FTP.Port == 0 || input.FTP.PassivePortStart == 0 || input.FTP.PassivePortCount == 0 || uint32(input.FTP.PassivePortStart)+uint32(input.FTP.PassivePortCount)-1 > 65535) {
		return errors.New("managed storage FTP passive port range is invalid")
	}
	if input.SFTP != nil && (input.SFTP.Port == 0 || input.SFTP.HostKeyPEM == "" || len(input.SFTP.HostKeyPEM) > 64*1024) {
		return errors.New("managed storage SFTP configuration is invalid")
	}
	return nil
}

func validStorageMemberEndpoint(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.RawQuery != "" || u.Fragment != "" {
		return false
	}
	return !strings.Contains(u.Path, "..")
}

func validStoragePeerBindAddress(raw string) bool {
	address, err := netip.ParseAddr(raw)
	return err == nil && address.IsValid() && !address.IsUnspecified()
}

func (m *managedStorageManager) create(ctx context.Context, id string, input managedStorageCommand) (managedStorageRecord, error) {
	if existing, err := m.loadRecord(id); err == nil {
		if existing.OperationID != input.OperationID || existing.OperationID == "" {
			return managedStorageRecord{}, errors.New("managed storage id is already allocated")
		}
		if existing.engine() != input.Engine {
			return managedStorageRecord{}, errors.New("managed storage id is already allocated to another engine")
		}
		if err := m.repairCreate(ctx, &existing, input); err != nil {
			return managedStorageRecord{}, err
		}
		if len(input.Members) <= 1 {
			if err := m.waitForReady(ctx, existing); err != nil {
				return managedStorageRecord{}, err
			}
		}
		return existing, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return managedStorageRecord{}, err
	}
	if err := m.ensureCapacity(input.Resources.StorageBytes); err != nil {
		return managedStorageRecord{}, err
	}
	// Resolve the runtime image before allocating anything: a node that cannot
	// obtain it must fail with a typed error and leave no disk image behind.
	image, err := m.ensureEngineImage(ctx, input.Engine)
	if err != nil {
		return managedStorageRecord{}, err
	}
	record := managedStorageRecord{
		ID: id, Engine: input.Engine, ContainerName: fmt.Sprintf("gateway-storage-%s-%d", id, input.MemberIndex), NetworkName: "gateway-storage-" + id,
		ImagePath: filepath.Join(m.root, "storage", "images", fmt.Sprintf("%s-%d.img", id, input.MemberIndex)), MountPath: filepath.Join(m.root, "storage", "mounts", fmt.Sprintf("%s-%d", id, input.MemberIndex)),
		StorageBytes: input.Resources.StorageBytes, NanoCPUs: input.Resources.NanoCPUs, MemoryBytes: input.Resources.MemoryBytes,
		MemorySwapBytes: input.Resources.MemorySwapBytes, Image: image, MemberIndex: input.MemberIndex, MemberCount: max(1, len(input.Members)), PublishS3: input.PublishS3,
		PublishedPort: input.PublishedPort, PeerBindAddress: input.PeerBindAddress, TLSEnabled: input.TLS != nil,
		DesiredRunning: true, OperationID: input.OperationID,
	}
	if input.TLS != nil {
		record.TLSServerName = input.TLS.ServerName
	}
	if input.FTP != nil {
		record.FTPPort = input.FTP.Port
		record.FTPPassiveStart = input.FTP.PassivePortStart
		record.FTPPassiveCount = input.FTP.PassivePortCount
	}
	if input.SFTP != nil {
		record.SFTPPort = input.SFTP.Port
	}
	if err := m.createImage(ctx, record); err != nil {
		return managedStorageRecord{}, err
	}
	if err := m.ensureMounted(ctx, &record); err != nil {
		_ = os.Remove(record.ImagePath)
		return managedStorageRecord{}, err
	}
	if err := m.prepareEngineDataRoot(record); err != nil {
		_ = m.cleanupStorage(ctx, &record, true)
		return managedStorageRecord{}, err
	}
	if err := m.createNetwork(ctx, record); err != nil {
		_ = m.cleanupStorage(ctx, &record, true)
		return managedStorageRecord{}, err
	}
	containerID, err := m.createEngineContainer(ctx, &record, input)
	if err != nil {
		_ = m.cleanupStorage(ctx, &record, true)
		return managedStorageRecord{}, err
	}
	record.ContainerID = containerID
	if err := m.saveRecord(record); err != nil {
		_ = m.client.RemoveContainer(ctx, containerID, true)
		_ = m.cleanupStorage(ctx, &record, true)
		return managedStorageRecord{}, err
	}
	if len(input.Members) <= 1 {
		if err := m.waitForReady(ctx, record); err != nil {
			_ = m.client.RemoveContainer(ctx, containerID, true)
			_ = m.cleanupStorage(ctx, &record, true)
			return managedStorageRecord{}, err
		}
	}
	return record, nil
}

// repairCreate makes same-operation create retries converge after a daemon or
// Docker interruption. The durable record contains no credentials, so the
// retry payload supplies them only to recreate the verified owned container.
func (m *managedStorageManager) repairCreate(ctx context.Context, record *managedStorageRecord, input managedStorageCommand) error {
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err == nil && inspect.Container.Config != nil && inspect.Container.Config.Labels[managedStorageLabel] == record.ID &&
		inspect.Container.Config.Labels[managedStorageMemberLabel] == strconv.Itoa(record.MemberIndex) {
		if err := m.ensureMounted(ctx, record); err != nil {
			return err
		}
		if err := m.startContainer(ctx, record.ContainerID); err != nil {
			return err
		}
		return m.saveRecord(*record)
	}
	if err != nil && !isNotFoundErr(err) {
		return fmt.Errorf("inspect existing managed storage container: %w", err)
	}
	if record.ContainerID != "" && err == nil {
		return errors.New("managed storage container identity is invalid")
	}
	image, err := m.ensureEngineImage(ctx, record.engine())
	if err != nil {
		return err
	}
	record.Image = image
	if err := m.ensureMounted(ctx, record); err != nil {
		return err
	}
	if err := m.prepareEngineDataRoot(*record); err != nil {
		return err
	}
	if err := m.createNetwork(ctx, *record); err != nil {
		return err
	}
	containerID, err := m.createEngineContainer(ctx, record, input)
	if err != nil {
		return err
	}
	record.ContainerID = containerID
	record.DesiredRunning = true
	return m.saveRecord(*record)
}

func (m *managedStorageManager) update(ctx context.Context, record *managedStorageRecord, input managedStorageCommand) error {
	previousStorageBytes := record.StorageBytes
	if input.Resources.StorageBytes != 0 {
		if input.Resources.StorageBytes < record.StorageBytes {
			return errors.New("managed storage cannot be reduced")
		}
		if input.Resources.StorageBytes > maximumStorageBytes {
			return errors.New("managed storage size is outside the supported range")
		}
		if err := m.ensureStorageSize(ctx, record, input.Resources.StorageBytes); err != nil {
			return err
		}
		record.StorageBytes = input.Resources.StorageBytes
	}
	resources := container.Resources{Memory: record.MemoryBytes, MemorySwap: record.MemorySwapBytes, NanoCPUs: record.NanoCPUs}
	if input.Resources.NanoCPUs != 0 {
		if input.Resources.NanoCPUs < minimumStorageNanoCPUs || input.Resources.NanoCPUs > maximumStorageNanoCPUs {
			return errors.New("managed storage CPU limit is outside the supported range")
		}
		record.NanoCPUs = input.Resources.NanoCPUs
		resources.NanoCPUs = record.NanoCPUs
	}
	if input.Resources.MemoryBytes != 0 {
		if input.Resources.MemoryBytes < managedStorageMinimumMemory(record.engine()) || input.Resources.MemoryBytes > maximumStorageMemoryBytes {
			return errors.New("managed storage memory limit is outside the supported range")
		}
		record.MemoryBytes = input.Resources.MemoryBytes
		resources.Memory = record.MemoryBytes
	}
	if input.Resources.MemorySwapBytes != 0 {
		if input.Resources.MemorySwapBytes < resources.Memory {
			return errors.New("managed storage swap limit must be zero or at least memory limit")
		}
		record.MemorySwapBytes = input.Resources.MemorySwapBytes
		resources.MemorySwap = record.MemorySwapBytes
	}
	if _, err := m.client.cli.ContainerUpdate(ctx, record.ContainerID, mobyclient.ContainerUpdateOptions{Resources: &resources}); err != nil {
		return fmt.Errorf("update managed storage resources: %w", err)
	}
	if input.OperationID != "" {
		record.OperationID = input.OperationID
	}
	// A publication change cannot be applied to a live container: the port
	// binding (and the network's internal flag) are fixed at creation. A
	// SeaweedFS disk grow also recreates, because volume sizing flags are
	// derived from the disk size.
	grewSeaweedFS := record.engine() == managedStorageEngineSeaweedFS && record.StorageBytes > previousStorageBytes
	if managedStoragePublicationChanged(*record, input) || grewSeaweedFS {
		return m.recreate(ctx, record, input)
	}
	if record.engine() == managedStorageEngineSeaweedFS {
		return m.updateSeaweedFSInPlace(ctx, record, input)
	}
	if input.FTP != nil && (record.FTPPort != input.FTP.Port || record.FTPPassiveStart != input.FTP.PassivePortStart || record.FTPPassiveCount != input.FTP.PassivePortCount) {
		return errors.New("managed storage FTP configuration requires recreation")
	}
	restartRequired := false
	if input.SFTP != nil {
		if input.SFTP.Port != record.SFTPPort {
			return errors.New("managed storage SFTP port requires recreation")
		}
		if _, err := m.stageSFTPHostKey(*record, input.SFTP.HostKeyPEM); err != nil {
			return err
		}
		restartRequired = true
	}
	if input.TLS != nil {
		if _, err := m.stageTLS(*record, *input.TLS); err != nil {
			return err
		}
		record.TLSEnabled = true
		record.TLSServerName = input.TLS.ServerName
		restartRequired = true
	}
	if restartRequired {
		if err := m.client.StopContainer(ctx, record.ContainerID, 20); err != nil {
			return err
		}
		if err := m.startContainer(ctx, record.ContainerID); err != nil {
			return err
		}
	}
	return nil
}

// managedStoragePublicationChanged compares an update's publication with the
// running container's. Update payloads always carry the full publication, so a
// difference is a requested change, never an omitted field.
func managedStoragePublicationChanged(record managedStorageRecord, input managedStorageCommand) bool {
	if input.PublishS3 != record.PublishS3 || input.PublishedPort != record.PublishedPort {
		return true
	}
	return input.PeerBindAddress != "" && input.PeerBindAddress != record.PeerBindAddress
}

func managedStorageMinimumMemory(engine string) int64 {
	if engine == managedStorageEngineSeaweedFS {
		return minimumSeaweedFSMemoryBytes
	}
	return 256 * 1024 * 1024
}

func (m *managedStorageManager) createEngineContainer(ctx context.Context, record *managedStorageRecord, input managedStorageCommand) (string, error) {
	if record.engine() == managedStorageEngineSeaweedFS {
		return m.createSeaweedFSContainer(ctx, record, input)
	}
	return m.createContainer(ctx, record, input)
}

func (m *managedStorageManager) createContainer(ctx context.Context, record *managedStorageRecord, input managedStorageCommand) (string, error) {
	image := record.Image
	if image == "" {
		image = input.Image
	}
	s3Port, _ := network.ParsePort("9000/tcp")
	containerCfg := &container.Config{Image: image, Env: []string{"MINIO_ROOT_USER=" + input.RootCredentials.AccessKey, "MINIO_ROOT_PASSWORD=" + input.RootCredentials.SecretKey}, Cmd: minioCommand(input), Labels: map[string]string{managedStorageLabel: record.ID, managedStorageMemberLabel: strconv.Itoa(record.MemberIndex)}}
	binds := []string{record.MountPath + ":/data"}
	if input.TLS != nil {
		tlsDirectory, err := m.stageTLS(*record, *input.TLS)
		if err != nil {
			return "", err
		}
		binds = append(binds, tlsDirectory+":/run/gateway-minio-certs:ro")
	}
	if input.SFTP != nil {
		hostKeyPath, err := m.stageSFTPHostKey(*record, input.SFTP.HostKeyPEM)
		if err != nil {
			return "", err
		}
		binds = append(binds, hostKeyPath+":/run/gateway-minio-sftp/host-key:ro")
	}
	hostCfg := &container.HostConfig{Binds: binds, RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyUnlessStopped}, Resources: container.Resources{Memory: record.MemoryBytes, MemorySwap: record.MemorySwapBytes, NanoCPUs: record.NanoCPUs}, LogConfig: container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "10m", "max-file": "3"}}}
	if record.PublishS3 || record.PeerBindAddress != "" {
		containerCfg.ExposedPorts = network.PortSet{s3Port: {}}
		// Public S3 binds wildcard so the member is peer-reachable too. Private
		// distributed members bind only their concrete peer address.
		bindAddress := netip.MustParseAddr("0.0.0.0")
		if !record.PublishS3 && record.PeerBindAddress != "" {
			bindAddress = netip.MustParseAddr(record.PeerBindAddress)
		}
		hostCfg.PortBindings = network.PortMap{s3Port: {{HostIP: bindAddress, HostPort: strconv.Itoa(int(record.PublishedPort))}}}
	}
	if input.FTP != nil || input.SFTP != nil {
		if containerCfg.ExposedPorts == nil {
			containerCfg.ExposedPorts = network.PortSet{}
		}
		if hostCfg.PortBindings == nil {
			hostCfg.PortBindings = network.PortMap{}
		}
	}
	if input.FTP != nil {
		ftpPort, _ := network.ParsePort(strconv.Itoa(int(input.FTP.Port)) + "/tcp")
		containerCfg.ExposedPorts[ftpPort] = struct{}{}
		hostCfg.PortBindings[ftpPort] = []network.PortBinding{{HostIP: netip.MustParseAddr("0.0.0.0"), HostPort: strconv.Itoa(int(input.FTP.Port))}}
		for offset := uint16(0); offset < input.FTP.PassivePortCount; offset++ {
			port := input.FTP.PassivePortStart + offset
			passivePort, _ := network.ParsePort(strconv.Itoa(int(port)) + "/tcp")
			containerCfg.ExposedPorts[passivePort] = struct{}{}
			hostCfg.PortBindings[passivePort] = []network.PortBinding{{HostIP: netip.MustParseAddr("0.0.0.0"), HostPort: strconv.Itoa(int(port))}}
		}
	}
	if input.SFTP != nil {
		sftpPort, _ := network.ParsePort(strconv.Itoa(int(input.SFTP.Port)) + "/tcp")
		containerCfg.ExposedPorts[sftpPort] = struct{}{}
		hostCfg.PortBindings[sftpPort] = []network.PortBinding{{HostIP: netip.MustParseAddr("0.0.0.0"), HostPort: strconv.Itoa(int(input.SFTP.Port))}}
	}
	created, err := m.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{Config: containerCfg, HostConfig: hostCfg, NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{record.NetworkName: {Aliases: []string{"minio"}}}}, Name: record.ContainerName})
	if err != nil {
		return "", fmt.Errorf("create managed storage container: %w", err)
	}
	if _, err := m.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
		_ = m.client.RemoveContainer(ctx, created.ID, true)
		return "", fmt.Errorf("start managed storage container: %w", err)
	}
	return created.ID, nil
}

func minioCommand(input managedStorageCommand) []string {
	args := []string{"server", "--address", ":9000", "--console-address", ":9001"}
	if input.TLS != nil {
		args = append(args, "--certs-dir", "/run/gateway-minio-certs")
	}
	if input.FTP != nil {
		args = append(args, "--ftp=address=:"+strconv.Itoa(int(input.FTP.Port)))
		args = append(args, "--ftp=passive-port-range="+strconv.Itoa(int(input.FTP.PassivePortStart))+"-"+strconv.Itoa(int(input.FTP.PassivePortStart+input.FTP.PassivePortCount-1)))
	}
	if input.SFTP != nil {
		args = append(args, "--sftp=address=:"+strconv.Itoa(int(input.SFTP.Port)))
		args = append(args, "--sftp=ssh-private-key=/run/gateway-minio-sftp/host-key")
	}
	if len(input.Members) == 0 {
		return append(args, "/data")
	}
	members := append([]managedStorageMember(nil), input.Members...)
	sort.Slice(members, func(i, j int) bool { return members[i].MemberIndex < members[j].MemberIndex })
	for _, member := range members {
		args = append(args, member.Endpoint)
	}
	return args
}
