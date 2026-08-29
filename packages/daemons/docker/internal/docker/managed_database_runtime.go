package docker

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
)

func (m *managedDatabaseManager) createContainer(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) (string, error) {
	dataPath, port := engineDataPathAndPort(input.Type, input.TLSEnabled)
	dataSource, err := prepareManagedDatabaseDataSource(*record, input.Type)
	if err != nil {
		return "", err
	}
	env := engineEnvironment(input)
	containerCfg := &container.Config{
		Image: input.Image,
		Env:   env,
		Labels: map[string]string{
			managedDatabaseLabel:   record.ID,
			managedDatabaseTypeTag: input.Type,
		},
	}
	tlsDir := m.tlsDirectory(*record)
	if input.TLSEnabled {
		if err := writeManagedDatabaseTLS(tlsDir, input); err != nil {
			return "", err
		}
	}
	if input.Type == "postgres" && input.TLSEnabled {
		postgresHBAPath := managedPostgresTLSHBAPath(*record)
		if err := writeManagedPostgresTLSHBA(postgresHBAPath); err != nil {
			return "", fmt.Errorf("write PostgreSQL TLS authentication config: %w", err)
		}
		containerCfg.Cmd = []string{
			"postgres",
			"-c", "ssl=on",
			"-c", "ssl_cert_file=/run/gateway-tls/cert.pem",
			"-c", "ssl_key_file=/run/gateway-tls/key.pem",
			"-c", "hba_file=/run/gateway-config/pg_hba.conf",
		}
	}
	if input.Type == "redis" {
		if err := ensureManagedRedisACLFile(dataSource, input.OwnerPassword); err != nil {
			return "", fmt.Errorf("prepare Redis ACL file: %w", err)
		}
		redisConfigPath := managedRedisConfigPath(*record, input)
		if err := writeManagedRedisConfig(redisConfigPath, managedRedisConfigText(input)); err != nil {
			return "", fmt.Errorf("write Redis managed config: %w", err)
		}
		containerCfg.Cmd = []string{"redis-server", "/run/gateway-config/redis.conf", "--dir", "/data"}
		if input.TLSEnabled {
			containerCfg.Cmd = append(containerCfg.Cmd, "--port", "6379", "--tls-port", "6380", "--tls-cert-file", "/run/gateway-tls/cert.pem", "--tls-key-file", "/run/gateway-tls/key.pem", "--tls-ca-cert-file", "/run/gateway-tls/ca.pem", "--tls-auth-clients", "no")
		}
	}
	if input.Type == "clickhouse" && input.ClickhouseConfig != "" {
		if err := writeClickHouseConfig(filepath.Join(record.MountPath, "gateway-managed.xml"), input.ClickhouseConfig); err != nil {
			return "", fmt.Errorf("write ClickHouse managed config: %w", err)
		}
	}
	if input.Type == "clickhouse" {
		if err := writeClickHouseConfig(filepath.Join(record.MountPath, "00-gateway-runtime.xml"), clickHouseRuntimeConfig); err != nil {
			return "", fmt.Errorf("write ClickHouse runtime config: %w", err)
		}
		if err := writeClickHouseOwnerOverride(
			clickHouseOwnerOverridePath(*record),
			clickHouseOwnerOverrideConfig(input.OwnerUsername, input.OwnerPassword),
		); err != nil {
			return "", fmt.Errorf("write ClickHouse owner override: %w", err)
		}
	}
	if input.Type == "clickhouse" && input.TLSEnabled {
		config := `<clickhouse><https_port>8443</https_port><tcp_port_secure>9440</tcp_port_secure><openSSL><server><certificateFile>/run/gateway-tls/cert.pem</certificateFile><privateKeyFile>/run/gateway-tls/key.pem</privateKeyFile></server></openSSL></clickhouse>`
		if err := writeClickHouseConfig(filepath.Join(record.MountPath, "gateway-tls.xml"), config); err != nil {
			return "", fmt.Errorf("write ClickHouse TLS config: %w", err)
		}
	}
	binds := []string{dataSource + ":" + dataPath}
	if input.Type == "redis" {
		binds = append(binds, managedRedisConfigPath(*record, input)+":/run/gateway-config/redis.conf:ro")
	}
	if input.Type == "postgres" && input.TLSEnabled {
		binds = append(binds, managedPostgresTLSHBAPath(*record)+":/run/gateway-config/pg_hba.conf:ro")
	}
	if input.TLSEnabled {
		binds = append(binds, tlsDir+":/run/gateway-tls:ro")
	}
	if input.Type == "clickhouse" && input.ClickhouseConfig != "" {
		binds = append(binds, filepath.Join(record.MountPath, "gateway-managed.xml")+":/etc/clickhouse-server/config.d/gateway-managed.xml:ro")
	}
	if input.Type == "clickhouse" {
		binds = append(binds, filepath.Join(record.MountPath, "00-gateway-runtime.xml")+":/etc/clickhouse-server/config.d/00-gateway-runtime.xml:ro")
		binds = append(binds, clickHouseOwnerOverridePath(*record)+":"+clickHouseOwnerOverrideContainerPath+":ro")
	}
	if input.Type == "clickhouse" && input.TLSEnabled {
		binds = append(binds, filepath.Join(record.MountPath, "gateway-tls.xml")+":/etc/clickhouse-server/config.d/gateway-tls.xml:ro")
	}
	hostCfg := &container.HostConfig{
		Binds: binds,
		LogConfig: container.LogConfig{
			Type: "json-file",
			Config: map[string]string{
				"max-size": "10m",
				"max-file": "3",
			},
		},
		Resources: container.Resources{
			Memory:     input.MemoryBytes,
			MemorySwap: input.MemorySwapBytes,
			NanoCPUs:   input.NanoCPUs,
			CPUShares:  input.CPUShares,
		},
	}
	if input.PidsLimit > 0 {
		pids := input.PidsLimit
		hostCfg.PidsLimit = &pids
	}
	if input.PublishTCP {
		containerPort, err := network.ParsePort(port)
		if err != nil {
			return "", fmt.Errorf("parse managed database port: %w", err)
		}
		containerCfg.ExposedPorts = network.PortSet{containerPort: {}}
		hostPort := ""
		if input.PublishedPort != 0 {
			hostPort = fmt.Sprintf("%d", input.PublishedPort)
		}
		hostCfg.PortBindings = network.PortMap{containerPort: {{HostIP: netip.MustParseAddr("0.0.0.0"), HostPort: hostPort}}}
		if input.Type == "clickhouse" && input.PublishNativeTCP {
			nativePort, parseErr := network.ParsePort(clickHouseNativePort(input.TLSEnabled))
			if parseErr != nil {
				return "", fmt.Errorf("parse ClickHouse native port: %w", parseErr)
			}
			containerCfg.ExposedPorts[nativePort] = struct{}{}
			nativeHostPort := ""
			if input.PublishedNativePort != 0 {
				nativeHostPort = fmt.Sprintf("%d", input.PublishedNativePort)
			}
			hostCfg.PortBindings[nativePort] = []network.PortBinding{{HostIP: netip.MustParseAddr("0.0.0.0"), HostPort: nativeHostPort}}
		}
	}
	created, err := m.client.cli.ContainerCreate(ctx, mobyclient.ContainerCreateOptions{
		Config:     containerCfg,
		HostConfig: hostCfg,
		NetworkingConfig: &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{
			record.NetworkName: {Aliases: []string{"database"}},
		}},
		Name: record.ContainerName,
	})
	if err != nil {
		return "", fmt.Errorf("create managed database container: %w", err)
	}
	if _, err := m.client.cli.ContainerStart(ctx, created.ID, mobyclient.ContainerStartOptions{}); err != nil {
		_ = m.client.RemoveContainer(ctx, created.ID, true)
		return "", fmt.Errorf("start managed database container: %w", err)
	}
	if err := m.waitForDatabaseReady(ctx, created.ID, input); err != nil {
		_ = m.client.RemoveContainer(ctx, created.ID, true)
		return "", err
	}
	if input.Type == "clickhouse" {
		if err := m.cleanupClickHouseSystemLogs(ctx, created.ID, input); err != nil {
			m.logger.Warn("cleanup legacy ClickHouse system logs", "id", record.ID, "error", err)
		}
	}
	if input.PublishTCP && (input.PublishedPort == 0 || (input.Type == "clickhouse" && input.PublishNativeTCP && input.PublishedNativePort == 0)) {
		inspect, err := m.client.cli.ContainerInspect(ctx, created.ID, mobyclient.ContainerInspectOptions{})
		if err != nil {
			_ = m.client.RemoveContainer(ctx, created.ID, true)
			return "", fmt.Errorf("inspect allocated managed database port: %w", err)
		}
		primaryPort, parseErr := network.ParsePort(port)
		if parseErr != nil {
			return "", fmt.Errorf("parse allocated managed database port: %w", parseErr)
		}
		bindings := inspect.Container.NetworkSettings.Ports[primaryPort]
		if len(bindings) != 1 || bindings[0].HostPort == "" {
			_ = m.client.RemoveContainer(ctx, created.ID, true)
			return "", errors.New("Docker did not allocate one managed database host port")
		}
		allocated, parseErr := strconv.ParseUint(bindings[0].HostPort, 10, 16)
		if parseErr != nil || allocated == 0 {
			_ = m.client.RemoveContainer(ctx, created.ID, true)
			return "", errors.New("Docker returned an invalid managed database host port")
		}
		record.PublishedPort = uint16(allocated)
		if input.Type == "clickhouse" && input.PublishNativeTCP {
			nativePort, parseErr := network.ParsePort(clickHouseNativePort(input.TLSEnabled))
			if parseErr != nil {
				return "", fmt.Errorf("parse allocated ClickHouse native port: %w", parseErr)
			}
			nativeBindings := inspect.Container.NetworkSettings.Ports[nativePort]
			if len(nativeBindings) != 1 || nativeBindings[0].HostPort == "" {
				_ = m.client.RemoveContainer(ctx, created.ID, true)
				return "", errors.New("Docker did not allocate one ClickHouse native host port")
			}
			allocatedNative, parseNativeErr := strconv.ParseUint(nativeBindings[0].HostPort, 10, 16)
			if parseNativeErr != nil || allocatedNative == 0 {
				_ = m.client.RemoveContainer(ctx, created.ID, true)
				return "", errors.New("Docker returned an invalid ClickHouse native host port")
			}
			record.PublishedNativePort = uint16(allocatedNative)
		}
	}
	if input.PublishTCP &&
		(input.PublishedPort == 0 || (input.Type == "clickhouse" && input.PublishNativeTCP && input.PublishedNativePort == 0)) {
		pinned := input
		pinned.PublishedPort = record.PublishedPort
		pinned.PublishedNativePort = record.PublishedNativePort
		if err := m.client.RemoveContainer(ctx, created.ID, true); err != nil && !cerrdefs.IsNotFound(err) {
			return "", fmt.Errorf("replace auto-assigned managed database publication: %w", err)
		}
		return m.createContainer(ctx, record, pinned)
	}
	return created.ID, nil
}

// Redis cannot safely use the ext4 filesystem root as /data for new
// curated image drops privileges before opening the AOF directory.
func prepareManagedDatabaseDataSource(record managedDatabaseRecord, engine string) (string, error) {
	if engine != "redis" {
		return record.MountPath, nil
	}

	path := filepath.Join(record.MountPath, "redis-data")
	if err := os.MkdirAll(path, 0750); err != nil {
		return "", fmt.Errorf("create Redis data directory: %w", err)
	}
	uid, gid, err := managedDatabaseTLSOwner(engine)
	if err != nil {
		return "", err
	}
	if err := os.Chown(path, uid, gid); err != nil {
		return "", fmt.Errorf("set Redis data directory ownership: %w", err)
	}
	if err := os.Chmod(path, 0750); err != nil {
		return "", fmt.Errorf("set Redis data directory permissions: %w", err)
	}
	return path, nil
}

func ensureManagedRedisACLFile(dataPath, ownerPassword string) error {
	aclPath := filepath.Join(dataPath, "users.acl")
	if _, err := os.Stat(aclPath); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	digest := sha256.Sum256([]byte(ownerPassword))
	contents := fmt.Sprintf("user default on #%x ~* &* +@all\n", digest)
	if err := os.WriteFile(aclPath, []byte(contents), 0600); err != nil {
		return err
	}
	uid, gid, err := managedDatabaseTLSOwner("redis")
	if err != nil {
		return err
	}
	if err := os.Chown(aclPath, uid, gid); err != nil {
		return err
	}
	return os.Chmod(aclPath, 0600)
}

func (m *managedDatabaseManager) cleanupClickHouseSystemLogs(ctx context.Context, containerID string, input managedDatabaseCommand) error {
	return m.runManagedDatabaseExec(
		ctx,
		containerID,
		[]string{"clickhouse-client", "--user", input.OwnerUsername, "--database", "system", "--multiquery"},
		clickHouseSystemLogCleanupSQL,
		[]string{"CLICKHOUSE_PASSWORD=" + input.OwnerPassword},
	)
}

func writeClickHouseConfig(path, contents string) error {
	if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
		return err
	}
	// WriteFile preserves the mode of an existing file. Explicitly converge it
	// because ClickHouse reads config.d after dropping root privileges.
	return os.Chmod(path, 0644)
}

func writeManagedRedisConfig(path, contents string) error {
	if err := os.WriteFile(path, []byte(contents), 0644); err != nil {
		return err
	}
	return os.Chmod(path, 0644)
}

// waitForDatabaseReady keeps lifecycle completion aligned with actual engine
// availability. Docker reports ContainerStart before a database has finished
// initialization, which otherwise produces a false-ready/offline UI transition.
func (m *managedDatabaseManager) waitForDatabaseReady(ctx context.Context, containerID string, input managedDatabaseCommand) error {
	readyCtx, cancel := context.WithTimeout(ctx, managedDatabaseReadinessTimeout)
	defer cancel()

	for {
		if err := m.probeDatabaseReady(readyCtx, containerID, input); err == nil {
			return nil
		}

		timer := time.NewTimer(managedDatabaseReadinessInterval)
		select {
		case <-readyCtx.Done():
			timer.Stop()
			return errors.New("managed database did not become ready before timeout")
		case <-timer.C:
		}
	}
}

func (m *managedDatabaseManager) probeDatabaseReady(ctx context.Context, containerID string, input managedDatabaseCommand) error {
	command, env, err := managedDatabaseReadinessCommand(input)
	if err != nil {
		return err
	}
	return m.runManagedDatabaseExec(ctx, containerID, command, "", env)
}

// managedDatabaseReadinessCommand only returns fixed engine client commands.
// Passwords are passed through the exec environment, never as process args.
func managedDatabaseReadinessCommand(input managedDatabaseCommand) ([]string, []string, error) {
	switch input.Type {
	case "postgres":
		return []string{"pg_isready", "-q", "-h", "127.0.0.1", "-U", input.OwnerUsername, "-d", input.DatabaseName}, []string{"PGPASSWORD=" + input.OwnerPassword}, nil
	case "redis":
		return []string{"redis-cli", "--no-auth-warning", "--user", "default", "PING"}, []string{"REDISCLI_AUTH=" + input.OwnerPassword}, nil
	case "clickhouse":
		return []string{"clickhouse-client", "--host", "127.0.0.1", "--user", input.OwnerUsername, "--database", input.DatabaseName, "--query", "SELECT 1"}, []string{"CLICKHOUSE_PASSWORD=" + input.OwnerPassword}, nil
	default:
		return nil, nil, errors.New("unsupported managed database engine")
	}
}

func engineDataPathAndPort(engine string, tlsEnabled bool) (string, string) {
	switch engine {
	case "postgres":
		return "/var/lib/postgresql/data", "5432/tcp"
	case "redis":
		if tlsEnabled {
			return "/data", "6380/tcp"
		}
		return "/data", "6379/tcp"
	default:
		if tlsEnabled {
			return "/var/lib/clickhouse", "8443/tcp"
		}
		return "/var/lib/clickhouse", "8123/tcp"
	}
}

func clickHouseNativePort(tlsEnabled bool) string {
	if tlsEnabled {
		return "9440/tcp"
	}
	return "9000/tcp"
}

func writeManagedDatabaseTLS(dir string, input managedDatabaseCommand) error {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return fmt.Errorf("create managed database TLS directory: %w", err)
	}
	uid, gid, err := managedDatabaseTLSOwner(input.Type)
	if err != nil {
		return err
	}
	if err := os.Chown(dir, uid, gid); err != nil {
		return fmt.Errorf("restrict managed database TLS directory: %w", err)
	}
	for _, file := range []struct {
		name, value string
		mode        os.FileMode
	}{
		{"cert.pem", input.TLSCertificatePEM, 0644},
		{"key.pem", input.TLSPrivateKeyPEM, 0600},
		{"ca.pem", input.TLSCACertificatePEM, 0644},
	} {
		if err := os.WriteFile(filepath.Join(dir, file.name), []byte(file.value), file.mode); err != nil {
			return fmt.Errorf("write managed database TLS material: %w", err)
		}
	}
	if err := os.Chown(filepath.Join(dir, "key.pem"), uid, gid); err != nil {
		return fmt.Errorf("restrict managed database TLS key: %w", err)
	}
	return nil
}

const managedPostgresTLSHBA = `# Managed by Gateway. Direct TCP clients must negotiate TLS.
local all all trust
hostssl all all 0.0.0.0/0 scram-sha-256
hostssl all all ::0/0 scram-sha-256
`

func managedPostgresTLSHBAPath(record managedDatabaseRecord) string {
	return filepath.Join(record.MountPath, "gateway-pg_hba.conf")
}

func writeManagedPostgresTLSHBA(path string) error {
	return os.WriteFile(path, []byte(managedPostgresTLSHBA), 0644)
}

// All accepted engine images are digest-pinned and use these service accounts.
// Keeping the private key outside the data volume and readable only by that
// account prevents it from being inherited by database backups or data mounts.
func managedDatabaseTLSOwner(engine string) (int, int, error) {
	switch engine {
	case "postgres", "redis":
		return 999, 999, nil
	case "clickhouse":
		return 101, 101, nil
	default:
		return 0, 0, errors.New("unsupported managed database engine")
	}
}

func engineEnvironment(input managedDatabaseCommand) []string {
	switch input.Type {
	case "postgres":
		// An ext4 image has a lost+found directory at its mount root. PostgreSQL
		// correctly refuses to initialize a cluster in that non-empty directory,
		// so keep the bind mount at its conventional parent and put PGDATA in an
		// engine-managed child directory.
		return []string{
			"POSTGRES_USER=" + input.OwnerUsername,
			"POSTGRES_PASSWORD=" + input.OwnerPassword,
			"POSTGRES_DB=" + input.DatabaseName,
			"PGDATA=/var/lib/postgresql/data/pgdata",
		}
	case "clickhouse":
		return []string{
			"CLICKHOUSE_USER=" + input.OwnerUsername,
			"CLICKHOUSE_PASSWORD=" + input.OwnerPassword,
			"CLICKHOUSE_DB=" + input.DatabaseName,
			// Gateway's internal owner creates and revokes the isolated users used
			// by direct publication and secure bindings. The official image keeps
			// SQL access management disabled unless this flag is explicit.
			"CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1",
		}
	default:
		return nil
	}
}

func (m *managedDatabaseManager) startContainer(ctx context.Context, id string) error {
	inspect, err := m.client.cli.ContainerInspect(ctx, id, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect managed database container: %w", err)
	}
	if inspect.Container.State != nil && inspect.Container.State.Running {
		return nil
	}
	if _, err := m.client.cli.ContainerStart(ctx, id, mobyclient.ContainerStartOptions{}); err != nil {
		return fmt.Errorf("start managed database container: %w", err)
	}
	return nil
}

func (m *managedDatabaseManager) stopContainer(ctx context.Context, id string) error {
	inspect, err := m.client.cli.ContainerInspect(ctx, id, mobyclient.ContainerInspectOptions{})
	if cerrdefs.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect managed database container: %w", err)
	}
	if inspect.Container.State == nil || !inspect.Container.State.Running {
		return nil
	}
	timeout := 30
	if _, err := m.client.cli.ContainerStop(ctx, id, mobyclient.ContainerStopOptions{Timeout: &timeout}); err != nil {
		return fmt.Errorf("stop managed database container: %w", err)
	}
	return nil
}

func (m *managedDatabaseManager) pauseContainer(ctx context.Context, id string) error {
	inspect, err := m.client.cli.ContainerInspect(ctx, id, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect managed database container: %w", err)
	}
	if inspect.Container.State == nil || !inspect.Container.State.Running {
		return errors.New("managed database container is not running")
	}
	if inspect.Container.State.Paused {
		return nil
	}
	if _, err := m.client.cli.ContainerPause(ctx, id, mobyclient.ContainerPauseOptions{}); err != nil {
		return fmt.Errorf("pause managed database container: %w", err)
	}
	return nil
}

func (m *managedDatabaseManager) unpauseContainer(ctx context.Context, id string) error {
	inspect, err := m.client.cli.ContainerInspect(ctx, id, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect managed database container: %w", err)
	}
	if inspect.Container.State == nil || !inspect.Container.State.Running {
		return errors.New("managed database container is not running")
	}
	if !inspect.Container.State.Paused {
		return nil
	}
	if _, err := m.client.cli.ContainerUnpause(ctx, id, mobyclient.ContainerUnpauseOptions{}); err != nil {
		return fmt.Errorf("unpause managed database container: %w", err)
	}
	return nil
}

func (m *managedDatabaseManager) runtimeStats(ctx context.Context, record managedDatabaseRecord) (string, error) {
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if cerrdefs.IsNotFound(err) {
		return marshalManagedDatabaseRuntimeStats(managedDatabaseRuntimeStats{Status: "missing"})
	}
	if err != nil {
		return "", fmt.Errorf("inspect managed database container for stats: %w", err)
	}
	if managedDatabaseContainerStatus(inspect.Container.State) == "paused" {
		return marshalManagedDatabaseRuntimeStats(managedDatabaseRuntimeStats{Status: "paused"})
	}
	if inspect.Container.State == nil || !inspect.Container.State.Running {
		return marshalManagedDatabaseRuntimeStats(managedDatabaseRuntimeStats{Status: "stopped"})
	}
	result, err := m.client.cli.ContainerStats(ctx, record.ContainerID, mobyclient.ContainerStatsOptions{
		Stream:                false,
		IncludePreviousSample: true,
	})
	if err != nil {
		return "", fmt.Errorf("collect managed database stats: %w", err)
	}
	defer result.Body.Close()
	data, err := io.ReadAll(result.Body)
	if err != nil {
		return "", fmt.Errorf("read managed database stats: %w", err)
	}
	var stats container.StatsResponse
	if err := json.Unmarshal(data, &stats); err != nil {
		return "", fmt.Errorf("parse managed database stats: %w", err)
	}
	normalized := statsResponseToProto(&stats, &inspect.Container)
	swapLimit := managedDatabaseSwapLimit(inspect.Container.HostConfig)
	swapUsage := int64(stats.MemoryStats.Stats["swap"])
	return marshalManagedDatabaseRuntimeStats(managedDatabaseRuntimeStats{
		Status:           "ready",
		CPUPercent:       normalized.CpuPercent,
		MemoryUsageBytes: normalized.MemoryUsageBytes,
		MemoryLimitBytes: normalized.MemoryLimitBytes,
		SwapUsageBytes:   swapUsage,
		SwapLimitBytes:   swapLimit,
		Pids:             normalized.Pids,
	})
}

func managedDatabaseSwapLimit(hostConfig *container.HostConfig) int64 {
	if hostConfig == nil || hostConfig.MemorySwap == 0 {
		return 0
	}
	if hostConfig.MemorySwap < 0 {
		return -1
	}
	if hostConfig.MemorySwap <= hostConfig.Memory {
		return 0
	}
	return hostConfig.MemorySwap - hostConfig.Memory
}

func marshalManagedDatabaseRuntimeStats(stats managedDatabaseRuntimeStats) (string, error) {
	data, err := json.Marshal(stats)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func (m *managedDatabaseManager) remove(ctx context.Context, record managedDatabaseRecord) error {
	if record.ContainerID != "" {
		_ = m.client.RemoveContainer(ctx, record.ContainerID, true)
	}
	if record.NetworkName != "" {
		_, _ = m.client.cli.NetworkRemove(ctx, record.NetworkName, mobyclient.NetworkRemoveOptions{})
	}
	return m.cleanupStorage(ctx, &record, true)
}

func (m *managedDatabaseManager) cleanupStorage(ctx context.Context, record *managedDatabaseRecord, removeImage bool) error {
	if mounted(record.MountPath) {
		if output, err := exec.CommandContext(ctx, "umount", record.MountPath).CombinedOutput(); err != nil {
			return fmt.Errorf("unmount database storage image: %w: %s", err, strings.TrimSpace(string(output)))
		}
	}
	if record.LoopDevice != "" {
		if output, err := exec.CommandContext(ctx, "losetup", "-d", record.LoopDevice).CombinedOutput(); err != nil {
			return fmt.Errorf("detach database loop device: %w: %s", err, strings.TrimSpace(string(output)))
		}
	}
	if removeImage {
		if err := os.RemoveAll(m.tlsDirectory(*record)); err != nil {
			return fmt.Errorf("remove managed database TLS material: %w", err)
		}
		if err := os.Remove(record.ImagePath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove database storage image: %w", err)
		}
		if err := os.Remove(m.recordPath(record.ID)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove managed database record: %w", err)
		}
	}
	return nil
}

func (m *managedDatabaseManager) reconcile(ctx context.Context) error {
	entries, err := os.ReadDir(filepath.Join(m.root, "records"))
	if err != nil {
		return fmt.Errorf("read managed database records: %w", err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		record, err := m.loadRecord(id)
		if err != nil {
			return err
		}
		if !record.DesiredRunning {
			continue
		}
		if err := m.ensureStorageSize(ctx, &record, record.StorageSize); err != nil {
			return fmt.Errorf("reconcile storage %s: %w", id, err)
		}
		if err := m.startContainer(ctx, record.ContainerID); err != nil {
			return fmt.Errorf("restart %s: %w", id, err)
		}
		if err := m.saveRecord(record); err != nil {
			return err
		}
	}
	return nil
}

func (m *managedDatabaseManager) tlsDirectory(record managedDatabaseRecord) string {
	return filepath.Join(m.root, "tls", record.ID)
}

func (m *managedDatabaseManager) recordPath(id string) string {
	return filepath.Join(m.root, "records", id+".json")
}

func (m *managedDatabaseManager) loadRecord(id string) (managedDatabaseRecord, error) {
	data, err := os.ReadFile(m.recordPath(id))
	if err != nil {
		return managedDatabaseRecord{}, err
	}
	var record managedDatabaseRecord
	if err := json.Unmarshal(data, &record); err != nil {
		return managedDatabaseRecord{}, fmt.Errorf("parse managed database record: %w", err)
	}
	if record.ID != id || record.ImagePath != filepath.Join(m.root, "images", id+".img") || record.MountPath != filepath.Join(m.root, "mounts", id) {
		return managedDatabaseRecord{}, errors.New("managed database record has invalid storage paths")
	}
	return record, nil
}

func (m *managedDatabaseManager) saveRecord(record managedDatabaseRecord) error {
	data, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("marshal managed database record: %w", err)
	}
	path := m.recordPath(record.ID)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0600); err != nil {
		return fmt.Errorf("write managed database record: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return fmt.Errorf("commit managed database record: %w", err)
	}
	return nil
}

func marshalManagedDatabaseDetail(record managedDatabaseRecord, status string) (string, error) {
	value, err := json.Marshal(map[string]any{
		"id": record.ID, "containerId": record.ContainerID, "status": status, "publishedPort": record.PublishedPort, "publishedNativePort": record.PublishedNativePort, "tlsEnabled": record.TLSEnabled, "operationId": record.OperationID,
	})
	if err != nil {
		return "", err
	}
	return string(value), nil
}
