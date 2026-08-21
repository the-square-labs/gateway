package supervisor

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/daemon-shared/stream"
	"github.com/wiolett-industries/gateway/daemon-shared/sysmetrics"
	"github.com/wiolett-industries/gateway/relay-supervisor/internal/config"
)

const relayPoolCapability = "relay_pool_v1"

type Plugin struct {
	cfg     *config.Config
	logger  *slog.Logger
	worker  *workerManager
	mu      sync.RWMutex
	last    *pb.RelayRuntimeStatus
	started bool
}

func New(cfg *config.Config) *Plugin {
	return &Plugin{cfg: cfg, worker: newWorkerManager(cfg.Worker, cfg.StateDir)}
}

func (p *Plugin) Type() string { return "relay" }

func (p *Plugin) SetLogger(logger *slog.Logger) { p.logger = logger }

func (p *Plugin) Init(_ *lifecycle.BaseConfig, logger *slog.Logger) error {
	p.logger = logger
	return nil
}

func (p *Plugin) PersistEnrollmentBundle(response *pb.EnrollResponse) error {
	return persistEnrollmentBundle(p.cfg.StateDir, p.cfg.Worker.IdentityDir, response)
}

func (p *Plugin) BuildRegisterMessage(nodeID string) *pb.RegisterMessage {
	hostname, _ := os.Hostname()
	cpuModel, cpuCores := sysmetrics.GetCPUInfo()
	state, _ := loadEnrollmentState(p.cfg.StateDir)
	register := &pb.RegisterMessage{
		NodeId: nodeID, Hostname: hostname, DaemonVersion: lifecycle.Version,
		CpuModel: cpuModel, CpuCores: int32(cpuCores), Architecture: sysmetrics.GetArchitecture(),
		KernelVersion: sysmetrics.GetKernelVersion(), DaemonType: "relay", Capabilities: []string{relayPoolCapability},
	}
	if state != nil {
		register.HostIdentityId = state.HostIdentityID
		register.RelayInstanceId = state.InstanceID
	}
	return register
}

func (p *Plugin) HandleCommand(command *pb.GatewayCommand) *pb.CommandResult {
	result := &pb.CommandResult{CommandId: command.GetCommandId(), Success: true}
	var err error
	switch payload := command.GetPayload().(type) {
	case *pb.GatewayCommand_SyncRelayPolicy:
		var responseRevision uint64
		var responseUnchanged bool
		var responseExpiry int64
		var responsePool, responseInstance string
		applied, applyErr := p.worker.applyPolicy(context.Background(), payload.SyncRelayPolicy.GetApplySnapshotRequest())
		if applyErr == nil {
			responseRevision = applied.GetAppliedRevision()
			responseUnchanged = applied.GetUnchanged()
			responseExpiry = applied.GetPolicyExpiresAtUnix()
			responsePool = applied.GetPoolId()
			responseInstance = applied.GetRelayInstanceId()
			result.Detail = fmt.Sprintf("revision=%d unchanged=%t expires_at=%d pool=%s instance=%s", responseRevision, responseUnchanged, responseExpiry, responsePool, responseInstance)
		}
		err = applyErr
	case *pb.GatewayCommand_SetRelayDrain:
		err = p.worker.setDrain(
			context.Background(),
			payload.SetRelayDrain.GetEnabled(),
			payload.SetRelayDrain.GetForceDisconnect(),
		)
		if err == nil {
			result.Detail = fmt.Sprintf(
				"draining=%t force_disconnect=%t",
				payload.SetRelayDrain.GetEnabled(),
				payload.SetRelayDrain.GetForceDisconnect(),
			)
		}
	case *pb.GatewayCommand_UpdateRelayWorker:
		update := payload.UpdateRelayWorker
		err = p.worker.update(
			context.Background(),
			update.GetDownloadUrl(),
			update.GetTargetVersion(),
			update.GetChecksum(),
			update.GetSignedManifest(),
			p.logger,
		)
		if err == nil {
			result.Detail = fmt.Sprintf("relay worker updated to %s", update.GetTargetVersion())
		}
	case *pb.GatewayCommand_CommitRelaySupervisorUpdate:
		targetVersion := payload.CommitRelaySupervisorUpdate.GetTargetVersion()
		if targetVersion != lifecycle.Version {
			err = fmt.Errorf("supervisor version %s does not match commit target %s", lifecycle.Version, targetVersion)
			break
		}
		executable, executableErr := os.Executable()
		if executableErr != nil {
			err = executableErr
			break
		}
		executable, executableErr = filepath.EvalSymlinks(executable)
		if executableErr != nil {
			err = executableErr
			break
		}
		if marker, readErr := os.ReadFile(executable + ".update-pending"); readErr != nil {
			err = fmt.Errorf("read supervisor update marker: %w", readErr)
		} else if strings.TrimSpace(string(marker)) != targetVersion {
			err = fmt.Errorf("supervisor update marker does not match target version")
		} else if removeErr := os.Remove(executable + ".update-pending"); removeErr != nil {
			err = removeErr
		} else {
			_ = os.Remove(executable + ".previous")
			result.Detail = fmt.Sprintf("relay supervisor update %s committed", targetVersion)
		}
	case *pb.GatewayCommand_SetDaemonLogStream:
		stream.SetDaemonLogStreaming(payload.SetDaemonLogStream.Enabled, payload.SetDaemonLogStream.MinLevel)
	default:
		result.Success = false
		result.Error = "unsupported command for relay supervisor"
		return result
	}
	if err != nil {
		result.Success = false
		result.Error = err.Error()
	}
	return result
}

func (p *Plugin) CollectHealth(base *pb.HealthReport) *pb.HealthReport {
	p.mu.RLock()
	last := p.last
	p.mu.RUnlock()
	if last != nil {
		base.ConfigValid = last.GetState() == "ready" || last.GetState() == "draining" || last.GetState() == "synchronizing"
		base.NginxRunning = last.GetState() != "offline" && last.GetState() != "error"
	}
	return base
}

func (p *Plugin) CollectStats() *pb.StatsReport { return nil }

func (p *Plugin) OnSessionStart(ctx context.Context, writer *stream.Writer) error {
	p.mu.Lock()
	p.started = true
	p.mu.Unlock()
	go p.reportLoop(ctx, writer)
	return nil
}

func (p *Plugin) OnSessionEnd() {
	p.mu.Lock()
	p.started = false
	p.mu.Unlock()
}

func (p *Plugin) Shutdown() { p.worker.shutdown() }

func (p *Plugin) reportLoop(ctx context.Context, writer *stream.Writer) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		status := p.collectRuntime(ctx)
		p.mu.Lock()
		p.last = status
		p.mu.Unlock()
		if err := writer.Send(&pb.DaemonMessage{Payload: &pb.DaemonMessage_RelayRuntimeStatus{RelayRuntimeStatus: status}}); err != nil {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

func (p *Plugin) collectRuntime(ctx context.Context) *pb.RelayRuntimeStatus {
	state, _ := loadEnrollmentState(p.cfg.StateDir)
	status := &pb.RelayRuntimeStatus{
		State: "joining", Capabilities: []string{relayPoolCapability},
		AdvertisedAddresses: append([]string(nil), p.cfg.Worker.AdvertisedAddresses...), ServicePort: uint32(p.cfg.Worker.ServicePort),
	}
	if state != nil {
		status.RelayInstanceId = state.InstanceID
	}
	if err := p.worker.ensureRunning(); err != nil {
		status.State = "error"
		status.Error = err.Error()
		return status
	}
	if err := p.worker.bootstrapTrust(ctx); err != nil {
		status.State = "synchronizing"
		status.Error = err.Error()
		return status
	}
	health, err := p.worker.health(ctx)
	if err != nil {
		status.State = "offline"
		status.Error = err.Error()
		return status
	}
	status.BuildVersion = health.GetBuildVersion()
	status.ProtocolMajor = health.GetProtocolMajor()
	status.Capabilities = append([]string(nil), health.GetCapabilities()...)
	status.AppliedPolicyRevision = health.GetAppliedRevision()
	status.PolicyExpiresAtUnix = health.GetPolicyExpiresAtUnix()
	status.RegisteredEndpoints = health.GetRegisteredEndpoints()
	status.ActiveTunnels = health.GetActiveTunnels()
	status.PressurePercent = uint32(max(0, health.GetPressurePercent()))
	status.Draining = health.GetDraining()
	status.PolicySigningKeyIds = append([]string(nil), health.GetPolicyKeyIds()...)
	status.AssignmentTunnels = make([]*pb.RelayAssignmentTunnelCount, 0, len(health.GetAssignmentTunnels()))
	for _, count := range health.GetAssignmentTunnels() {
		status.AssignmentTunnels = append(status.AssignmentTunnels, &pb.RelayAssignmentTunnelCount{
			EndpointId: count.GetEndpointId(), AssignmentGeneration: count.GetAssignmentGeneration(), ActiveTunnels: count.GetActiveTunnels(),
		})
	}
	status.Error = health.GetReason()
	switch {
	case health.GetDraining():
		status.State = "draining"
	case health.GetReadiness():
		status.State = "ready"
	default:
		status.State = "synchronizing"
	}
	return status
}
