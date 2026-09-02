package docker

import (
	"context"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/stream"
)

func (p *DockerPlugin) CollectHealth(base *pb.HealthReport) *pb.HealthReport {
	if p.cfg.Docker.Mode == "builder" {
		return base
	}
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
	p.writer = writer
	p.buildEventMu.Lock()
	p.buildEventWriter = writer
	p.buildEventMu.Unlock()
	p.sessionCtx = ctx
	p.logStreamCancel = make(map[string]context.CancelFunc)
	if p.cfg.Docker.Mode == "builder" {
		return nil
	}
	// Start stats collector goroutine
	p.statsCollector = NewStatsCollector(p.client, p.allowlist, p.logger)
	go p.statsCollector.Run(ctx)
	go p.runMigrationArtifactCleanup(ctx)

	// Create exec manager with stream writer for async output
	p.execMgr = NewExecManager(p.client, writer, p.logger)

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
	if p.composeExecutor != nil {
		p.composeExecutor.cancelAll()
	}
	p.buildEventMu.Lock()
	p.buildEventWriter = nil
	p.buildEventMu.Unlock()
	p.writer = nil
	p.sessionCtx = nil
}
