package docker

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/netip"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	cerrdefs "github.com/containerd/errdefs"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/api/types/container"
	"github.com/moby/moby/api/types/network"
	mobyclient "github.com/moby/moby/client"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
	"golang.org/x/sys/unix"
)

const (
	managedDatabaseLabel   = "wiolett.gateway.managed-database.id"
	managedDatabaseTypeTag = "wiolett.gateway.managed-database.type"
	minimumDatabaseBytes   = 64 * 1024 * 1024
	minimumClickHouseBytes = 512 * 1024 * 1024
	// Keep the daemon's bounded lifecycle operation and rollback shorter than
	// the controller-side command timeout. This prevents an operation from
	// continuing after the Gateway has already declared it failed.
	managedDatabaseCommandTimeout    = 13 * time.Minute
	managedDatabaseCleanupTimeout    = time.Minute
	managedDatabaseReadinessTimeout  = 90 * time.Second
	managedDatabaseReadinessInterval = 500 * time.Millisecond
)

const clickHouseRuntimeProfileVersion = 2

// ClickHouse's upstream defaults are sized for dedicated analytics servers:
// they create large background pools and several MergeTree-backed system log
// tables. In a small managed container those logs can continuously merge until
// they consume the whole cgroup allowance, starving both user traffic and the
// monitoring queries. Keep the managed baseline intentionally small; a user's
// later gateway-managed.xml may still override these defaults when needed.
const clickHouseRuntimeConfig = `<clickhouse>
    <logger replace="replace">
        <level>warning</level>
        <console>1</console>
    </logger>
    <max_server_memory_usage_to_ram_ratio>0.75</max_server_memory_usage_to_ram_ratio>
    <background_buffer_flush_schedule_pool_size>2</background_buffer_flush_schedule_pool_size>
    <background_pool_size>16</background_pool_size>
    <background_move_pool_size>1</background_move_pool_size>
    <background_fetches_pool_size>1</background_fetches_pool_size>
    <background_common_pool_size>2</background_common_pool_size>
    <background_schedule_pool_size>8</background_schedule_pool_size>
    <background_message_broker_schedule_pool_size>2</background_message_broker_schedule_pool_size>
    <background_distributed_schedule_pool_size>2</background_distributed_schedule_pool_size>
    <query_log remove="remove"/>
    <query_thread_log remove="remove"/>
    <query_views_log remove="remove"/>
    <query_metric_log remove="remove"/>
    <trace_log remove="remove"/>
    <instrumentation_trace_log remove="remove"/>
    <part_log remove="remove"/>
    <text_log remove="remove"/>
    <error_log remove="remove"/>
    <metric_log remove="remove"/>
    <asynchronous_metric_log remove="remove"/>
    <processors_profile_log remove="remove"/>
    <session_log remove="remove"/>
    <crash_log remove="remove"/>
    <background_schedule_pool_log remove="remove"/>
    <asynchronous_insert_log remove="remove"/>
    <backup_log remove="remove"/>
    <blob_storage_log remove="remove"/>
    <s3queue_log remove="remove"/>
    <opentelemetry_span_log remove="remove"/>
    <zookeeper_log remove="remove"/>
    <zookeeper_connection_log remove="remove"/>
    <aggregated_zookeeper_log remove="remove"/>
    <delta_lake_metadata_log remove="remove"/>
    <iceberg_metadata_log remove="remove"/>
</clickhouse>`

const clickHouseSystemLogCleanupSQL = `
TRUNCATE TABLE IF EXISTS system.query_log;
TRUNCATE TABLE IF EXISTS system.query_thread_log;
TRUNCATE TABLE IF EXISTS system.query_views_log;
TRUNCATE TABLE IF EXISTS system.query_metric_log;
TRUNCATE TABLE IF EXISTS system.trace_log;
TRUNCATE TABLE IF EXISTS system.instrumentation_trace_log;
TRUNCATE TABLE IF EXISTS system.part_log;
TRUNCATE TABLE IF EXISTS system.text_log;
TRUNCATE TABLE IF EXISTS system.error_log;
TRUNCATE TABLE IF EXISTS system.metric_log;
TRUNCATE TABLE IF EXISTS system.asynchronous_metric_log;
TRUNCATE TABLE IF EXISTS system.processors_profile_log;
TRUNCATE TABLE IF EXISTS system.session_log;
TRUNCATE TABLE IF EXISTS system.crash_log;
TRUNCATE TABLE IF EXISTS system.background_schedule_pool_log;
TRUNCATE TABLE IF EXISTS system.asynchronous_insert_log;
TRUNCATE TABLE IF EXISTS system.backup_log;
TRUNCATE TABLE IF EXISTS system.blob_storage_log;
TRUNCATE TABLE IF EXISTS system.s3queue_log;
TRUNCATE TABLE IF EXISTS system.opentelemetry_span_log;
TRUNCATE TABLE IF EXISTS system.zookeeper_log;
TRUNCATE TABLE IF EXISTS system.zookeeper_connection_log;
TRUNCATE TABLE IF EXISTS system.aggregated_zookeeper_log;
TRUNCATE TABLE IF EXISTS system.delta_lake_metadata_log;
TRUNCATE TABLE IF EXISTS system.iceberg_metadata_log;
`

var (
	managedDatabaseIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$`)
	managedDatabaseName      = regexp.MustCompile(`^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`)
	digestImagePattern       = regexp.MustCompile(`@sha256:[a-f0-9]{64}$`)
)

// managedDatabaseCommand is deliberately private to the database-profile
// daemon. It must never become a generic Docker container payload.
type managedDatabaseCommand struct {
	Type                string              `json:"type"`
	Image               string              `json:"image"`
	StorageSizeBytes    int64               `json:"storageSizeBytes"`
	MemoryBytes         int64               `json:"memoryBytes"`
	MemorySwapBytes     int64               `json:"memorySwapBytes"`
	NanoCPUs            int64               `json:"nanoCPUs"`
	CPUShares           int64               `json:"cpuShares"`
	PidsLimit           int64               `json:"pidsLimit"`
	OperationID         string              `json:"operationId"`
	OwnerUsername       string              `json:"ownerUsername"`
	OwnerPassword       string              `json:"ownerPassword"`
	DatabaseName        string              `json:"databaseName"`
	PublishTCP          bool                `json:"publishTcp"`
	PublishNativeTCP    bool                `json:"publishNativeTcp"`
	PublishedPort       uint16              `json:"publishedPort"`
	PublishedNativePort uint16              `json:"publishedNativePort"`
	TLSEnabled          bool                `json:"tlsEnabled"`
	TLSCertificatePEM   string              `json:"tlsCertificatePem"`
	TLSPrivateKeyPEM    string              `json:"tlsPrivateKeyPem"`
	TLSCACertificatePEM string              `json:"tlsCaCertificatePem"`
	TLSCertificateID    string              `json:"tlsCertificateId"`
	ClickhouseConfig    string              `json:"clickhouseConfigXml"`
	RedisConfig         *managedRedisConfig `json:"redisConfig,omitempty"`
}

type managedRedisConfig struct {
	MaxmemoryPercent             int    `json:"maxmemoryPercent"`
	MaxmemoryPolicy              string `json:"maxmemoryPolicy"`
	AppendOnly                   bool   `json:"appendOnly"`
	AppendFsync                  string `json:"appendFsync"`
	RDBSnapshotsEnabled          bool   `json:"rdbSnapshotsEnabled"`
	RDBSaveSeconds               int    `json:"rdbSaveSeconds"`
	RDBSaveChanges               int    `json:"rdbSaveChanges"`
	AutoAOFRewritePercentage     int    `json:"autoAofRewritePercentage"`
	AutoAOFRewriteMinSizeMB      int    `json:"autoAofRewriteMinSizeMb"`
	MaxClients                   int    `json:"maxclients"`
	TimeoutSeconds               int    `json:"timeoutSeconds"`
	TCPKeepaliveSeconds          int    `json:"tcpKeepaliveSeconds"`
	SlowlogThresholdMicroseconds int64  `json:"slowlogThresholdMicroseconds"`
	SlowlogMaxLen                int    `json:"slowlogMaxLen"`
	ActiveDefrag                 bool   `json:"activeDefrag"`
}

// managedDatabaseBindingCommand is intentionally separate from the instance
// lifecycle payload. It carries a short-lived command to create or revoke one
// engine-level account; credentials are never persisted by the database node.
type managedDatabaseBindingCommand struct {
	BindingID     string `json:"bindingId"`
	Username      string `json:"username"`
	Password      string `json:"password"`
	DatabaseName  string `json:"databaseName"`
	OwnerUsername string `json:"ownerUsername"`
	OwnerPassword string `json:"ownerPassword"`
}

// clickHousePrincipalCommand is a versioned, ClickHouse-only principal
// contract. It must not be folded into binding_create: old daemons ignore
// unknown JSON fields on that action and could recreate the legacy grant set.
type clickHousePrincipalCommand struct {
	PrincipalType string `json:"principalType"`
	Username      string `json:"username"`
	Password      string `json:"password"`
	DatabaseName  string `json:"databaseName"`
	OwnerUsername string `json:"ownerUsername"`
	OwnerPassword string `json:"ownerPassword"`
}

type managedDatabaseOperationCommand struct {
	OperationID string `json:"operationId"`
}

// managedDatabaseRecord is enough to remount a fixed-size image before a
// database container is started after a daemon or host restart. It contains
// neither owner credentials nor arbitrary configuration.
type managedDatabaseRecord struct {
	ID                              string `json:"id"`
	Type                            string `json:"type"`
	ContainerID                     string `json:"containerId"`
	ContainerName                   string `json:"containerName"`
	NetworkName                     string `json:"networkName"`
	ImagePath                       string `json:"imagePath"`
	MountPath                       string `json:"mountPath"`
	LoopDevice                      string `json:"loopDevice,omitempty"`
	StorageSize                     int64  `json:"storageSizeBytes"`
	DesiredRunning                  bool   `json:"desiredRunning"`
	PublishedPort                   uint16 `json:"publishedPort,omitempty"`
	PublishedNativePort             uint16 `json:"publishedNativePort,omitempty"`
	TLSEnabled                      bool   `json:"tlsEnabled"`
	TLSCertificateID                string `json:"tlsCertificateId,omitempty"`
	ClickhouseConfigHash            string `json:"clickhouseConfigHash,omitempty"`
	RedisConfigHash                 string `json:"redisConfigHash,omitempty"`
	ClickhouseRuntimeProfileVersion int    `json:"clickhouseRuntimeProfileVersion,omitempty"`
	OperationID                     string `json:"operationId"`
}

// managedDatabaseRuntimeStats is intentionally a narrow managed-database
// payload. It reuses Docker's live container accounting without exposing the
// generic container stats surface to a databases node.
type managedDatabaseRuntimeStats struct {
	Status           string  `json:"status"`
	CPUPercent       float64 `json:"cpuPercent,omitempty"`
	MemoryUsageBytes int64   `json:"memoryUsageBytes,omitempty"`
	MemoryLimitBytes int64   `json:"memoryLimitBytes,omitempty"`
	SwapUsageBytes   int64   `json:"swapUsageBytes,omitempty"`
	SwapLimitBytes   int64   `json:"swapLimitBytes,omitempty"`
	Pids             int64   `json:"pids,omitempty"`
}

type managedDatabaseManager struct {
	cfg     *config.Config
	client  *Client
	logger  *slog.Logger
	root    string
	reserve int64
	mu      sync.Mutex
}

func newManagedDatabaseManager(cfg *config.Config, client *Client, logger *slog.Logger) (*managedDatabaseManager, error) {
	root := filepath.Clean(cfg.Docker.Database.StorageRoot)
	if !filepath.IsAbs(root) || root == "/" {
		return nil, fmt.Errorf("database storage root must be an absolute non-root path")
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return nil, fmt.Errorf("create database storage root: %w", err)
	}
	for _, dir := range []string{"images", "mounts", "records", "tls"} {
		if err := os.MkdirAll(filepath.Join(root, dir), 0700); err != nil {
			return nil, fmt.Errorf("create database storage directory: %w", err)
		}
	}
	reserve := cfg.Docker.Database.ReserveBytes
	if reserve < 0 {
		return nil, fmt.Errorf("database reserve bytes cannot be negative")
	}
	return &managedDatabaseManager{cfg: cfg, client: client, logger: logger, root: root, reserve: reserve}, nil
}

func (p *DockerPlugin) handleManagedDatabaseCommand(cmd *pb.DockerDatabaseCommand, result *pb.CommandResult) {
	if p.databaseManager == nil {
		result.Success = false
		result.Error = "managed database storage is not initialized"
		return
	}
	if cmd.Action == "logs" || cmd.Action == "logs_stop" {
		ctx, cancel := context.WithTimeout(context.Background(), dockerLogsCommandTimeout)
		defer cancel()
		containerID, err := p.databaseManager.resolveOwnedContainer(ctx, cmd.ManagedDatabaseId)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		if cmd.Action == "logs_stop" {
			p.logStreamMu.Lock()
			stop := p.logStreamCancel[containerID]
			delete(p.logStreamCancel, containerID)
			p.logStreamMu.Unlock()
			if stop != nil {
				stop()
			}
			result.Detail = `{"streaming":false}`
			return
		}
		var input struct {
			TailLines  int32  `json:"tailLines"`
			Follow     bool   `json:"follow"`
			Timestamps bool   `json:"timestamps"`
			Since      string `json:"since"`
			Until      string `json:"until"`
		}
		if err := json.Unmarshal([]byte(cmd.ConfigJson), &input); err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("parse managed database logs config: %v", err)
			return
		}
		p.handleLogsCommand(&pb.DockerLogsCommand{
			ContainerId: containerID,
			TailLines:   input.TailLines,
			Follow:      input.Follow,
			Timestamps:  input.Timestamps,
			Since:       input.Since,
			Until:       input.Until,
		}, result)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), managedDatabaseCommandTimeout)
	defer cancel()
	detail, err := p.databaseManager.handle(ctx, cmd.Action, cmd.ManagedDatabaseId, cmd.ConfigJson)
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		return
	}
	result.Detail = detail
}

// resolveOwnedContainer keeps the database-profile daemon from becoming a
// generic Docker log reader: only the container recorded for this managed
// database and carrying the matching ownership label may be inspected.
func (m *managedDatabaseManager) resolveOwnedContainer(ctx context.Context, id string) (string, error) {
	if !managedDatabaseIDPattern.MatchString(id) {
		return "", errors.New("invalid managed database id")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	record, err := m.loadRecord(id)
	if err != nil {
		return "", err
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return "", fmt.Errorf("inspect managed database container: %w", err)
	}
	if inspect.Container.Config == nil || inspect.Container.Config.Labels[managedDatabaseLabel] != id {
		return "", errors.New("managed database container ownership mismatch")
	}
	return record.ContainerID, nil
}

func (m *managedDatabaseManager) handle(ctx context.Context, action, id, configJSON string) (string, error) {
	if !managedDatabaseIDPattern.MatchString(id) {
		return "", errors.New("invalid managed database id")
	}
	m.mu.Lock()
	defer m.mu.Unlock()

	switch action {
	case "create":
		var input managedDatabaseCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return "", fmt.Errorf("parse managed database config: %w", err)
		}
		record, err := m.create(ctx, id, input)
		if err != nil {
			return "", err
		}
		return marshalManagedDatabaseDetail(record, "ready")
	case "start":
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if err := m.ensureMounted(ctx, &record); err != nil {
			return "", err
		}
		if err := m.startContainer(ctx, record.ContainerID); err != nil {
			return "", err
		}
		record.DesiredRunning = true
		if err := m.saveRecord(record); err != nil {
			return "", err
		}
		return marshalManagedDatabaseDetail(record, "ready")
	case "restart":
		var input managedDatabaseCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return "", fmt.Errorf("parse managed database config: %w", err)
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if err := m.restart(ctx, &record, input); err != nil {
			return "", err
		}
		if err := m.saveRecord(record); err != nil {
			return "", err
		}
		return marshalManagedDatabaseDetail(record, "ready")
	case "update":
		var input managedDatabaseCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return "", fmt.Errorf("parse managed database config: %w", err)
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if err := m.update(ctx, &record, input); err != nil {
			return "", err
		}
		if err := m.saveRecord(record); err != nil {
			return "", err
		}
		return marshalManagedDatabaseDetail(record, "ready")
	case "stop":
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if err := m.stopContainer(ctx, record.ContainerID); err != nil {
			return "", err
		}
		record.DesiredRunning = false
		if err := m.saveRecord(record); err != nil {
			return "", err
		}
		return marshalManagedDatabaseDetail(record, "stopped")
	case "pause", "unpause":
		var input managedDatabaseOperationCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return "", fmt.Errorf("parse managed database operation: %w", err)
		}
		if !managedDatabaseIDPattern.MatchString(input.OperationID) {
			return "", errors.New("managed database operation id is invalid")
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if action == "pause" {
			if err := m.pauseContainer(ctx, record.ContainerID); err != nil {
				return "", err
			}
		} else if err := m.unpauseContainer(ctx, record.ContainerID); err != nil {
			return "", err
		}
		record.OperationID = input.OperationID
		if err := m.saveRecord(record); err != nil {
			return "", err
		}
		if action == "pause" {
			return marshalManagedDatabaseDetail(record, "paused")
		}
		return marshalManagedDatabaseDetail(record, "ready")
	case "remove":
		record, err := m.loadRecord(id)
		if errors.Is(err, os.ErrNotExist) {
			// The prior remove may have completed while its response was lost.
			// Reporting success makes control-plane deletion safe to retry.
			return `{"status":"deleted"}`, nil
		}
		if err != nil {
			return "", err
		}
		if err := m.remove(ctx, record); err != nil {
			return "", err
		}
		return `{"status":"deleted"}`, nil
	case "inspect":
		record, err := m.loadRecord(id)
		if errors.Is(err, os.ErrNotExist) {
			return `{"status":"missing"}`, nil
		}
		if err != nil {
			return "", err
		}
		inspect, inspectErr := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
		status := "stopped"
		if inspectErr == nil {
			status = managedDatabaseContainerStatus(inspect.Container.State)
		}
		return marshalManagedDatabaseDetail(record, status)
	case "stats":
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		return m.runtimeStats(ctx, record)
	case "clickhouse_principal_apply_v1":
		var input clickHousePrincipalCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return "", fmt.Errorf("parse ClickHouse principal config: %w", err)
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if err := validateClickHousePrincipalInput(input); err != nil {
			return "", err
		}
		if err := m.applyClickHousePrincipal(ctx, record, input); err != nil {
			return "", err
		}
		return `{"status":"ok"}`, nil
	case "binding_create", "binding_remove":
		var input managedDatabaseBindingCommand
		if err := json.Unmarshal([]byte(configJSON), &input); err != nil {
			return "", fmt.Errorf("parse managed database binding config: %w", err)
		}
		record, err := m.loadRecord(id)
		if err != nil {
			return "", err
		}
		if err := validateManagedDatabaseBindingInput(input); err != nil {
			return "", err
		}
		if action == "binding_create" {
			if err := m.createBindingPrincipal(ctx, record, input); err != nil {
				return "", err
			}
		} else if err := m.removeBindingPrincipal(ctx, record, input); err != nil {
			return "", err
		}
		return `{"status":"ok"}`, nil
	default:
		return "", fmt.Errorf("unsupported managed database action: %s", action)
	}
}

func managedDatabaseContainerStatus(state *container.State) string {
	if state == nil || !state.Running {
		return "stopped"
	}
	if state.Paused {
		return "paused"
	}
	return "ready"
}

func validateManagedDatabaseBindingInput(input managedDatabaseBindingCommand) error {
	if !managedDatabaseIDPattern.MatchString(input.BindingID) {
		return errors.New("invalid database binding identifier")
	}
	if !managedDatabaseName.MatchString(input.Username) || !managedDatabaseName.MatchString(input.OwnerUsername) || !managedDatabaseName.MatchString(input.DatabaseName) {
		return errors.New("database binding names must be safe SQL identifiers")
	}
	if len(input.Password) < 16 || len(input.Password) > 512 || len(input.OwnerPassword) < 16 || len(input.OwnerPassword) > 512 {
		return errors.New("database binding passwords must be between 16 and 512 characters")
	}
	return nil
}

func validateClickHousePrincipalInput(input clickHousePrincipalCommand) error {
	if input.PrincipalType != "reader" && input.PrincipalType != "writer" && input.PrincipalType != "binding" {
		return errors.New("unsupported ClickHouse principal type")
	}
	if !managedDatabaseName.MatchString(input.Username) || !managedDatabaseName.MatchString(input.OwnerUsername) || !managedDatabaseName.MatchString(input.DatabaseName) {
		return errors.New("ClickHouse principal names must be safe SQL identifiers")
	}
	if len(input.Password) < 16 || len(input.Password) > 512 || len(input.OwnerPassword) < 16 || len(input.OwnerPassword) > 512 {
		return errors.New("ClickHouse principal passwords must be between 16 and 512 characters")
	}
	return nil
}

func (m *managedDatabaseManager) createBindingPrincipal(ctx context.Context, record managedDatabaseRecord, input managedDatabaseBindingCommand) error {
	var command []string
	var stdin string
	var env []string
	switch record.Type {
	case "postgres":
		stdin = postgresBindingCreateSQL(input)
		command = []string{"psql", "-v", "ON_ERROR_STOP=1", "-U", input.OwnerUsername, "-d", input.DatabaseName}
	case "redis":
		// Redis accepts the ACL password only as an argument. The owner password
		// stays in the exec environment, not in a process argument. Binding users
		// may use normal data commands, but must never administer the server or
		// mutate ACLs (which would let one binding take over another).
		command = []string{"sh", "-ec", redisBindingACLCommand()}
		env = []string{
			"REDISCLI_AUTH=" + input.OwnerPassword,
			"GATEWAY_DB_BINDING_USER=" + input.Username,
			"GATEWAY_DB_BINDING_PASSWORD=" + input.Password,
		}
	case "clickhouse":
		stdin = clickHouseBindingCreateSQL(input)
		command = []string{"clickhouse-client", "--user", input.OwnerUsername, "--database", input.DatabaseName, "--multiquery"}
		env = []string{"CLICKHOUSE_PASSWORD=" + input.OwnerPassword}
	default:
		return errors.New("unsupported managed database engine")
	}
	return m.runManagedDatabaseExec(ctx, record.ContainerID, command, stdin, env)
}

func (m *managedDatabaseManager) applyClickHousePrincipal(ctx context.Context, record managedDatabaseRecord, input clickHousePrincipalCommand) error {
	if record.Type != "clickhouse" {
		return errors.New("ClickHouse principals are unsupported for this database engine")
	}
	return m.runManagedDatabaseExec(
		ctx,
		record.ContainerID,
		[]string{"clickhouse-client", "--user", input.OwnerUsername, "--database", input.DatabaseName, "--multiquery"},
		clickHousePrincipalSQL(input)+"\n",
		[]string{"CLICKHOUSE_PASSWORD=" + input.OwnerPassword},
	)
}

func redisBindingACLBaseRules() []string {
	return []string{
		"~*", "&*", "+@read", "+@write", "+@connection", "+@transaction", "+@pubsub",
		"+eval", "+evalsha", "-script", "-@dangerous",
	}
}

func redisBindingACLModernRules() []string {
	return []string{
		"+eval_ro", "+evalsha_ro", "+fcall", "+fcall_ro", "+script|load", "+script|exists",
		"-function", "-script|flush", "-script|kill", "-script|debug",
	}
}

func redisBindingACLShellWords(rules []string) string {
	return "'" + strings.Join(rules, "' '") + "'"
}

func redisBindingACLCommand() string {
	return fmt.Sprintf(`redis_major="$(redis-cli --no-auth-warning --user default INFO server 2>/dev/null | sed -n 's/^redis_version:\([0-9][0-9]*\)\..*/\1/p')"
set -- redis-cli --no-auth-warning --user default ACL SETUSER "$GATEWAY_DB_BINDING_USER" reset on ">$GATEWAY_DB_BINDING_PASSWORD"
for acl_rule in %s; do
  set -- "$@" "$acl_rule"
done
case "$redis_major" in
  [7-9]|[1-9][0-9]*)
    for acl_rule in %s; do
      set -- "$@" "$acl_rule"
    done
    ;;
esac
"$@"`, redisBindingACLShellWords(redisBindingACLBaseRules()), redisBindingACLShellWords(redisBindingACLModernRules()))
}

func (m *managedDatabaseManager) removeBindingPrincipal(ctx context.Context, record managedDatabaseRecord, input managedDatabaseBindingCommand) error {
	var command []string
	var stdin string
	var env []string
	switch record.Type {
	case "postgres":
		stdin = postgresBindingRemoveSQL(input)
		command = []string{"psql", "-v", "ON_ERROR_STOP=1", "-U", input.OwnerUsername, "-d", input.DatabaseName}
	case "redis":
		command = []string{"sh", "-ec", `redis-cli --no-auth-warning --user default ACL DELUSER "$GATEWAY_DB_BINDING_USER" >/dev/null || true`}
		env = []string{"REDISCLI_AUTH=" + input.OwnerPassword, "GATEWAY_DB_BINDING_USER=" + input.Username}
	case "clickhouse":
		stdin = clickHouseBindingRemoveSQL(input)
		command = []string{"clickhouse-client", "--user", input.OwnerUsername, "--database", input.DatabaseName, "--multiquery"}
		env = []string{"CLICKHOUSE_PASSWORD=" + input.OwnerPassword}
	default:
		return errors.New("unsupported managed database engine")
	}
	return m.runManagedDatabaseExec(ctx, record.ContainerID, command, stdin, env)
}

func postgresBindingCreateSQL(input managedDatabaseBindingCommand) string {
	return fmt.Sprintf(
		"DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %s) THEN EXECUTE 'CREATE ROLE ' || quote_ident(%s) || ' LOGIN PASSWORD ' || quote_literal(%s); ELSE EXECUTE 'ALTER ROLE ' || quote_ident(%s) || ' LOGIN PASSWORD ' || quote_literal(%s); END IF; END $$; GRANT ALL PRIVILEGES ON DATABASE %s TO %s;\n",
		quoteSQLLiteral(input.Username), quoteSQLLiteral(input.Username), quoteSQLLiteral(input.Password), quoteSQLLiteral(input.Username), quoteSQLLiteral(input.Password), quoteSQLIdentifier(input.DatabaseName), quoteSQLIdentifier(input.Username),
	)
}

func postgresBindingRemoveSQL(input managedDatabaseBindingCommand) string {
	return fmt.Sprintf(
		"DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = %s) THEN EXECUTE 'DROP OWNED BY ' || quote_ident(%s); EXECUTE 'DROP ROLE ' || quote_ident(%s); END IF; END $$;\n",
		quoteSQLLiteral(input.Username), quoteSQLLiteral(input.Username), quoteSQLLiteral(input.Username),
	)
}

func clickHouseBindingCreateSQL(input managedDatabaseBindingCommand) string {
	return clickHousePrincipalSQL(clickHousePrincipalCommand{
		PrincipalType: "binding",
		Username:      input.Username,
		Password:      input.Password,
		DatabaseName:  input.DatabaseName,
		OwnerUsername: input.OwnerUsername,
		OwnerPassword: input.OwnerPassword,
	}) + "\n"
}

func clickHousePrincipalSQL(input clickHousePrincipalCommand) string {
	if input.PrincipalType == "reader" {
		return clickHouseReaderPrincipalSQL(input)
	}
	return clickHouseWriterPrincipalSQL(input)
}

func clickHouseReaderPrincipalSQL(input clickHousePrincipalCommand) string {
	principal := quoteSQLIdentifier(input.Username)
	return fmt.Sprintf(
		"CREATE USER IF NOT EXISTS %s IDENTIFIED WITH sha256_password BY %s; ALTER USER %s IDENTIFIED WITH sha256_password BY %s; REVOKE ALL ON *.* FROM %s; GRANT SELECT ON %s.* TO %s; GRANT SELECT ON information_schema.* TO %s; GRANT SELECT(name) ON system.databases TO %s; GRANT SELECT(name, engine, total_rows, total_bytes, database, sorting_key, primary_key, partition_key, create_table_query) ON system.tables TO %s; GRANT SELECT(name, type, default_kind, default_expression, comment, is_in_primary_key, is_in_sorting_key, is_in_partition_key, database, table, position) ON system.columns TO %s;",
		principal,
		quoteSQLLiteral(input.Password),
		principal,
		quoteSQLLiteral(input.Password),
		principal,
		quoteSQLIdentifier(input.DatabaseName),
		principal,
		principal,
		principal,
		principal,
		principal,
	)
}

func clickHouseWriterPrincipalSQL(input clickHousePrincipalCommand) string {
	principal := quoteSQLIdentifier(input.Username)
	return fmt.Sprintf(
		"CREATE USER IF NOT EXISTS %s IDENTIFIED WITH sha256_password BY %s; ALTER USER %s IDENTIFIED WITH sha256_password BY %s; REVOKE ALL ON *.* FROM %s; GRANT ALL ON %s.* TO %s; GRANT SELECT ON information_schema.* TO %s; GRANT SELECT(name) ON system.databases TO %s; GRANT SELECT(name, engine, total_rows, total_bytes, database, sorting_key, primary_key, partition_key, create_table_query) ON system.tables TO %s; GRANT SELECT(name, type, default_kind, default_expression, comment, is_in_primary_key, is_in_sorting_key, is_in_partition_key, database, table, position) ON system.columns TO %s; GRANT SELECT ON system.parts TO %s; %s GRANT SELECT ON system.merges TO %s; GRANT SELECT ON system.mutations TO %s; GRANT SELECT ON system.events TO %s; GRANT SELECT ON system.disks TO %s;",
		principal,
		quoteSQLLiteral(input.Password),
		principal,
		quoteSQLLiteral(input.Password),
		principal,
		quoteSQLIdentifier(input.DatabaseName),
		principal,
		principal,
		principal,
		principal,
		principal,
		principal,
		clickHouseBindingProcessPrivilegesSQL(input.Username),
		principal,
		principal,
		principal,
		principal,
	)
}

func clickHouseBindingProcessPrivilegesSQL(username string) string {
	principal := quoteSQLIdentifier(username)
	return fmt.Sprintf("REVOKE SELECT ON system.processes FROM %s; GRANT SELECT(memory_usage) ON system.processes TO %s;", principal, principal)
}

func clickHouseBindingRemoveSQL(input managedDatabaseBindingCommand) string {
	return fmt.Sprintf("DROP USER IF EXISTS %s;\n", quoteSQLIdentifier(input.Username))
}

func quoteSQLIdentifier(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
}

func quoteSQLLiteral(value string) string {
	return `'` + strings.ReplaceAll(value, `'`, `''`) + `'`
}

// runManagedDatabaseExec runs a fixed engine client command. It deliberately
// suppresses command output: output can contain a query fragment, and callers
// only need a stable operational error, never a credential-bearing diagnostic.
func (m *managedDatabaseManager) runManagedDatabaseExec(ctx context.Context, containerID string, command []string, stdin string, env []string) error {
	created, err := m.client.cli.ExecCreate(ctx, containerID, mobyclient.ExecCreateOptions{
		Cmd: command, Env: env, AttachStdin: stdin != "", AttachStdout: true, AttachStderr: true,
	})
	if err != nil {
		return errors.New("managed database engine command could not start")
	}
	attached, err := m.client.cli.ExecAttach(ctx, created.ID, mobyclient.ExecAttachOptions{})
	if err != nil {
		return errors.New("managed database engine command could not attach")
	}
	defer attached.Close()
	if stdin != "" {
		if _, err := io.WriteString(attached.Conn, stdin); err != nil {
			return errors.New("managed database engine command could not receive input")
		}
		if err := attached.CloseWrite(); err != nil {
			return errors.New("managed database engine command could not close input")
		}
	}
	_, _ = stdcopy.StdCopy(io.Discard, io.Discard, attached.Reader)
	inspect, err := m.client.cli.ExecInspect(ctx, created.ID, mobyclient.ExecInspectOptions{})
	if err != nil || inspect.ExitCode != 0 {
		return errors.New("managed database engine command failed")
	}
	return nil
}

func (m *managedDatabaseManager) update(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) error {
	if err := validateManagedDatabaseInput(input); err != nil {
		return err
	}
	if input.Type != record.Type {
		return errors.New("managed database engine cannot be changed")
	}
	if record.OperationID == input.OperationID {
		return nil
	}
	if input.StorageSizeBytes < record.StorageSize {
		return errors.New("managed database storage cannot be reduced")
	}
	if err := m.ensureStorageSize(ctx, record, input.StorageSizeBytes); err != nil {
		return err
	}
	if managedDatabaseRequiresRecreate(*record, input) {
		if err := m.recreateContainer(ctx, record, input); err != nil {
			return err
		}
	} else if err := m.client.LiveUpdateContainer(ctx, record.ContainerID, managedDatabaseRuntimeJSON(input)); err != nil {
		return err
	}
	record.OperationID = input.OperationID
	return nil
}

func clickHouseConfigHash(value string) string {
	if value == "" {
		return ""
	}
	digest := sha256.Sum256([]byte(value))
	return fmt.Sprintf("%x", digest)
}

func defaultManagedRedisConfig() managedRedisConfig {
	return managedRedisConfig{
		MaxmemoryPercent: 75, MaxmemoryPolicy: "noeviction", AppendOnly: true, AppendFsync: "everysec",
		RDBSnapshotsEnabled: true, RDBSaveSeconds: 3600, RDBSaveChanges: 1,
		AutoAOFRewritePercentage: 100, AutoAOFRewriteMinSizeMB: 64, MaxClients: 10000,
		TimeoutSeconds: 0, TCPKeepaliveSeconds: 300, SlowlogThresholdMicroseconds: 10000,
		SlowlogMaxLen: 128, ActiveDefrag: false,
	}
}

func normalizedManagedRedisConfig(input managedDatabaseCommand) managedRedisConfig {
	if input.RedisConfig == nil {
		return defaultManagedRedisConfig()
	}
	return *input.RedisConfig
}

func managedRedisConfigText(input managedDatabaseCommand) string {
	config := normalizedManagedRedisConfig(input)
	yesNo := func(value bool) string {
		if value {
			return "yes"
		}
		return "no"
	}
	save := `save ""`
	if config.RDBSnapshotsEnabled {
		save = fmt.Sprintf("save %d %d", config.RDBSaveSeconds, config.RDBSaveChanges)
	}
	return fmt.Sprintf("maxmemory %d\nmaxmemory-policy %s\nappendonly %s\nappendfsync %s\naof-use-rdb-preamble yes\nauto-aof-rewrite-percentage %d\nauto-aof-rewrite-min-size %dmb\n%s\nmaxclients %d\ntimeout %d\ntcp-keepalive %d\nslowlog-log-slower-than %d\nslowlog-max-len %d\nactivedefrag %s\n",
		input.MemoryBytes*int64(config.MaxmemoryPercent)/100,
		config.MaxmemoryPolicy,
		yesNo(config.AppendOnly),
		config.AppendFsync,
		config.AutoAOFRewritePercentage,
		config.AutoAOFRewriteMinSizeMB,
		save,
		config.MaxClients,
		config.TimeoutSeconds,
		config.TCPKeepaliveSeconds,
		config.SlowlogThresholdMicroseconds,
		config.SlowlogMaxLen,
		yesNo(config.ActiveDefrag),
	)
}

func managedRedisConfigHash(input managedDatabaseCommand) string {
	if input.Type != "redis" {
		return ""
	}
	digest := sha256.Sum256([]byte(managedRedisConfigText(input)))
	return fmt.Sprintf("%x", digest)
}

func managedRedisConfigPath(record managedDatabaseRecord, input managedDatabaseCommand) string {
	return filepath.Join(record.MountPath, "gateway-redis-"+managedRedisConfigHash(input)+".conf")
}

func managedDatabaseRequiresRecreate(record managedDatabaseRecord, input managedDatabaseCommand) bool {
	return input.PublishedPort != record.PublishedPort ||
		input.PublishedNativePort != record.PublishedNativePort ||
		(input.PublishNativeTCP != (record.PublishedNativePort != 0)) ||
		input.TLSEnabled != record.TLSEnabled ||
		input.TLSCertificateID != record.TLSCertificateID ||
		(input.PublishTCP != (record.PublishedPort != 0)) ||
		(record.Type == "clickhouse" && (clickHouseConfigHash(input.ClickhouseConfig) != record.ClickhouseConfigHash ||
			record.ClickhouseRuntimeProfileVersion != clickHouseRuntimeProfileVersion)) ||
		(record.Type == "redis" && managedRedisConfigHash(input) != record.RedisConfigHash)
}

func (m *managedDatabaseManager) restart(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) error {
	if err := validateManagedDatabaseInput(input); err != nil {
		return err
	}
	if input.Type != record.Type {
		return errors.New("managed database engine cannot be changed")
	}
	if record.OperationID == input.OperationID {
		return nil
	}
	if err := m.ensureMounted(ctx, record); err != nil {
		return err
	}
	inspect, err := m.client.cli.ContainerInspect(ctx, record.ContainerID, mobyclient.ContainerInspectOptions{})
	if err != nil {
		return fmt.Errorf("inspect managed database container: %w", err)
	}
	if inspect.Container.State != nil && inspect.Container.State.Running {
		if err := m.client.RestartContainer(ctx, record.ContainerID, 30); err != nil {
			return fmt.Errorf("restart managed database container: %w", err)
		}
	} else if err := m.startContainer(ctx, record.ContainerID); err != nil {
		return err
	}
	if err := m.waitForDatabaseReady(ctx, record.ContainerID, input); err != nil {
		return err
	}
	record.DesiredRunning = true
	record.OperationID = input.OperationID
	return nil
}

// recreateContainer applies the only Docker setting that cannot be changed
// live (port bindings) while deliberately retaining the mounted managed data
// image and its isolated network.
func (m *managedDatabaseManager) recreateContainer(ctx context.Context, record *managedDatabaseRecord, input managedDatabaseCommand) error {
	previous := *record
	rollbackName := previous.ContainerName + "-rollback"
	previousRenamed := false
	if record.ContainerID != "" {
		if err := m.stopContainer(ctx, record.ContainerID); err != nil {
			return err
		}
		if err := m.client.RenameContainer(ctx, record.ContainerID, rollbackName); err != nil {
			return fmt.Errorf("preserve managed database container for publication change: %w", err)
		}
		previousRenamed = true
	}
	rollback := func() {
		*record = previous
		if !previousRenamed {
			return
		}
		rollbackCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
		defer cancel()
		if err := m.client.RenameContainer(rollbackCtx, previous.ContainerID, previous.ContainerName); err != nil {
			m.logger.Error("restore managed database container name after recreate failure", "id", previous.ID, "error", err)
			return
		}
		if err := m.startContainer(rollbackCtx, previous.ContainerID); err != nil {
			m.logger.Error("restart managed database after recreate failure", "id", previous.ID, "error", err)
		}
	}
	// A disabled publication and an auto-assigned port must not inherit the
	// previous host binding from the record.
	record.ContainerID = ""
	record.PublishedPort = input.PublishedPort
	record.PublishedNativePort = input.PublishedNativePort
	record.TLSEnabled = input.TLSEnabled
	record.TLSCertificateID = input.TLSCertificateID
	record.ClickhouseConfigHash = clickHouseConfigHash(input.ClickhouseConfig)
	record.RedisConfigHash = managedRedisConfigHash(input)
	if input.Type == "clickhouse" {
		record.ClickhouseRuntimeProfileVersion = clickHouseRuntimeProfileVersion
	}
	containerID, err := m.createContainer(ctx, record, input)
	if err != nil {
		rollback()
		return err
	}
	record.ContainerID = containerID
	record.DesiredRunning = true
	if previousRenamed {
		if err := m.client.RemoveContainer(ctx, previous.ContainerID, true); err != nil && !cerrdefs.IsNotFound(err) {
			m.logger.Warn("remove preserved managed database container after recreate", "id", previous.ID, "error", err)
		}
	}
	if record.Type == "redis" && previous.RedisConfigHash != "" && previous.RedisConfigHash != record.RedisConfigHash {
		previousConfigPath := filepath.Join(record.MountPath, "gateway-redis-"+previous.RedisConfigHash+".conf")
		if err := os.Remove(previousConfigPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			m.logger.Warn("remove superseded managed Redis config", "id", previous.ID, "error", err)
		}
	}
	return nil
}

func managedDatabaseRuntimeJSON(input managedDatabaseCommand) string {
	value, _ := json.Marshal(map[string]int64{
		"memoryLimit": input.MemoryBytes,
		"memorySwap":  input.MemorySwapBytes,
		"nanoCPUs":    input.NanoCPUs,
		"cpuShares":   input.CPUShares,
		"pidsLimit":   input.PidsLimit,
	})
	return string(value)
}

func (m *managedDatabaseManager) create(ctx context.Context, id string, input managedDatabaseCommand) (managedDatabaseRecord, error) {
	if err := validateManagedDatabaseInput(input); err != nil {
		return managedDatabaseRecord{}, err
	}
	if existing, err := m.loadRecord(id); err == nil {
		// A response can be lost after the record is written. Treat a repeated
		// create for the same managed-database ID as recovery, rather than
		// allocating a second volume or leaving the control plane in error.
		if existing.Type != input.Type {
			return managedDatabaseRecord{}, errors.New("managed database engine cannot be changed")
		}
		if existing.OperationID != input.OperationID {
			return managedDatabaseRecord{}, errors.New("managed database operation conflicts with an existing instance")
		}
		if err := m.ensureMounted(ctx, &existing); err != nil {
			return managedDatabaseRecord{}, err
		}
		if err := m.startContainer(ctx, existing.ContainerID); err != nil {
			return managedDatabaseRecord{}, err
		}
		if err := m.waitForDatabaseReady(ctx, existing.ContainerID, input); err != nil {
			return managedDatabaseRecord{}, err
		}
		existing.DesiredRunning = true
		if err := m.saveRecord(existing); err != nil {
			return managedDatabaseRecord{}, err
		}
		return existing, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return managedDatabaseRecord{}, err
	}
	if err := m.ensureCapacity(input.StorageSizeBytes); err != nil {
		return managedDatabaseRecord{}, err
	}

	record := managedDatabaseRecord{
		ID:                   id,
		Type:                 input.Type,
		ContainerName:        "gwdb-" + id,
		NetworkName:          "gwdb-" + id + "-net",
		ImagePath:            filepath.Join(m.root, "images", id+".img"),
		MountPath:            filepath.Join(m.root, "mounts", id),
		StorageSize:          input.StorageSizeBytes,
		DesiredRunning:       true,
		PublishedPort:        input.PublishedPort,
		PublishedNativePort:  input.PublishedNativePort,
		TLSEnabled:           input.TLSEnabled,
		TLSCertificateID:     input.TLSCertificateID,
		ClickhouseConfigHash: clickHouseConfigHash(input.ClickhouseConfig),
		RedisConfigHash:      managedRedisConfigHash(input),
		OperationID:          input.OperationID,
	}
	if input.Type == "clickhouse" {
		record.ClickhouseRuntimeProfileVersion = clickHouseRuntimeProfileVersion
	}

	if err := m.createImage(ctx, record); err != nil {
		return managedDatabaseRecord{}, err
	}
	created := false
	defer func() {
		if !created {
			cleanupCtx, cancel := context.WithTimeout(context.Background(), managedDatabaseCleanupTimeout)
			defer cancel()
			_ = m.cleanupStorage(cleanupCtx, &record, true)
		}
	}()
	if err := m.ensureMounted(ctx, &record); err != nil {
		return managedDatabaseRecord{}, err
	}
	if err := m.client.PullImage(ctx, input.Image, ""); err != nil {
		return managedDatabaseRecord{}, err
	}
	if err := m.createNetwork(ctx, record.NetworkName); err != nil {
		return managedDatabaseRecord{}, err
	}
	containerID, err := m.createContainer(ctx, &record, input)
	if err != nil {
		return managedDatabaseRecord{}, err
	}
	record.ContainerID = containerID
	if err := m.saveRecord(record); err != nil {
		_ = m.client.RemoveContainer(ctx, containerID, true)
		return managedDatabaseRecord{}, err
	}
	created = true
	return record, nil
}

func validateManagedDatabaseInput(input managedDatabaseCommand) error {
	if input.Type != "postgres" && input.Type != "redis" && input.Type != "clickhouse" {
		return errors.New("unsupported managed database type")
	}
	if input.Type == "redis" && input.OwnerUsername != "default" {
		return errors.New("Redis owner username must be default")
	}
	if !managedDatabaseIDPattern.MatchString(input.OperationID) {
		return errors.New("managed database operation id is invalid")
	}
	if !isCuratedDigestImage(input.Type, input.Image) {
		return errors.New("managed database image must be a curated sha256-pinned engine image")
	}
	if input.StorageSizeBytes < minimumDatabaseBytes {
		return fmt.Errorf("database storage must be at least %d bytes", minimumDatabaseBytes)
	}
	if input.MemoryBytes < 0 || input.NanoCPUs < 0 || input.CPUShares < 0 || input.PidsLimit < 0 {
		return errors.New("runtime limits cannot be negative")
	}
	if input.Type == "clickhouse" && input.MemoryBytes < minimumClickHouseBytes {
		return fmt.Errorf("ClickHouse requires at least %d bytes of memory", minimumClickHouseBytes)
	}
	if input.MemorySwapBytes != 0 && input.MemorySwapBytes != -1 && input.MemorySwapBytes < input.MemoryBytes {
		return errors.New("memory swap limit must be unlimited or at least the memory limit")
	}
	if !managedDatabaseName.MatchString(input.OwnerUsername) || !managedDatabaseName.MatchString(input.DatabaseName) {
		return errors.New("database and owner names must be safe SQL identifiers")
	}
	if len(input.OwnerPassword) < 16 || len(input.OwnerPassword) > 512 {
		return errors.New("managed database password must be between 16 and 512 characters")
	}
	if !input.PublishTCP && input.PublishedPort != 0 {
		return errors.New("host port is not allowed unless TCP publishing is enabled")
	}
	if !input.PublishTCP && input.PublishedNativePort != 0 {
		return errors.New("native host port is not allowed unless TCP publishing is enabled")
	}
	if input.PublishNativeTCP && (!input.PublishTCP || input.Type != "clickhouse") {
		return errors.New("native TCP publishing is supported only for published ClickHouse databases")
	}
	if !input.PublishNativeTCP && input.PublishedNativePort != 0 {
		return errors.New("native host port is not allowed unless native TCP publishing is enabled")
	}
	if input.Type != "clickhouse" && input.PublishedNativePort != 0 {
		return errors.New("native host port is supported only for ClickHouse")
	}
	if input.TLSEnabled {
		if input.TLSCertificatePEM == "" || input.TLSPrivateKeyPEM == "" || input.TLSCACertificatePEM == "" {
			return errors.New("managed database TLS material is required when TLS is enabled")
		}
		if !managedDatabaseIDPattern.MatchString(input.TLSCertificateID) {
			return errors.New("managed database TLS certificate id is invalid")
		}
		if _, err := tls.X509KeyPair([]byte(input.TLSCertificatePEM), []byte(input.TLSPrivateKeyPEM)); err != nil {
			return errors.New("managed database TLS certificate and key are invalid")
		}
	}
	if input.Type != "clickhouse" && input.ClickhouseConfig != "" {
		return errors.New("ClickHouse XML is supported only for ClickHouse")
	}
	if input.Type != "redis" && input.RedisConfig != nil {
		return errors.New("Redis configuration is supported only for Redis")
	}
	if input.Type == "redis" {
		config := normalizedManagedRedisConfig(input)
		policies := map[string]struct{}{
			"noeviction": {}, "allkeys-lru": {}, "allkeys-lfu": {}, "allkeys-random": {},
			"volatile-lru": {}, "volatile-lfu": {}, "volatile-random": {}, "volatile-ttl": {},
		}
		if config.MaxmemoryPercent < 10 || config.MaxmemoryPercent > 95 {
			return errors.New("Redis maxmemory percent must be between 10 and 95")
		}
		if _, ok := policies[config.MaxmemoryPolicy]; !ok {
			return errors.New("Redis maxmemory policy is invalid")
		}
		if config.AppendFsync != "always" && config.AppendFsync != "everysec" && config.AppendFsync != "no" {
			return errors.New("Redis append fsync policy is invalid")
		}
		if config.RDBSaveSeconds < 1 || config.RDBSaveSeconds > 31536000 || config.RDBSaveChanges < 1 || config.RDBSaveChanges > 1000000000 {
			return errors.New("Redis snapshot settings are invalid")
		}
		if config.AutoAOFRewritePercentage < 0 || config.AutoAOFRewritePercentage > 10000 || config.AutoAOFRewriteMinSizeMB < 1 || config.AutoAOFRewriteMinSizeMB > 1048576 {
			return errors.New("Redis AOF rewrite settings are invalid")
		}
		if config.MaxClients < 1 || config.MaxClients > 1000000 || config.TimeoutSeconds < 0 || config.TimeoutSeconds > 31536000 || config.TCPKeepaliveSeconds < 0 || config.TCPKeepaliveSeconds > 31536000 {
			return errors.New("Redis connection settings are invalid")
		}
		if config.SlowlogThresholdMicroseconds < -1 || config.SlowlogThresholdMicroseconds > 2147483647 || config.SlowlogMaxLen < 0 || config.SlowlogMaxLen > 1000000 {
			return errors.New("Redis slow log settings are invalid")
		}
	}
	return validateClickHouseFragment(input.ClickhouseConfig)
}

// Curated images are digest-pinned in the controller catalog.
var curatedManagedDatabaseImages = map[string]map[string]struct{}{
	"postgres": {
		"docker.io/library/postgres@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a": {},
		"docker.io/library/postgres@sha256:7e32e9833a6fb1c92c32552794cb6ed569d51b445a54907d35fc112ef39684db": {},
		"docker.io/library/postgres@sha256:a426e44bac0b759c95894d68e1a0ac03ecc20b619f498a91aae373bf06d8508d": {},
		"docker.io/library/postgres@sha256:69dddb030ab69d669d8d7c6abf67aeb448178e5270d5f123a21f4f7ac8b46a24": {},
		"docker.io/library/postgres@sha256:33f923b05f64ca54ac4401c01126a6b92afe839a0aa0a52bc5aeb5cc958e5f20": {},
		"docker.io/library/postgres@sha256:21f6013073bc6b92830a2129570e2f5ec42a6c734b5a985a41e83aa58f54c3c1": {},
		"docker.io/library/postgres@sha256:74e110c41804365e3915fcc09d5e7a1eff50161aaa94d5da0e58e0cd75ae509c": {},
		"docker.io/library/postgres@sha256:822f8795764a670160640888508b2a68ea5c4b045012c2de17e1d0447bdbdc99": {},
		"docker.io/library/postgres@sha256:caf49e3b10d377aa2cfee478591d623808527beb27125d38797b418013f72d81": {},
		"docker.io/library/postgres@sha256:962ffbe9f6418387643411b127c1db27465e5a23b9a8849bfaf45fa6323963ce": {},
	},
	"redis": {
		"docker.io/library/redis@sha256:c29e49ab2f85760a3827b53882e6dd9f5c6c3f0bb7d724e07bb31cbf275a5236": {},
		"docker.io/library/redis@sha256:c88d347edef6249a6d2293f926f1eeb48bd40c57cbcd02c07f52e7f1fd2cb46b": {},
		"docker.io/library/redis@sha256:aefcda4d4388a70e628ad5ebbf162ae65509b20ea3dd6eeac7dcbbb675d94dba": {},
		"docker.io/library/redis@sha256:6159aff1adde991d8747d705fa1135ceda04b0414dc372b381a6af415ec3b374": {},
		"docker.io/library/redis@sha256:616bb446d5db225ddf786052834279e7c7222c48694d4451e8af22b8f5953b28": {},
		"docker.io/library/redis@sha256:595cc6f2bb3af6e03347b90deb6123c6aa2c81dea05ce08128de8a174b6ac67b": {},
		"docker.io/library/redis@sha256:16623900b6ddd58e8bac04ccb6b611b9a5d1aed165453e28bcaed251d549d62c": {},
		"docker.io/library/redis@sha256:2a5e873bfae4bcc660b27f45c391d4a7a01799b65dea7286acc858e9c6c1e7d3": {},
	},
	"clickhouse": {
		"docker.io/clickhouse/clickhouse-server@sha256:d7556a3841027651307b5aa08d72b5c467d0241d3db5b67d9e158ef3975626f5": {},
		"docker.io/clickhouse/clickhouse-server@sha256:fdc22372465a336fa47e9deab61fad8277b9e2f2473234a1294b33b53f01d377": {},
		"docker.io/clickhouse/clickhouse-server@sha256:0d16977194aca61e26631e616e0678c2a745344d7d9da5729d2356f413dd28e1": {},
		"docker.io/clickhouse/clickhouse-server@sha256:ab3f33278b99576ea2ff2b0fa316b5e078c8b25f8ba08956cdbbb67d85c8b30f": {},
		"docker.io/clickhouse/clickhouse-server@sha256:422be85ae7344058369cdd366ac0efea9daa8428b55c9cf50258e83a7d12fcb3": {},
		"docker.io/clickhouse/clickhouse-server@sha256:a9d328123ff8a61bf6b16448528b577d59deb85758172e13b09054b0727f8adf": {},
		"docker.io/clickhouse/clickhouse-server@sha256:0ab6e7c7597232b56c2883f67ef91154e7e3b54d1fda57606334aad65275e735": {},
		"docker.io/clickhouse/clickhouse-server@sha256:1ffa82edee000a42c09313bd9f1293d94c570aee74babc1b3ca9983a35fa597b": {},
		"docker.io/clickhouse/clickhouse-server@sha256:85b97f63dcfff47790d26bb5d5801637aaddb2b93e5e9aee27a686c2fb2b9916": {},
	},
}

func isCuratedDigestImage(engine, image string) bool {
	if !digestImagePattern.MatchString(image) {
		return false
	}
	_, ok := curatedManagedDatabaseImages[engine][image]
	return ok
}

func validateClickHouseFragment(fragment string) error {
	if fragment == "" {
		return nil
	}
	if len(fragment) > 64*1024 {
		return errors.New("ClickHouse XML fragment exceeds 64 KiB")
	}
	decoder := xml.NewDecoder(strings.NewReader(fragment))
	rootSeen := false
	for {
		token, err := decoder.Token()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("invalid ClickHouse XML: %w", err)
		}
		switch t := token.(type) {
		case xml.Directive:
			return errors.New("ClickHouse XML directives are not allowed")
		case xml.ProcInst:
			return errors.New("ClickHouse XML processing instructions are not allowed")
		case xml.StartElement:
			name := strings.ToLower(t.Name.Local)
			if !rootSeen {
				if name != "clickhouse" {
					return errors.New("ClickHouse XML fragment root must be <clickhouse>")
				}
				rootSeen = true
			}
			if forbiddenClickHouseElement(name) {
				return fmt.Errorf("ClickHouse XML element %q is managed by Gateway", name)
			}
			for _, attr := range t.Attr {
				attrName := strings.ToLower(attr.Name.Local)
				if attrName == "incl" || attrName == "from_env" || attrName == "replace" {
					return fmt.Errorf("ClickHouse XML attribute %q is not allowed", attrName)
				}
			}
		}
	}
	if !rootSeen {
		return errors.New("ClickHouse XML fragment is empty")
	}
	return nil
}

func forbiddenClickHouseElement(name string) bool {
	switch name {
	case "listen_host", "http_port", "tcp_port", "interserver_http_port", "path", "tmp_path", "user_directories", "users", "profiles", "quotas", "remote_servers", "zookeeper", "keeper_server", "macros", "open_ssl", "certificates":
		return true
	default:
		return false
	}
}

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

func loopDeviceFromLosetupOutput(output []byte) string {
	for _, line := range strings.Split(string(output), "\n") {
		candidate := strings.TrimSpace(line)
		if strings.HasPrefix(candidate, "/dev/loop") && !strings.ContainsAny(candidate, " \t") {
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
		redisConfigPath := managedRedisConfigPath(*record, input)
		if err := writeManagedRedisConfig(redisConfigPath, managedRedisConfigText(input)); err != nil {
			return "", fmt.Errorf("write Redis managed config: %w", err)
		}
		containerCfg.Cmd = []string{"redis-server", "/run/gateway-config/redis.conf", "--dir", "/data", "--requirepass", input.OwnerPassword}
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
