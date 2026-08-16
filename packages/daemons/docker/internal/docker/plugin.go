package docker

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
	"github.com/wiolett-industries/gateway/daemon-shared/stream"
	"github.com/wiolett-industries/gateway/daemon-shared/sysmetrics"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/config"
	runtimemanager "github.com/wiolett-industries/gateway/docker-daemon/internal/runtime"
)

// DockerPlugin implements lifecycle.DaemonPlugin for the docker daemon.
type DockerPlugin struct {
	cfg     *config.Config
	logger  *slog.Logger
	client  *Client
	version string // Docker engine version

	allowlist       *AllowlistChecker
	envStore        *EnvStore
	taskMgr         *TaskManager
	registryMu      sync.RWMutex
	registryCreds   map[string]string // registry URL -> base64-encoded auth
	statsCollector  *StatsCollector
	execMgr         *ExecManager
	migrationStore  *migrationArtifactStore
	archiveStreams  *archiveLiveStore
	databaseManager *managedDatabaseManager
	relayGrants     *relayGrantStore
	relayTunnelMu   sync.Mutex
	relayTunnel     *relayTunnelRouter
	secureLinks     *dockerSecureLinkManager
	secureLinkState *securelink.StateStore
	runtimeManager  *runtimemanager.Manager
	runtimeStatusMu sync.RWMutex
	runtimeStatus   runtimemanager.Status

	// Log stream follow support
	writer          *stream.Writer
	sessionCtx      context.Context
	logStreamMu     sync.Mutex
	logStreamCancel map[string]context.CancelFunc // containerId -> cancel
}

var _ lifecycle.ProxySecureLinkPlugin = (*DockerPlugin)(nil)

const dockerLogsCommandTimeout = 15 * time.Second

// This tag exists solely for the local development workflow. Production
// connector provisioning uses the separate `ensure` action and digest refs.
const developmentDatabaseConnectorImage = "gateway-database-connector:dev"

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

	c, err := NewClient(p.cfg.Docker.Socket, logger)
	if err != nil {
		return fmt.Errorf("init docker client: %w", err)
	}
	p.client = c

	ctx := context.Background()

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
	p.setRuntimeStatus(p.runtimeManager.Preflight(preflightCtx))
	cancelPreflight()

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
		if p.cfg.Docker.Mode == "databases" {
			return []string{
				"managed_databases_v1",
				"managed_database_storage_images_v1",
				"generic_relay_tunnel_v1",
				"managed_clickhouse_principals_v1",
			}
		}
		values := []string{"docker_deployments_v1", "docker_gpu_v1", "docker_migration_v1", "docker_archive_v1", "docker_port_bind_ip_v1", "generic_relay_tunnel_v1", "proxy_secure_links_v1", "docker_runtime_management_v1", "docker_managed_volumes_v1"}
		if p.getRuntimeStatus().State == runtimemanager.StateHealthy {
			values = append(values, "docker_runsc_healthy_v1")
		}
		return values
	}()
	return &pb.RegisterMessage{
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
		NginxVersion:        p.version,
		Capabilities:        capabilities,
		DockerRuntimeStatus: protobufRuntimeStatus(p.getRuntimeStatus()),
	}
}

// HandleCommand dispatches a gateway command to the appropriate handler.
func (p *DockerPlugin) HandleCommand(cmd *pb.GatewayCommand) *pb.CommandResult {
	result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
	if p.cfg.Docker.Mode == "databases" {
		switch payload := cmd.Payload.(type) {
		case *pb.GatewayCommand_DockerDatabase:
			p.handleManagedDatabaseCommand(payload.DockerDatabase, result)
		default:
			result.Success = false
			result.Error = "database-profile daemon accepts only docker_database commands"
		}
		return result
	}

	switch payload := cmd.Payload.(type) {
	case *pb.GatewayCommand_DockerContainer:
		p.handleContainerCommand(payload.DockerContainer, result)

	case *pb.GatewayCommand_DockerImage:
		p.handleImageCommand(payload.DockerImage, result)

	case *pb.GatewayCommand_DockerVolume:
		p.handleVolumeCommand(payload.DockerVolume, result)

	case *pb.GatewayCommand_DockerNetwork:
		p.handleNetworkCommand(payload.DockerNetwork, result)

	case *pb.GatewayCommand_DockerDeployment:
		p.handleDeploymentCommand(payload.DockerDeployment, result)

	case *pb.GatewayCommand_DockerRuntime:
		p.handleRuntimeCommand(payload.DockerRuntime, result)

	case *pb.GatewayCommand_DockerExec:
		p.handleExecCommand(payload.DockerExec, result)

	case *pb.GatewayCommand_DockerFile:
		p.handleFileCommand(payload.DockerFile, result)

	case *pb.GatewayCommand_ExecInput:
		p.handleExecInput(payload.ExecInput)

	case *pb.GatewayCommand_DockerLogs:
		p.handleLogsCommand(payload.DockerLogs, result)

	case *pb.GatewayCommand_DockerConfigPush:
		p.handleConfigPush(payload.DockerConfigPush, result)

	case *pb.GatewayCommand_DockerMigration:
		p.handleMigrationCommand(payload.DockerMigration, result)

	case *pb.GatewayCommand_DockerDatabase:
		result.Success = false
		result.Error = "managed database commands require docker.mode=databases"

	case *pb.GatewayCommand_SetDaemonLogStream:
		stream.SetDaemonLogStreaming(payload.SetDaemonLogStream.Enabled, payload.SetDaemonLogStream.MinLevel)
		p.logger.Info("daemon log stream updated", "enabled", payload.SetDaemonLogStream.Enabled, "min_level", payload.SetDaemonLogStream.MinLevel)

	default:
		result.Success = false
		result.Error = "unsupported command for docker daemon"
	}

	return result
}

func (p *DockerPlugin) handleRuntimeCommand(cmd *pb.DockerRuntimeCommand, result *pb.CommandResult) {
	if p.runtimeManager == nil || cmd.Runtime != "runsc" {
		result.Success = false
		result.Error = "unsupported Docker runtime"
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	var status runtimemanager.Status
	var err error
	switch cmd.Action {
	case "preflight":
		status = p.runtimeManager.Preflight(ctx)
	case "install":
		p.setRuntimeStatus(runtimemanager.Status{
			State:         runtimemanager.StateInstalling,
			TargetVersion: runtimemanager.RunscVersion,
			CheckedAt:     time.Now().UTC(),
		})
		status, err = p.runtimeManager.Install(ctx)
	default:
		result.Success = false
		result.Error = "unknown runtime action"
		return
	}
	p.setRuntimeStatus(status)
	data, marshalErr := json.Marshal(status)
	if marshalErr != nil {
		result.Success = false
		result.Error = marshalErr.Error()
		return
	}
	result.Detail = string(data)
	if err != nil {
		result.Success = false
		result.Error = err.Error()
	}
}

// handleContainerCommand dispatches container actions.
func (p *DockerPlugin) handleContainerCommand(cmd *pb.DockerContainerCommand, result *pb.CommandResult) {
	ctx := context.Background()

	switch cmd.Action {
	case "list":
		containers, err := p.client.ListContainers(ctx)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		// Filter by allowlist
		containers = p.allowlist.Filter(containers)
		data, err := json.Marshal(containers)
		if err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("marshal containers: %v", err)
			return
		}
		result.Detail = string(data)

	case "inspect":
		data, err := p.client.InspectContainer(ctx, cmd.ContainerId)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = string(data)

	case "start":
		if err := p.client.StartContainer(ctx, cmd.ContainerId); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "stop":
		timeout := int(cmd.TimeoutSeconds)
		timeoutProvided := dockerTimeoutProvided(cmd.ConfigJson)
		if timeout < 0 || (timeout == 0 && !timeoutProvided) {
			timeout = defaultContainerStopTimeoutSeconds
		}
		// Run async to avoid blocking the command handler
		containerID := cmd.ContainerId
		go func() {
			if err := p.client.StopContainer(context.Background(), containerID, timeout); err != nil {
				p.logger.Warn("container stop failed", "container", containerID, "error", err)
			}
		}()

	case "restart":
		timeout := int(cmd.TimeoutSeconds)
		timeoutProvided := dockerTimeoutProvided(cmd.ConfigJson)
		if timeout < 0 || (timeout == 0 && !timeoutProvided) {
			timeout = defaultContainerStopTimeoutSeconds
		}
		containerID := cmd.ContainerId
		go func() {
			if err := p.client.RestartContainer(context.Background(), containerID, timeout); err != nil {
				p.logger.Warn("container restart failed", "container", containerID, "error", err)
			}
		}()

	case "kill":
		signal := cmd.Signal
		if signal == "" {
			signal = "SIGKILL"
		}
		if err := p.client.KillContainer(ctx, cmd.ContainerId, signal); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "remove":
		if err := p.client.RemoveContainer(ctx, cmd.ContainerId, cmd.Force); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "rename":
		if cmd.NewName == "" {
			result.Success = false
			result.Error = "new_name is required for rename"
			return
		}
		if err := p.client.RenameContainer(ctx, cmd.ContainerId, cmd.NewName); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "create":
		if cmd.ConfigJson == "" {
			result.Success = false
			result.Error = "config_json is required for create"
			return
		}
		id, name, err := p.client.CreateContainer(ctx, cmd.ConfigJson)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, _ := json.Marshal(map[string]string{"id": id, "name": name})
		result.Detail = string(data)

	case "duplicate":
		if cmd.NewName == "" {
			result.Success = false
			result.Error = "new_name is required for duplicate"
			return
		}
		id, err := p.client.DuplicateContainer(ctx, cmd.ContainerId, cmd.NewName)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, _ := json.Marshal(map[string]string{"id": id})
		result.Detail = string(data)

	case "update":
		// Container update is a long-running operation, use task manager.
		// Parse update params from config_json.
		var params struct {
			Tag         string            `json:"tag"`
			Env         map[string]string `json:"env"`
			EnvRemovals []string          `json:"env_removals"`
			RemoveEnv   []string          `json:"removeEnv"`
		}
		if cmd.ConfigJson != "" {
			if err := json.Unmarshal([]byte(cmd.ConfigJson), &params); err != nil {
				result.Success = false
				result.Error = fmt.Sprintf("parse update params: %v", err)
				return
			}
		}

		containerID := cmd.ContainerId

		// Determine registry auth for the container's image
		p.registryMu.RLock()
		regCreds := make(map[string]string, len(p.registryCreds))
		for k, v := range p.registryCreds {
			regCreds[k] = v
		}
		p.registryMu.RUnlock()

		// Resolve container name for envstore
		containerName, _ := p.client.ContainerName(ctx, containerID)

		task, err := p.taskMgr.Submit(containerID, "update", 10*time.Minute, func(taskCtx context.Context) error {
			// Compute env changes via envstore
			var envOverrides map[string]string
			var envRemovals []string

			explicitRemovals := append([]string{}, params.EnvRemovals...)
			explicitRemovals = append(explicitRemovals, params.RemoveEnv...)

			if len(params.Env) > 0 || len(explicitRemovals) > 0 {
				if containerName != "" {
					// Apply env changes through envstore
					_, applyErr := p.envStore.Apply(containerName, params.Env, explicitRemovals)
					if applyErr != nil {
						p.logger.Warn("envstore apply failed", "error", applyErr)
					}
					envRemovals = append(envRemovals, explicitRemovals...)
				}
				envOverrides = params.Env
			}

			// Resolve registry auth for the image
			inspData, inspErr := p.client.InspectContainer(taskCtx, containerID)
			registryAuth := ""
			if inspErr == nil {
				var inspJSON struct {
					Config struct {
						Image  string            `json:"Image"`
						Labels map[string]string `json:"Labels"`
					} `json:"Config"`
				}
				if json.Unmarshal(inspData, &inspJSON) == nil {
					imageReference := configuredArchiveImageReference(inspJSON.Config.Image, inspJSON.Config.Labels)
					if imageReference != "" {
						registryAuth = resolveRegistryAuth(imageReference, regCreds)
					}
				}
			}

			if err := p.client.UpdateContainer(taskCtx, containerID, params.Tag, envOverrides, envRemovals, registryAuth); err != nil {
				return err
			}

			// Save applied env
			if containerName != "" && len(params.Env) > 0 {
				_ = p.envStore.SaveApplied(containerName, params.Env)
			}

			return nil
		})
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

		data, _ := json.Marshal(task)
		result.Detail = string(data)

	case "stats":
		if cmd.ContainerId == "" {
			result.Success = false
			result.Error = "container_id is required for stats"
			return
		}
		// Return cached stats from the background collector (updated every 10s)
		// Falls back to a live fetch if no cached data available
		if p.statsCollector != nil {
			for _, s := range p.statsCollector.GetStats() {
				if s.ContainerId == cmd.ContainerId {
					data, _ := json.Marshal(s)
					result.Detail = string(data)
					return
				}
			}
		}
		// Fallback: live fetch (slower, ~1s)
		data, err := p.client.ContainerStatsOnce(ctx, cmd.ContainerId)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = string(data)

	case "top":
		if cmd.ContainerId == "" {
			result.Success = false
			result.Error = "container_id is required for top"
			return
		}
		data, err := p.client.ContainerTop(ctx, cmd.ContainerId)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = string(data)

	case "http_probe":
		if cmd.ConfigJson == "" {
			result.Success = false
			result.Error = "config_json is required for http_probe"
			return
		}
		data, err := p.client.HTTPProbe(ctx, cmd.ConfigJson)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		detail, _ := json.Marshal(data)
		result.Detail = string(detail)

	case "live_update":
		if cmd.ContainerId == "" || cmd.ConfigJson == "" {
			result.Success = false
			result.Error = "container_id and config_json are required for live_update"
			return
		}
		if err := p.client.LiveUpdateContainer(ctx, cmd.ContainerId, cmd.ConfigJson); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "recreate":
		if cmd.ContainerId == "" || cmd.ConfigJson == "" {
			result.Success = false
			result.Error = "container_id and config_json are required for recreate"
			return
		}
		containerID := cmd.ContainerId
		task, err := p.taskMgr.Submit(containerID, "recreate", 10*time.Minute, func(taskCtx context.Context) error {
			return p.client.RecreateWithConfig(taskCtx, containerID, cmd.ConfigJson)
		})
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, _ := json.Marshal(task)
		result.Detail = string(data)

	case "task_status":
		if cmd.ContainerId == "" {
			result.Success = false
			result.Error = "container_id is required for task_status"
			return
		}
		task, ok := p.taskMgr.Get(cmd.ContainerId)
		if !ok {
			result.Success = false
			result.Error = "docker task not found"
			return
		}
		data, _ := json.Marshal(task)
		result.Detail = string(data)

	default:
		result.Success = false
		result.Error = fmt.Sprintf("unknown container action: %s", cmd.Action)
	}
}

// handleImageCommand dispatches image actions.
func (p *DockerPlugin) handleImageCommand(cmd *pb.DockerImageCommand, result *pb.CommandResult) {
	ctx := context.Background()

	switch cmd.Action {
	case "list":
		data, err := p.client.ListImages(ctx)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = string(data)

	case "pull", "ensure", "ensure-local":
		imageRef := cmd.ImageRef
		if imageRef == "" {
			result.Success = false
			result.Error = "image_ref is required for " + cmd.Action
			return
		}
		if cmd.Action == "ensure" && !digestImagePattern.MatchString(imageRef) {
			result.Success = false
			result.Error = "image_ref must use an immutable sha256 digest for ensure"
			return
		}
		if cmd.Action == "ensure-local" && imageRef != developmentDatabaseConnectorImage {
			result.Success = false
			result.Error = "image_ref must use the fixed development connector image for ensure-local"
			return
		}

		registryAuth := cmd.RegistryAuthJson
		if registryAuth == "" {
			// Try to resolve from stored credentials
			p.registryMu.RLock()
			registryAuth = resolveRegistryAuth(imageRef, p.registryCreds)
			p.registryMu.RUnlock()
		}

		// "ensure" is used by the digest-pinned production connector and
		// "ensure-local" by the one fixed development image. Both avoid a
		// registry round-trip when the exact reference is already local.
		var err error
		if cmd.Action == "ensure" || cmd.Action == "ensure-local" {
			err = p.client.EnsureImage(ctx, imageRef, registryAuth)
		} else {
			err = p.client.PullImage(ctx, imageRef, registryAuth)
		}
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = imageRef

	case "remove":
		if cmd.ImageRef == "" {
			result.Success = false
			result.Error = "image_ref is required for remove"
			return
		}
		if err := p.client.RemoveImage(ctx, cmd.ImageRef, cmd.Force); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "prune":
		reclaimed, err := p.client.PruneImages(ctx)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, _ := json.Marshal(map[string]int64{"space_reclaimed": reclaimed})
		result.Detail = string(data)

	default:
		result.Success = false
		result.Error = fmt.Sprintf("unknown image action: %s", cmd.Action)
	}
}

// handleVolumeCommand dispatches volume actions.
func (p *DockerPlugin) handleVolumeCommand(cmd *pb.DockerVolumeCommand, result *pb.CommandResult) {
	ctx := context.Background()

	switch cmd.Action {
	case "list":
		data, err := p.client.ListVolumes(ctx)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = string(data)

	case "inspect":
		if cmd.Name == "" {
			result.Success = false
			result.Error = "name is required for volume inspect"
			return
		}
		data, err := p.client.InspectVolume(ctx, cmd.Name)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = string(data)

	case "list-files":
		if cmd.Name == "" {
			result.Success = false
			result.Error = "name is required for volume file list"
			return
		}
		path := cmd.Path
		if path == "" {
			path = "/"
		}
		entries, err := ListVolumeDir(ctx, p.client, cmd.Name, path)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, err := json.Marshal(entries)
		if err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("marshal entries: %v", err)
			return
		}
		result.Detail = string(data)

	case "export":
		if cmd.Name == "" {
			result.Success = false
			result.Error = "name is required for volume export"
			return
		}
		content, err := ExportVolume(ctx, p.client, cmd.Name, cmd.MaxBytes)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Data = content

	case "read-file":
		if cmd.Name == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "name and path are required for volume file read"
			return
		}
		content, err := ReadVolumeFile(ctx, p.client, cmd.Name, cmd.Path, cmd.MaxBytes)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Data = content

	case "write-file":
		if cmd.Name == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "name and path are required for volume file write"
			return
		}
		if err := WriteVolumeFile(ctx, p.client, cmd.Name, cmd.Path, cmd.Content); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "create-file":
		if cmd.Name == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "name and path are required for volume file create"
			return
		}
		if err := CreateVolumeFile(ctx, p.client, cmd.Name, cmd.Path, cmd.Content); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "upload-init":
		if cmd.Name == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "name, upload id, and target_path are required for volume upload init"
			return
		}
		if err := InitVolumeChunkedFileUpload(ctx, p.client, cmd.Name, cmd.Path, cmd.TargetPath, cmd.MaxBytes); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "upload-chunk":
		if cmd.Name == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "name, upload id, and target_path are required for volume upload chunk"
			return
		}
		if err := WriteVolumeChunkedFileUpload(ctx, p.client, cmd.Name, cmd.Path, cmd.TargetPath, cmd.MaxBytes, cmd.Content); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "upload-complete":
		if cmd.Name == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "name, upload id, and target_path are required for volume upload complete"
			return
		}
		if err := CompleteVolumeChunkedFileUpload(ctx, p.client, cmd.Name, cmd.Path, cmd.TargetPath, cmd.MaxBytes); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "upload-abort":
		if cmd.Name == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "name, upload id, and target_path are required for volume upload abort"
			return
		}
		if err := AbortVolumeChunkedFileUpload(ctx, p.client, cmd.Name, cmd.Path, cmd.TargetPath); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "create-dir":
		if cmd.Name == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "name and path are required for volume directory create"
			return
		}
		if err := CreateVolumeDirectory(ctx, p.client, cmd.Name, cmd.Path); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "delete":
		if cmd.Name == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "name and path are required for volume file delete"
			return
		}
		if err := DeleteVolumePath(ctx, p.client, cmd.Name, cmd.Path); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "move":
		if cmd.Name == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "name, path, and target_path are required for volume file move"
			return
		}
		if err := MoveVolumePath(ctx, p.client, cmd.Name, cmd.Path, cmd.TargetPath); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "create":
		if cmd.Name == "" {
			result.Success = false
			result.Error = "name is required for volume create"
			return
		}
		if err := p.client.CreateVolume(ctx, cmd.Name, "local", map[string]string{
			managedVolumeLabel:       "true",
			managedVolumeOriginLabel: "created",
		}); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "remove":
		if cmd.Name == "" {
			result.Success = false
			result.Error = "name is required for volume remove"
			return
		}
		if err := p.client.RemoveVolume(ctx, cmd.Name, cmd.Force); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "rename":
		if cmd.Name == "" || cmd.NewName == "" {
			result.Success = false
			result.Error = "name and new_name are required for volume rename"
			return
		}
		if err := p.client.RenameVolume(ctx, cmd.Name, cmd.NewName); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "update-labels":
		if cmd.Name == "" {
			result.Success = false
			result.Error = "name is required for volume label update"
			return
		}
		if err := p.client.UpdateVolumeLabels(ctx, cmd.Name, cmd.Labels); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	default:
		result.Success = false
		result.Error = fmt.Sprintf("unknown volume action: %s", cmd.Action)
	}
}

// handleNetworkCommand dispatches network actions.
func (p *DockerPlugin) handleNetworkCommand(cmd *pb.DockerNetworkCommand, result *pb.CommandResult) {
	ctx := context.Background()

	switch cmd.Action {
	case "list":
		data, err := p.client.ListNetworks(ctx)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Detail = string(data)

	case "create":
		if cmd.NetworkId == "" {
			result.Success = false
			result.Error = "network_id (name) is required for network create"
			return
		}
		id, err := p.client.CreateNetwork(ctx, cmd.NetworkId, cmd.Driver, cmd.Subnet, cmd.GatewayAddr)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, _ := json.Marshal(map[string]string{"id": id})
		result.Detail = string(data)

	case "remove":
		if cmd.NetworkId == "" {
			result.Success = false
			result.Error = "network_id is required for network remove"
			return
		}
		if err := p.client.RemoveNetwork(ctx, cmd.NetworkId); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "connect":
		if cmd.NetworkId == "" || cmd.ContainerId == "" {
			result.Success = false
			result.Error = "network_id and container_id are required for connect"
			return
		}
		if err := p.client.ConnectContainerToNetwork(ctx, cmd.NetworkId, cmd.ContainerId); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "disconnect":
		if cmd.NetworkId == "" || cmd.ContainerId == "" {
			result.Success = false
			result.Error = "network_id and container_id are required for disconnect"
			return
		}
		if err := p.client.DisconnectContainerFromNetwork(ctx, cmd.NetworkId, cmd.ContainerId); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	default:
		result.Success = false
		result.Error = fmt.Sprintf("unknown network action: %s", cmd.Action)
	}
}

// handleLogsCommand retrieves container logs and returns them as JSON.
// When follow is true, starts a background goroutine that streams log chunks.
func (p *DockerPlugin) handleLogsCommand(cmd *pb.DockerLogsCommand, result *pb.CommandResult) {
	ctx := context.Background()
	if p.sessionCtx != nil {
		ctx = p.sessionCtx
	}

	tail := int(cmd.TailLines)
	if tail <= 0 && !cmd.Follow {
		tail = 100
	}

	// If follow mode and we have a writer, start streaming
	if cmd.Follow && p.writer != nil {
		// Cancel any existing stream for this container
		p.logStreamMu.Lock()
		if cancel, ok := p.logStreamCancel[cmd.ContainerId]; ok {
			cancel()
			delete(p.logStreamCancel, cmd.ContainerId)
		}
		p.logStreamMu.Unlock()

		streamCtx, streamCancel := context.WithCancel(ctx)

		reader, err := p.client.ContainerLogsFollow(streamCtx, cmd.ContainerId, tail, cmd.Timestamps, cmd.Since)
		if err != nil {
			streamCancel()
			result.Success = false
			result.Error = err.Error()
			return
		}

		// Track the cancel function for cleanup
		p.logStreamMu.Lock()
		p.logStreamCancel[cmd.ContainerId] = streamCancel
		p.logStreamMu.Unlock()

		// Start streaming goroutine
		go p.streamLogs(streamCtx, streamCancel, cmd.ContainerId, reader)

		// Return immediately acknowledging the stream started
		data, _ := json.Marshal(map[string]bool{"streaming": true})
		result.Detail = string(data)
		return
	}

	// Non-follow mode: fetch logs once
	readCtx, cancel := context.WithTimeout(ctx, dockerLogsCommandTimeout)
	defer cancel()
	lines, err := p.client.ContainerLogs(readCtx, cmd.ContainerId, tail, cmd.Timestamps, cmd.Since, cmd.Until)
	if err != nil {
		result.Success = false
		result.Error = err.Error()
		return
	}

	data, err := json.Marshal(lines)
	if err != nil {
		result.Success = false
		result.Error = fmt.Sprintf("marshal logs: %v", err)
		return
	}
	result.Detail = string(data)
}

// streamLogs reads from a Docker log follow stream and sends chunks back
// via the gRPC stream writer as CommandResult messages.
func (p *DockerPlugin) streamLogs(ctx context.Context, cancel context.CancelFunc, containerID string, reader io.ReadCloser) {
	defer func() {
		reader.Close()
		cancel()
		p.logStreamMu.Lock()
		delete(p.logStreamCancel, containerID)
		p.logStreamMu.Unlock()
		p.logger.Info("log stream ended", "container", containerID)
	}()

	header := make([]byte, 8)
	buf := make([]byte, 0, 16384)

	for {
		select {
		case <-ctx.Done():
			return
		default:
		}

		// Read Docker multiplexed log header (8 bytes)
		_, err := io.ReadFull(reader, header)
		if err != nil {
			// Stream ended (container stopped, context cancelled, etc.)
			// Send end-of-stream notification
			if p.writer != nil {
				endMsg, _ := json.Marshal(map[string]interface{}{
					"type":        "log_stream",
					"containerId": containerID,
					"lines":       []string{},
					"ended":       true,
				})
				p.writer.Send(&pb.DaemonMessage{
					Payload: &pb.DaemonMessage_CommandResult{
						CommandResult: &pb.CommandResult{
							CommandId: "log_stream:" + containerID,
							Success:   true,
							Detail:    string(endMsg),
						},
					},
				})
			}
			return
		}

		size := binary.BigEndian.Uint32(header[4:8])
		if size == 0 {
			continue
		}
		if size > maxDockerLogLineBytes {
			p.logger.Warn("log stream frame exceeds safety limit", "container", containerID, "bytes", size)
			return
		}

		// Read the payload
		if cap(buf) < int(size) {
			buf = make([]byte, size)
		} else {
			buf = buf[:size]
		}
		_, err = io.ReadFull(reader, buf)
		if err != nil {
			return
		}

		// Parse payload into lines
		var lines []string
		scanner := bufio.NewScanner(strings.NewReader(string(buf)))
		scanner.Buffer(make([]byte, 0, 64*1024), maxDockerLogLineBytes)
		for scanner.Scan() {
			line := scanner.Text()
			if line != "" {
				lines = append(lines, line)
			}
		}
		if err := scanner.Err(); err != nil {
			p.logger.Warn("log stream scanner failed", "container", containerID, "error", err)
			return
		}

		if len(lines) == 0 {
			continue
		}

		// Send lines as a CommandResult with log_stream type
		streamMsg, _ := json.Marshal(map[string]interface{}{
			"type":        "log_stream",
			"containerId": containerID,
			"lines":       lines,
		})

		if p.writer != nil {
			if err := p.writer.Send(&pb.DaemonMessage{
				Payload: &pb.DaemonMessage_CommandResult{
					CommandResult: &pb.CommandResult{
						CommandId: "log_stream:" + containerID,
						Success:   true,
						Detail:    string(streamMsg),
					},
				},
			}); err != nil {
				p.logger.Debug("log stream send failed", "container", containerID, "error", err)
				return
			}
		}
	}
}

// stopLogStream cancels a running log stream for the given container.
func (p *DockerPlugin) stopLogStream(containerID string) {
	p.logStreamMu.Lock()
	if cancel, ok := p.logStreamCancel[containerID]; ok {
		cancel()
		delete(p.logStreamCancel, containerID)
	}
	p.logStreamMu.Unlock()
}

// handleConfigPush processes a config push from the gateway, updating the
// allowlist and storing registry credentials.
func (p *DockerPlugin) handleConfigPush(cmd *pb.DockerConfigPushCommand, result *pb.CommandResult) {
	// Update allowlist if provided
	if len(cmd.Allowlist) > 0 {
		p.allowlist.Update(cmd.Allowlist)
		p.logger.Info("allowlist updated", "count", len(cmd.Allowlist))
	}

	// Store registry credentials
	if len(cmd.Registries) > 0 {
		p.registryMu.Lock()
		for _, reg := range cmd.Registries {
			if reg.Username == "" && reg.Password == "" {
				delete(p.registryCreds, reg.Url)
			} else {
				// Encode as base64 JSON (Docker registry auth format)
				authJSON, _ := json.Marshal(map[string]string{
					"username":      reg.Username,
					"password":      reg.Password,
					"serveraddress": reg.Url,
				})
				p.registryCreds[reg.Url] = encodeBase64(authJSON)
			}
		}
		p.registryMu.Unlock()
		p.logger.Info("registry credentials updated", "count", len(cmd.Registries))
	}
}

// handleExecCommand dispatches exec session actions (create, resize, detach).
func (p *DockerPlugin) handleExecCommand(cmd *pb.DockerExecCommand, result *pb.CommandResult) {
	ctx := context.Background()

	switch cmd.Action {
	case "run":
		if cmd.ContainerId == "" {
			result.Success = false
			result.Error = "container_id is required for exec run"
			return
		}
		if len(cmd.Command) == 0 {
			result.Success = false
			result.Error = "command is required for exec run"
			return
		}
		runCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		stdout, err := execInContainerBytesAsUser(runCtx, p.client, cmd.ContainerId, cmd.Command, cmd.User, 128*1024)
		if err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("exec run: %v", err)
			return
		}
		resp := map[string]interface{}{
			"stdout":   string(stdout),
			"exitCode": 0,
		}
		data, _ := json.Marshal(resp)
		result.Detail = string(data)

	case "create":
		if p.execMgr == nil {
			result.Success = false
			result.Error = "exec manager not initialized (no active session)"
			return
		}
		if cmd.ContainerId == "" {
			result.Success = false
			result.Error = "container_id is required for exec create"
			return
		}
		execID, isNew, err := p.execMgr.CreateOrReuse(
			ctx,
			cmd.ContainerId,
			cmd.SessionKey,
			cmd.Command,
			cmd.Tty,
			int(cmd.Rows),
			int(cmd.Cols),
			cmd.User,
		)
		if err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("exec create: %v", err)
			return
		}

		resp := map[string]interface{}{
			"exec_id": execID,
			"is_new":  isNew,
			"buffer":  p.execMgr.GetBuffer(cmd.ContainerId, cmd.SessionKey),
		}
		data, _ := json.Marshal(resp)
		result.Detail = string(data)

	case "resize":
		if p.execMgr == nil {
			result.Success = false
			result.Error = "exec manager not initialized (no active session)"
			return
		}
		if cmd.ContainerId == "" {
			result.Success = false
			result.Error = "container_id (exec_id) is required for resize"
			return
		}
		if err := p.execMgr.HandleResize(ctx, cmd.ContainerId, int(cmd.Rows), int(cmd.Cols)); err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("exec resize: %v", err)
			return
		}

	default:
		result.Success = false
		result.Error = fmt.Sprintf("unknown exec action: %s", cmd.Action)
	}
}

// handleExecInput routes stdin data to the appropriate exec session.
func (p *DockerPlugin) handleExecInput(input *pb.ExecInput) {
	if p.execMgr == nil || input == nil {
		return
	}
	p.execMgr.HandleInput(input.ExecId, input.Data)
}

// handleFileCommand dispatches file browser actions (list, read).
func (p *DockerPlugin) handleFileCommand(cmd *pb.DockerFileCommand, result *pb.CommandResult) {
	ctx := context.Background()

	switch cmd.Action {
	case "list":
		if cmd.ContainerId == "" {
			result.Success = false
			result.Error = "container_id is required"
			return
		}
		path := cmd.Path
		if path == "" {
			path = "/"
		}
		entries, err := ListDir(ctx, p.client, cmd.ContainerId, path)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		data, err := json.Marshal(entries)
		if err != nil {
			result.Success = false
			result.Error = fmt.Sprintf("marshal entries: %v", err)
			return
		}
		result.Detail = string(data)

	case "read":
		if cmd.ContainerId == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "container_id and path are required"
			return
		}
		content, err := ReadFile(ctx, p.client, cmd.ContainerId, cmd.Path, cmd.MaxBytes)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}
		result.Data = content

	case "write":
		if cmd.ContainerId == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "container_id and path are required"
			return
		}
		if err := WriteFile(ctx, p.client, cmd.ContainerId, cmd.Path, cmd.Content); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "create-file":
		if cmd.ContainerId == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "container_id and path are required"
			return
		}
		if err := CreateFile(ctx, p.client, cmd.ContainerId, cmd.Path, cmd.Content); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "upload-init":
		if cmd.ContainerId == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "container_id, upload id, and target_path are required"
			return
		}
		if err := InitChunkedFileUpload(ctx, p.client, cmd.ContainerId, cmd.Path, cmd.TargetPath, cmd.MaxBytes); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "upload-chunk":
		if cmd.ContainerId == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "container_id, upload id, and target_path are required"
			return
		}
		if err := WriteChunkedFileUpload(ctx, p.client, cmd.ContainerId, cmd.Path, cmd.TargetPath, cmd.MaxBytes, cmd.Content); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "upload-complete":
		if cmd.ContainerId == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "container_id, upload id, and target_path are required"
			return
		}
		if err := CompleteChunkedFileUpload(ctx, p.client, cmd.ContainerId, cmd.Path, cmd.TargetPath, cmd.MaxBytes); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "upload-abort":
		if cmd.ContainerId == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "container_id, upload id, and target_path are required"
			return
		}
		if err := AbortChunkedFileUpload(ctx, p.client, cmd.ContainerId, cmd.Path, cmd.TargetPath); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "create-dir":
		if cmd.ContainerId == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "container_id and path are required"
			return
		}
		if err := CreateDirectory(ctx, p.client, cmd.ContainerId, cmd.Path); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "delete":
		if cmd.ContainerId == "" || cmd.Path == "" {
			result.Success = false
			result.Error = "container_id and path are required"
			return
		}
		if err := DeletePath(ctx, p.client, cmd.ContainerId, cmd.Path); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	case "move":
		if cmd.ContainerId == "" || cmd.Path == "" || cmd.TargetPath == "" {
			result.Success = false
			result.Error = "container_id, path, and target_path are required"
			return
		}
		if err := MovePath(ctx, p.client, cmd.ContainerId, cmd.Path, cmd.TargetPath); err != nil {
			result.Success = false
			result.Error = err.Error()
			return
		}

	default:
		result.Success = false
		result.Error = fmt.Sprintf("unknown file action: %s", cmd.Action)
	}
}

// encodeBase64 encodes bytes as standard base64.
func encodeBase64(data []byte) string {
	return base64.URLEncoding.EncodeToString(data)
}

// CollectHealth enriches the base health report with Docker-specific metrics.
func (p *DockerPlugin) CollectHealth(base *pb.HealthReport) *pb.HealthReport {
	base.DockerVersion = p.version

	ctx := context.Background()
	running, stopped, total, err := p.client.CountContainers(ctx)
	if err != nil {
		p.logger.Warn("failed to count containers for health", "error", err)
		return base
	}

	base.ContainersRunning = int32(running)
	base.ContainersStopped = int32(stopped)
	base.ContainersTotal = int32(total)

	// Include per-container resource stats if available
	if p.statsCollector != nil {
		base.ContainerStats = p.statsCollector.GetStats()
	}
	// GPU inventory is daemon-authoritative. The Docker client adds runtime
	// readiness (notably NVIDIA Container Toolkit) before it reaches Gateway.
	base.GpuDevices = make([]*pb.GpuDevice, 0)
	for _, device := range p.client.GPUDevices(ctx) {
		base.GpuDevices = append(base.GpuDevices, device.ToProto())
	}

	return base
}

// CollectStats returns nil; the docker daemon does not collect time-series stats
// in this foundational implementation.
func (p *DockerPlugin) CollectStats() *pb.StatsReport {
	return nil
}

// OnSessionStart is called when a new gRPC session is established.
func (p *DockerPlugin) OnSessionStart(ctx context.Context, writer *stream.Writer) error {
	// Start stats collector goroutine
	p.statsCollector = NewStatsCollector(p.client, p.allowlist, p.logger)
	go p.statsCollector.Run(ctx)
	go p.runMigrationArtifactCleanup(ctx)

	// Create exec manager with stream writer for async output
	p.execMgr = NewExecManager(p.client, writer, p.logger)

	// Store writer and initialize log stream tracking
	p.writer = writer
	p.sessionCtx = ctx
	p.logStreamCancel = make(map[string]context.CancelFunc)

	return nil
}

// OnSessionEnd is called when a gRPC session ends.
func (p *DockerPlugin) OnSessionEnd() {
	// Exec sessions are cleaned up individually when their WebSocket closes.
	// Don't CloseAll here — it would kill other users' active sessions.
	p.execMgr = nil
	p.statsCollector = nil

	// Cancel all active log streams
	p.logStreamMu.Lock()
	for containerID, cancel := range p.logStreamCancel {
		cancel()
		delete(p.logStreamCancel, containerID)
	}
	p.logStreamMu.Unlock()
	p.writer = nil
	p.sessionCtx = nil
}
