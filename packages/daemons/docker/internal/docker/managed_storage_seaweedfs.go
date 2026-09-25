package docker

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/netip"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

// SeaweedFS runtime contract (rc.8): one `weed server` container per cluster
// (single node only), S3 on container port 9000, master/volume/filer bound to
// loopback inside the container, identities and TLS staged by the daemon.
const (
	seaweedfsCatalogID    = "seaweedfs-4.47"
	seaweedfsImageDigest  = "sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882"
	seaweedfsUpstreamRepo = "docker.io/chrislusf/seaweedfs"
	// seaweedfsUpstreamImage is listed in config/third-party-images.json, so
	// EnsureThirdPartyImage tries the GHCR mirror before Docker Hub.
	seaweedfsUpstreamImage = seaweedfsUpstreamRepo + "@" + seaweedfsImageDigest

	minimumSeaweedFSMemoryBytes = 512 * 1024 * 1024

	// The image's own user. The daemon runs the binary directly as this user
	// (no root entrypoint, no recursive chown) and hands it the data root.
	seaweedfsRuntimeUID = 1000
	seaweedfsRuntimeGID = 1000

	seaweedfsRootIdentity    = "gateway-root"
	seaweedfsContainerRoot   = "/run/gateway-storage"
	seaweedfsReadyTimeout    = 3 * time.Minute
	seaweedfsBucketAllowance = 256
	mebibyte                 = 1024 * 1024
)

var seaweedfsRootAccessKeyPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$`)

// validateSeaweedFSCommand checks a version 2 payload. FTP/SFTP, distributed
// topology and peer publication are not part of the SeaweedFS contract.
func validateSeaweedFSCommand(input managedStorageCommand, creating bool) error {
	if input.FTP != nil || input.SFTP != nil {
		return errors.New("SeaweedFS managed storage does not support FTP or SFTP")
	}
	if len(input.Members) > 1 || (len(input.Members) == 1 && input.Members[0].MemberIndex != 0) || input.MemberIndex != 0 {
		return errors.New("SeaweedFS managed storage is single-node")
	}
	if input.PeerBindAddress != "" {
		return errors.New("SeaweedFS managed storage does not bind a peer address")
	}
	if input.PublishS3 && input.PublishedPort == 0 {
		return errors.New("public managed storage requires a published port")
	}
	if !input.PublishS3 && input.PublishedPort != 0 {
		return errors.New("private single-node storage cannot publish a host port")
	}
	if err := validateManagedStorageTransport(input); err != nil {
		return err
	}
	if input.Image != "" && !isTrustedSeaweedFSImage(input.Image) {
		return errors.New("managed storage image must be the trusted digest-pinned SeaweedFS image")
	}
	if !creating {
		if input.Resources.MemoryBytes != 0 && input.Resources.MemoryBytes < minimumSeaweedFSMemoryBytes {
			return errors.New("managed storage memory limit is outside the supported range")
		}
		if input.RootCredentials.AccessKey != "" || input.RootCredentials.SecretKey != "" {
			return validateSeaweedFSRootCredentials(input.RootCredentials)
		}
		return nil
	}
	if input.ImageCatalogID != seaweedfsCatalogID {
		return errors.New("managed storage catalog id must be " + seaweedfsCatalogID)
	}
	if err := validateSeaweedFSRootCredentials(input.RootCredentials); err != nil {
		return err
	}
	return validateManagedStorageResources(input.Resources, minimumSeaweedFSMemoryBytes)
}

func validateSeaweedFSRootCredentials(credentials managedStorageRootCreds) error {
	if !seaweedfsRootAccessKeyPattern.MatchString(credentials.AccessKey) {
		return errors.New("managed storage root access key must be 3-128 characters of letters, digits, '.', '_' or '-'")
	}
	if len(credentials.SecretKey) < 8 || len(credentials.SecretKey) > 256 || strings.ContainsFunc(credentials.SecretKey, func(r rune) bool { return r < 0x21 || r > 0x7e }) {
		return errors.New("managed storage root secret key must be 8-256 printable characters")
	}
	return nil
}

func isTrustedSeaweedFSImage(reference string) bool {
	return reference == seaweedfsUpstreamImage || isThirdPartyMirrorOf(reference, seaweedfsUpstreamImage)
}

// seaweedfsSizing derives volume flags from the disk size. Each bucket is its
// own collection and needs at least one volume, so the volume count is
// overcommitted by a bucket allowance: volumes are not preallocated, and the
// disk itself, guarded by minFreeSpace, is the real capacity limit.
type seaweedfsSizing struct {
	VolumeSizeLimitMB int64
	VolumeMax         int64
	MinFreeSpaceMiB   int64
}

func seaweedfsSizingFor(storageBytes int64) seaweedfsSizing {
	diskMiB := max(int64(1), storageBytes/mebibyte)
	volume := min(max(diskMiB/64, 32), 1024)
	dataVolumes := (diskMiB + volume - 1) / volume
	return seaweedfsSizing{
		VolumeSizeLimitMB: volume,
		VolumeMax:         dataVolumes + seaweedfsBucketAllowance,
		MinFreeSpaceMiB:   min(max(diskMiB*5/100, 64), 2048),
	}
}

func (m *managedStorageManager) seaweedfsStagingDir(record managedStorageRecord) string {
	return filepath.Join(m.root, "storage", "seaweedfs", fmt.Sprintf("%s-%d", record.ID, record.MemberIndex))
}

func seaweedfsCommand(record managedStorageRecord) []string {
	sizing := seaweedfsSizingFor(record.StorageBytes)
	args := []string{
		"-logtostderr=true",
		"-config_dir=" + seaweedfsContainerRoot + "/config",
		"server",
		"-dir=/data",
		"-ip=127.0.0.1",
		"-ip.bind=127.0.0.1",
		"-master.defaultReplication=000",
		"-master.volumePreallocate=false",
		"-master.volumeSizeLimitMB=" + strconv.FormatInt(sizing.VolumeSizeLimitMB, 10),
		"-volume.max=" + strconv.FormatInt(sizing.VolumeMax, 10),
		"-volume.index=memory",
		"-volume.minFreeSpace=" + strconv.FormatInt(sizing.MinFreeSpaceMiB, 10) + "MiB",
		// Single node: there is no other volume server to drain writes to, so
		// the default 10 s pre-stop wait only delays restarts.
		"-volume.preStopSeconds=2",
		"-s3",
		"-s3.port=9000",
		"-s3.ip.bind=0.0.0.0",
		"-s3.config=" + seaweedfsContainerRoot + "/config/s3.json",
		"-s3.iam=true",
		"-s3.iam.readOnly=false",
		"-s3.allowDeleteBucketNotEmpty=false",
		"-s3.port.iceberg=0",
		"-s3.port.lance=0",
	}
	if record.TLSEnabled {
		args = append(args, "-s3.cert.file="+seaweedfsContainerRoot+"/tls/public.crt", "-s3.key.file="+seaweedfsContainerRoot+"/tls/private.key")
	}
	return args
}

// seaweedfsHealthcheck probes every in-container component: master readiness
// (a leader exists), filer store access, volume server and the S3 listener.
func seaweedfsHealthcheck(tlsEnabled bool) *container.HealthConfig {
	s3 := "curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:9000/healthz"
	if tlsEnabled {
		// Loopback liveness only; the daemon verifies the certificate itself.
		s3 = "curl -fsSk -o /dev/null --max-time 3 https://127.0.0.1:9000/healthz"
	}
	return &container.HealthConfig{
		Test: []string{"CMD-SHELL", strings.Join([]string{
			"curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:9333/readyz",
			"curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:8888/healthz",
			"curl -fsS -o /dev/null --max-time 3 http://127.0.0.1:8080/healthz",
			s3,
		}, " && ")},
		Interval:      10 * time.Second,
		Timeout:       8 * time.Second,
		StartPeriod:   2 * time.Minute,
		StartInterval: 2 * time.Second,
		Retries:       3,
	}
}

func (m *managedStorageManager) createSeaweedFSContainer(ctx context.Context, record *managedStorageRecord, input managedStorageCommand) (string, error) {
	image := record.Image
	if image == "" {
		return "", errors.New("managed storage image is not resolved")
	}
	staging, err := m.stageSeaweedFS(*record, input)
	if err != nil {
		return "", err
	}
	s3Port, _ := network.ParsePort("9000/tcp")
	containerCfg := &container.Config{
		Image:      image,
		User:       fmt.Sprintf("%d:%d", seaweedfsRuntimeUID, seaweedfsRuntimeGID),
		Entrypoint: []string{"/usr/bin/weed"},
		Cmd:        seaweedfsCommand(*record),
		Env:        []string{"GOMEMLIMIT=" + strconv.FormatInt(max(int64(64), record.MemoryBytes*85/100/mebibyte), 10) + "MiB"},
		Labels: map[string]string{
			managedStorageLabel:       record.ID,
			managedStorageMemberLabel: strconv.Itoa(record.MemberIndex),
			managedStorageEngineLabel: managedStorageEngineSeaweedFS,
		},
		Healthcheck: seaweedfsHealthcheck(record.TLSEnabled),
	}
	hostCfg := &container.HostConfig{
		Binds:         []string{record.MountPath + ":/data", staging + ":" + seaweedfsContainerRoot + ":ro"},
		RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyUnlessStopped},
		Resources:     container.Resources{Memory: record.MemoryBytes, MemorySwap: record.MemorySwapBytes, NanoCPUs: record.NanoCPUs},
		LogConfig:     container.LogConfig{Type: "json-file", Config: map[string]string{"max-size": "10m", "max-file": "3"}},
		CapDrop:       []string{"ALL"},
		SecurityOpt:   []string{"no-new-privileges:true"},
	}
	if record.PublishS3 {
		containerCfg.ExposedPorts = network.PortSet{s3Port: {}}
		hostCfg.PortBindings = network.PortMap{s3Port: {{HostIP: netip.MustParseAddr("0.0.0.0"), HostPort: strconv.Itoa(int(record.PublishedPort))}}}
	}
	created, err := m.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{Config: containerCfg, HostConfig: hostCfg, NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{record.NetworkName: {Aliases: []string{"s3"}}}}, Name: record.ContainerName})
	if err != nil {
		return "", fmt.Errorf("create managed storage container: %w", err)
	}
	if _, err := m.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
		_ = m.client.RemoveContainer(ctx, created.ID, true)
		return "", fmt.Errorf("start managed storage container: %w", err)
	}
	return created.ID, nil
}

// updateSeaweedFSInPlace applies payload changes that only need a restart:
// rotated TLS material or root credentials.
func (m *managedStorageManager) updateSeaweedFSInPlace(ctx context.Context, record *managedStorageRecord, input managedStorageCommand) error {
	restartRequired := false
	if input.TLS != nil {
		if !record.TLSEnabled {
			return errors.New("enabling TLS on existing SeaweedFS storage requires recreation")
		}
		changed, err := m.restageSeaweedFSTLS(*record, *input.TLS)
		if err != nil {
			return err
		}
		record.TLSServerName = input.TLS.ServerName
		restartRequired = restartRequired || changed
	}
	if input.RootCredentials.AccessKey != "" {
		changed, err := m.restageSeaweedFSRootCredentials(*record, input.RootCredentials)
		if err != nil {
			return err
		}
		restartRequired = restartRequired || changed
	}
	if !restartRequired {
		return nil
	}
	if err := m.client.StopContainer(ctx, record.ContainerID, 20); err != nil {
		return err
	}
	if err := m.startContainer(ctx, record.ContainerID); err != nil {
		return err
	}
	return m.waitForReady(ctx, *record)
}

type seaweedfsIdentityConfig struct {
	Identities []seaweedfsIdentity `json:"identities"`
}

type seaweedfsIdentity struct {
	Name        string                `json:"name"`
	Credentials []seaweedfsCredential `json:"credentials"`
	Actions     []string              `json:"actions"`
}

type seaweedfsCredential struct {
	AccessKey string `json:"accessKey"`
	SecretKey string `json:"secretKey"`
}

func seaweedfsIdentityFile(credentials managedStorageRootCreds) ([]byte, error) {
	return json.MarshalIndent(seaweedfsIdentityConfig{Identities: []seaweedfsIdentity{{
		Name:        seaweedfsRootIdentity,
		Credentials: []seaweedfsCredential{{AccessKey: credentials.AccessKey, SecretKey: credentials.SecretKey}},
		Actions:     []string{"Admin", "Read", "Write", "List", "Tagging"},
	}}}, "", "  ")
}

// seaweedfsMasterConfig grows one volume per collection at a time. The
// default (7) exhausts volume slots after a handful of buckets on small disks.
const seaweedfsMasterConfig = `[master.volume_growth]
copy_1 = 1
copy_2 = 1
copy_3 = 1
copy_other = 1
`

// seaweedfsSecurityConfig sets a per-container filer signing key. It gates the
// S3 gRPC IAM cache (the only non-S3 port listening beyond loopback) and the
// filer IAM service behind admin-signed tokens.
func seaweedfsSecurityConfig() (string, error) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return "", err
	}
	return "[jwt.filer_signing]\nkey = \"" + hex.EncodeToString(key) + "\"\n", nil
}

// stageSeaweedFS writes the read-only runtime tree mounted at
// /run/gateway-storage: config/{s3.json,security.toml,master.toml} and, with
// TLS, tls/{public.crt,private.key,ca.crt}. Every entry is owned by the runtime
// user; files are 0400 and directories 0500.
func (m *managedStorageManager) stageSeaweedFS(record managedStorageRecord, input managedStorageCommand) (string, error) {
	root := m.seaweedfsStagingDir(record)
	configDir := filepath.Join(root, "config")
	if err := m.openStagingDirs(root, configDir); err != nil {
		return "", err
	}
	credentials := input.RootCredentials
	if credentials.AccessKey == "" || credentials.SecretKey == "" {
		accessKey, secretKey, err := m.readSeaweedFSRootCredentials(record)
		if err != nil {
			return "", fmt.Errorf("managed storage root credentials are required: %w", err)
		}
		credentials = managedStorageRootCreds{AccessKey: accessKey, SecretKey: secretKey}
	}
	identities, err := seaweedfsIdentityFile(credentials)
	if err != nil {
		return "", err
	}
	security, err := seaweedfsSecurityConfig()
	if err != nil {
		return "", fmt.Errorf("generate managed storage signing key: %w", err)
	}
	files := []struct {
		path    string
		content []byte
	}{
		{filepath.Join(configDir, "s3.json"), identities},
		{filepath.Join(configDir, "security.toml"), []byte(security)},
		{filepath.Join(configDir, "master.toml"), []byte(seaweedfsMasterConfig)},
	}
	tlsDir := filepath.Join(root, "tls")
	if input.TLS != nil {
		if err := m.openStagingDirs(tlsDir); err != nil {
			return "", err
		}
		files = append(files,
			struct {
				path    string
				content []byte
			}{filepath.Join(tlsDir, "public.crt"), []byte(input.TLS.CertPEM)},
			struct {
				path    string
				content []byte
			}{filepath.Join(tlsDir, "private.key"), []byte(input.TLS.KeyPEM)},
			struct {
				path    string
				content []byte
			}{filepath.Join(tlsDir, "ca.crt"), []byte(input.TLS.CAPEM)},
		)
	} else if !record.TLSEnabled {
		if err := removeStagingTree(tlsDir); err != nil {
			return "", err
		}
	} else if _, err := m.stagedSeaweedFSTLS(record); err != nil {
		return "", errors.New("managed storage TLS material is required")
	}
	for _, file := range files {
		if err := m.writeRuntimeFile(file.path, file.content); err != nil {
			return "", err
		}
	}
	if err := m.sealStagingDirs(root, configDir, tlsDir); err != nil {
		return "", err
	}
	return root, nil
}

func (m *managedStorageManager) restageSeaweedFSTLS(record managedStorageRecord, material managedStorageTLS) (bool, error) {
	root := m.seaweedfsStagingDir(record)
	tlsDir := filepath.Join(root, "tls")
	current, _ := os.ReadFile(filepath.Join(tlsDir, "public.crt"))
	currentKey, _ := os.ReadFile(filepath.Join(tlsDir, "private.key"))
	if string(current) == material.CertPEM && string(currentKey) == material.KeyPEM {
		return false, nil
	}
	if err := m.openStagingDirs(root, tlsDir); err != nil {
		return false, err
	}
	for name, content := range map[string]string{"public.crt": material.CertPEM, "private.key": material.KeyPEM, "ca.crt": material.CAPEM} {
		if err := m.writeRuntimeFile(filepath.Join(tlsDir, name), []byte(content)); err != nil {
			return false, err
		}
	}
	return true, m.sealStagingDirs(root, tlsDir)
}

func (m *managedStorageManager) restageSeaweedFSRootCredentials(record managedStorageRecord, credentials managedStorageRootCreds) (bool, error) {
	accessKey, secretKey, err := m.readSeaweedFSRootCredentials(record)
	if err == nil && accessKey == credentials.AccessKey && secretKey == credentials.SecretKey {
		return false, nil
	}
	root := m.seaweedfsStagingDir(record)
	configDir := filepath.Join(root, "config")
	identities, err := seaweedfsIdentityFile(credentials)
	if err != nil {
		return false, err
	}
	if err := m.openStagingDirs(root, configDir); err != nil {
		return false, err
	}
	if err := m.writeRuntimeFile(filepath.Join(configDir, "s3.json"), identities); err != nil {
		return false, err
	}
	return true, m.sealStagingDirs(root, configDir)
}

// readSeaweedFSRootCredentials returns the staged static root identity. The
// daemon uses it for IAM calls and container replacement, so neither depends
// on the backend resending the root secret.
func (m *managedStorageManager) readSeaweedFSRootCredentials(record managedStorageRecord) (string, string, error) {
	raw, err := os.ReadFile(filepath.Join(m.seaweedfsStagingDir(record), "config", "s3.json"))
	if err != nil {
		return "", "", err
	}
	var parsed seaweedfsIdentityConfig
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", "", fmt.Errorf("decode staged identities: %w", err)
	}
	for _, identity := range parsed.Identities {
		if identity.Name == seaweedfsRootIdentity && len(identity.Credentials) > 0 {
			return identity.Credentials[0].AccessKey, identity.Credentials[0].SecretKey, nil
		}
	}
	return "", "", errors.New("staged root identity is missing")
}

// stagedSeaweedFSTLS returns the staged CA bundle; it doubles as the check
// that the TLS tree is complete.
func (m *managedStorageManager) stagedSeaweedFSTLS(record managedStorageRecord) ([]byte, error) {
	tlsDir := filepath.Join(m.seaweedfsStagingDir(record), "tls")
	for _, name := range []string{"public.crt", "private.key"} {
		if _, err := os.Stat(filepath.Join(tlsDir, name)); err != nil {
			return nil, err
		}
	}
	return os.ReadFile(filepath.Join(tlsDir, "ca.crt"))
}

func (m *managedStorageManager) seaweedfsTransport(record managedStorageRecord) (*http.Transport, string, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	if !record.TLSEnabled {
		return transport, "http", nil
	}
	caPEM, err := m.stagedSeaweedFSTLS(record)
	if err != nil {
		return nil, "", fmt.Errorf("read managed storage CA: %w", err)
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, "", errors.New("managed storage CA is invalid")
	}
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool, ServerName: record.TLSServerName}
	return transport, "https", nil
}

// openStagingDirs creates (or reopens for writing) staging directories.
func (m *managedStorageManager) openStagingDirs(dirs ...string) error {
	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("create managed storage staging: %w", err)
		}
		if err := os.Chmod(dir, 0o700); err != nil {
			return err
		}
	}
	return nil
}

// sealStagingDirs hands directories to the runtime user read-only. Missing
// directories (for example an absent tls/) are skipped.
func (m *managedStorageManager) sealStagingDirs(dirs ...string) error {
	for _, dir := range dirs {
		if _, err := os.Stat(dir); errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err := m.chownRuntime(dir); err != nil {
			return fmt.Errorf("assign managed storage staging: %w", err)
		}
		if err := os.Chmod(dir, 0o500); err != nil {
			return err
		}
	}
	return nil
}

// writeRuntimeFile atomically replaces path with a 0400 file owned by the
// runtime user.
func (m *managedStorageManager) writeRuntimeFile(path string, content []byte) error {
	temporary := path + ".pending"
	_ = os.Remove(temporary)
	if err := os.WriteFile(temporary, content, 0o600); err != nil {
		return fmt.Errorf("stage %s: %w", filepath.Base(path), err)
	}
	if err := m.chownRuntime(temporary); err != nil {
		_ = os.Remove(temporary)
		return fmt.Errorf("assign %s: %w", filepath.Base(path), err)
	}
	if err := os.Chmod(temporary, 0o400); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

func (m *managedStorageManager) chownRuntime(path string) error {
	if m.chown != nil {
		return m.chown(path, seaweedfsRuntimeUID, seaweedfsRuntimeGID)
	}
	return os.Lchown(path, seaweedfsRuntimeUID, seaweedfsRuntimeGID)
}

func (m *managedStorageManager) removeSeaweedFSStaging(record managedStorageRecord) error {
	return removeStagingTree(m.seaweedfsStagingDir(record))
}

// removeStagingTree removes a sealed (0500) staging tree; directories are
// reopened first so removal does not depend on privileges.
func removeStagingTree(root string) error {
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err == nil && info.IsDir() {
			_ = os.Chmod(path, 0o700)
		}
		return nil
	})
	return os.RemoveAll(root)
}
