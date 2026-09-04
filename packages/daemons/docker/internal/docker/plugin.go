package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
	"github.com/wiolett-industries/gateway/daemon-shared/stream"
	"github.com/wiolett-industries/gateway/daemon-shared/sysmetrics"
	builderruntime "github.com/wiolett-industries/gateway/docker-daemon/internal/builder"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
	runtimemanager "github.com/wiolett-industries/gateway/docker-daemon/internal/runtime"
)

// DockerPlugin implements lifecycle.DaemonPlugin for the docker daemon.
type DockerPlugin struct {
	cfg     *config.Config
	logger  *slog.Logger
	client  *Client
	version string // Docker engine version

	allowlist         *AllowlistChecker
	envStore          *EnvStore
	taskMgr           *TaskManager
	deploymentOpMu    sync.Mutex
	deploymentOps     map[string]deploymentOperation
	deploymentOpSeq   uint64
	registryMu        sync.RWMutex
	registryCreds     map[string]string // registry URL -> base64-encoded auth
	statsCollector    *StatsCollector
	execMgr           *ExecManager
	migrationStore    *migrationArtifactStore
	archiveStreams    *archiveLiveStore
	databaseManager   *managedDatabaseManager
	composeExecutor   *composeExecutor
	volumeImages      *volumeImageManager
	relayGrants       *relayGrantStore
	relayTunnelMu     sync.Mutex
	relayTunnels      map[string]*relayTunnelRouter
	relaySelection    uint64
	relayListener     net.Listener
	databaseListeners *managedDatabaseHostListenerManager
	registryProxy     *dockerRegistryProxyManager
	builderManager    *builderruntime.Manager
	secureLinks       *dockerSecureLinkManager
	secureLinkState   *securelink.StateStore
	runtimeManager    *runtimemanager.Manager
	runtimeStatusMu   sync.RWMutex
	runtimeStatus     runtimemanager.Status
	availability      *availabilityManager

	// Log stream follow support
	writer           *stream.Writer
	buildEventMu     sync.RWMutex
	buildEventWriter *stream.Writer
	sessionCtx       context.Context
	logStreamMu      sync.Mutex
	logStreamCancel  map[string]context.CancelFunc // containerId -> cancel
}

var _ lifecycle.ProxySecureLinkPlugin = (*DockerPlugin)(nil)

const dockerLogsCommandTimeout = 15 * time.Second
const emergencyKillCancellationTimeout = 30 * time.Second

func dockerTimeoutProvided(configJSON string) bool {
	if configJSON == "" {
		return false
	}
	var payload struct {
		TimeoutProvided bool `json:"timeoutProvided"`
	}
	if err := json.Unmarshal([]byte(configJSON), &payload); err != nil {
		return false
	}
	return payload.TimeoutProvided
}

// NewDockerPlugin creates a new DockerPlugin with the given configuration.
func NewDockerPlugin(cfg *config.Config) *DockerPlugin {
	return &DockerPlugin{cfg: cfg}
}

// Type returns the daemon type identifier.
func (p *DockerPlugin) Type() string {
	return "docker"
}

// SetLogger replaces the plugin's logger with a session-scoped one.
func (p *DockerPlugin) SetLogger(logger *slog.Logger) {
	p.logger = logger
}

// Init initializes the Docker client, pings the engine, and stores its version.
func (p *DockerPlugin) Init(cfg *lifecycle.BaseConfig, logger *slog.Logger) error {
	p.logger = logger
	p.availability = nil
	ctx := context.Background()

	if p.cfg.Docker.Mode == "builder" {
		var err error
		p.relayGrants, err = newRelayGrantStore(p.cfg.StateDir)
		if err != nil {
			return fmt.Errorf("initialize relay grant store: %w", err)
		}
		p.registryProxy, err = newDockerRegistryProxyManager(p)
		if err != nil {
			return fmt.Errorf("initialize builder registry proxy: %w", err)
		}
		runtimeConfig := builderruntime.DefaultRuntimeConfig(0)
		runtimeConfig.EgressProfile = p.cfg.Docker.Builder.EgressProfile
		runtimeConfig.ControlPlaneAddress = p.cfg.Gateway.Address
		runtimeSupervisor := builderruntime.NewRuntimeSupervisor(runtimeConfig)
		if err := runtimeSupervisor.InstallConfiguration(); err != nil {
			return fmt.Errorf("install isolated builder runtime configuration: %w", err)
		}
		if err := runtimeSupervisor.Start(); err != nil {
			return fmt.Errorf("start isolated builder runtime: %w", err)
		}
		p.registryCreds = make(map[string]string)
		p.builderManager = builderruntime.NewManager(
			runtimeConfig,
			filepath.Join(p.cfg.StateDir, "builder", "jobs"),
			builderruntime.DefaultGitAskpassPath,
			p.emitBuildEvent,
		)
		p.logger.Info("builder profile initialized without Docker Engine access")
		return nil
	}

	var availability *availabilityManager
	if p.cfg.Docker.Mode == "" {
		var availabilityErr error
		availability, availabilityErr = newAvailabilityManager(p.cfg.StateDir)
		if availabilityErr != nil {
			return fmt.Errorf("initialize docker availability state: %w", availabilityErr)
		}
	}

	c, err := NewClient(p.cfg.Docker.Socket, p.cfg.StateDir, logger)
	if err != nil {
		return fmt.Errorf("init docker client: %w", err)
	}
	p.client = c

	if err := c.Ping(ctx); err != nil {
		return fmt.Errorf("docker ping failed: %w", err)
	}

	ver, err := c.GetVersion(ctx)
	if err != nil {
		return fmt.Errorf("get docker version: %w", err)
	}
	p.version = ver
	p.logger.Info("docker engine connected", "version", ver, "socket", p.cfg.Docker.Socket)

	// Initialize allowlist from config
	p.allowlist = NewAllowlistChecker(p.cfg.Docker.Allowlist)

	// Initialize envstore
	envDir := filepath.Join(p.cfg.StateDir, "envstore")
	p.envStore = NewEnvStore(envDir)

	// Initialize task manager
	p.taskMgr = NewTaskManager()
	p.deploymentOps = make(map[string]deploymentOperation)
	p.migrationStore, err = newMigrationArtifactStore(p.cfg.StateDir)
	if err != nil {
		return err
	}
	if err := p.migrationStore.cleanupStale(time.Now()); err != nil {
		p.logger.Warn("stale migration artifact cleanup failed", "error", err)
	}
	p.archiveStreams = newArchiveLiveStore()
	p.relayGrants, err = newRelayGrantStore(p.cfg.StateDir)
	if err != nil {
		return fmt.Errorf("initialize relay grant store: %w", err)
	}
	if p.cfg.Docker.Mode != "databases" {
		p.databaseListeners = newManagedDatabaseHostListenerManager(p)
		for bindingID, status := range p.databaseListeners.reconcile(ctx, p.relayGrants.get()) {
			if status.State == "error" {
				p.logger.Warn("managed database host listener restore deferred", "binding_id", bindingID, "error", status.Error)
			}
		}
	}
	if p.cfg.Docker.Mode != "databases" {
		p.registryProxy, err = newDockerRegistryProxyManager(p)
		if err != nil {
			return fmt.Errorf("initialize docker registry proxy: %w", err)
		}
	}
	if p.cfg.Docker.Mode == "databases" {
		p.databaseManager, err = newManagedDatabaseManager(p.cfg, p.client, p.logger)
		if err != nil {
			return fmt.Errorf("initialize managed database storage: %w", err)
		}
		if err := p.databaseManager.reconcile(ctx); err != nil {
			return fmt.Errorf("reconcile managed database storage: %w", err)
		}
	}
	if p.cfg.Docker.Mode != "databases" {
		composeExecutor, composeErr := newComposeExecutor(p.cfg, p.client, p.logger)
		if composeErr != nil {
			p.logger.Warn("docker compose executor unavailable", "reason", composeErr.Error())
		} else {
			p.composeExecutor = composeExecutor
		}
		p.volumeImages, err = newVolumeImageManager(p.cfg.StateDir, p.client, p.logger)
		if err != nil {
			return fmt.Errorf("initialize disk-image volume storage: %w", err)
		}
		p.secureLinks, err = newDockerSecureLinkManager(p)
		if err != nil {
			return fmt.Errorf("initialize proxy secure links: %w", err)
		}
		p.secureLinkState, err = securelink.NewStateStore(p.cfg.StateDir)
		if err != nil {
			return fmt.Errorf("initialize proxy secure-link state: %w", err)
		}
		pending, hasPending, pendingErr := p.secureLinkState.Pending()
		if pendingErr != nil {
			return fmt.Errorf("read pending proxy secure-link state: %w", pendingErr)
		}
		restored := p.secureLinkState.Get()
		if hasPending && len(pending.Bindings) == 0 {
			// An interrupted last-link teardown must win over the older committed
			// snapshot; otherwise restart would recreate the connector that the
			// cleanup had already removed.
			if cleanupErr := p.secureLinks.removeConnector(context.Background()); cleanupErr != nil {
				p.logger.Warn("proxy secure-link pending cleanup deferred", "error", cleanupErr)
			} else if commitErr := p.secureLinkState.Commit(pending); commitErr != nil {
				return fmt.Errorf("commit pending proxy secure-link cleanup: %w", commitErr)
			}
		} else if len(restored.Bindings) > 0 {
			statuses, restoreErr := p.secureLinks.sync(restored)
			if restoreErr != nil {
				p.logger.Warn("proxy secure-link restore deferred", "error", restoreErr)
			} else if saveErr := p.secureLinkState.Commit(normalizeTargetBindings(restored, statuses)); saveErr != nil {
				return fmt.Errorf("persist restored proxy secure links: %w", saveErr)
			}
		} else if hasPending {
			// No committed bindings means an interrupted first apply or teardown.
			// Empty cleanup discovers any surviving managed connector by name.
			if cleanupErr := p.secureLinks.removeConnector(context.Background()); cleanupErr != nil {
				p.logger.Warn("proxy secure-link pending cleanup deferred", "error", cleanupErr)
			} else if discardErr := p.secureLinkState.DiscardPending(); discardErr != nil {
				return fmt.Errorf("clear proxy secure-link pending state: %w", discardErr)
			}
		}
	}

	// Initialize registry credentials map
	p.registryCreds = make(map[string]string)
	p.runtimeManager = runtimemanager.NewManager()
	p.runtimeManager.DockerHost = p.cfg.Docker.Socket
	p.runtimeManager.ProgressReporter = p.setRuntimeStatus
	preflightCtx, cancelPreflight := context.WithTimeout(ctx, 90*time.Second)
	if migrated, migrateErr := p.runtimeManager.ReconcileInstalledConfig(preflightCtx); migrateErr != nil {
		p.logger.Warn("runsc Docker configuration migration failed", "error", migrateErr)
	} else if migrated {
		p.logger.Info("runsc Docker configuration migrated")
	}
	p.setRuntimeStatus(p.runtimeManager.Preflight(preflightCtx))
	cancelPreflight()
	p.availability = availability

	return nil
}

func (p *DockerPlugin) setRuntimeStatus(status runtimemanager.Status) {
	p.runtimeStatusMu.Lock()
	p.runtimeStatus = status
	p.runtimeStatusMu.Unlock()
	if p.client != nil {
		p.client.SetRunscHealthy(status.State == runtimemanager.StateHealthy)
	}
	if p.writer != nil {
		if err := p.writer.Send(&pb.DaemonMessage{
			Payload: &pb.DaemonMessage_DockerRuntimeStatus{
				DockerRuntimeStatus: protobufRuntimeStatus(status),
			},
		}); err != nil && p.logger != nil {
			p.logger.Warn("failed to report Docker runtime status", "error", err)
		}
	}
}

func (p *DockerPlugin) getRuntimeStatus() runtimemanager.Status {
	p.runtimeStatusMu.RLock()
	defer p.runtimeStatusMu.RUnlock()
	return p.runtimeStatus
}

func protobufRuntimeStatus(status runtimemanager.Status) *pb.DockerRuntimeStatus {
	result := &pb.DockerRuntimeStatus{
		State:               string(status.State),
		InstalledVersion:    status.InstalledVersion,
		TargetVersion:       status.TargetVersion,
		ReasonCode:          status.ReasonCode,
		Message:             status.Message,
		CheckedAtUnixMs:     status.CheckedAt.UnixMilli(),
		RemoteInstallable:   status.RemoteInstallable,
		LocalInstallCommand: status.LocalInstallCommand,
		Step:                string(status.Step),
	}
	if status.ProgressPercent != nil {
		result.ProgressPercent = *status.ProgressPercent
	}
	return result
}

// BuildRegisterMessage constructs the registration message for the gateway.
func (p *DockerPlugin) BuildRegisterMessage(nodeID string) *pb.RegisterMessage {
	hostname, _ := os.Hostname()
	cpuModel, cpuCores := sysmetrics.GetCPUInfo()
	arch := sysmetrics.GetArchitecture()
	kernelVer := sysmetrics.GetKernelVersion()

	capabilities := func() []string {
		if p.cfg.Docker.Mode == "builder" {
			values := []string{
				"docker_builder_profile_v1",
				"docker_registry_proxy_v1",
				"generic_relay_tunnel_v1",
				"relay_pool_v1",
			}
			if p.builderManager != nil && p.builderManager.Ready() == nil {
				values = append(
					values,
					"docker_builder_execution_v1",
					"docker_builder_dedicated_runtime_v1",
					"docker_builder_resource_limits_v1",
				)
			}
			return values
		}
		if p.cfg.Docker.Mode == "databases" {
			return []string{
				"managed_databases_v1",
				"managed_database_storage_images_v1",
				"generic_relay_tunnel_v1",
				"managed_clickhouse_principals_v1",
				"managed_database_binding_principals_v2",
				"relay_pool_v1",
			}
		}
		values := []string{"docker_deployments_v1", "docker_gpu_v1", "docker_migration_v1", "docker_archive_v1", "docker_port_bind_ip_v1", "generic_relay_tunnel_v1", "relay_pool_v1", "proxy_secure_links_v1", "docker_registry_proxy_v1", "docker_runtime_management_v1", "docker_managed_volumes_v1"}
		if p.cfg.Docker.Mode == "" && p.availability != nil {
			values = append(values, dockerAvailabilityCapability)
		}
		values = append(values, "managed_database_binding_listener_v1")
		if p.volumeImages != nil && p.volumeImages.supported {
			values = append(values, "docker_volume_storage_images_v1")
		}
		if p.getRuntimeStatus().State == runtimemanager.StateHealthy {
			values = append(values, "docker_runsc_healthy_v1")
		}
		if p.composeExecutor != nil {
			values = append(values, "docker_compose_v1")
		}
		return values
	}()
	message := &pb.RegisterMessage{
		NodeId:        nodeID,
		Hostname:      hostname,
		DaemonVersion: lifecycle.Version,
		DaemonType:    "docker",
		CpuModel:      cpuModel,
		CpuCores:      int32(cpuCores),
		Architecture:  arch,
		KernelVersion: kernelVer,
		// Store docker version in the NginxVersion field as a capability hint.
		// The gateway uses DaemonType to interpret this field correctly.
		NginxVersion: p.version,
		Capabilities: capabilities,
	}
	if p.cfg.Docker.Mode != "builder" {
		message.DockerRuntimeStatus = protobufRuntimeStatus(p.getRuntimeStatus())
	}
	return message
}
