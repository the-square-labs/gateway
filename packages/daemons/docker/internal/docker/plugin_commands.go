package docker

import (
	"context"
	"encoding/json"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/stream"
	runtimemanager "github.com/wiolett-industries/gateway/docker-daemon/internal/runtime"
	"time"
)

func (p *DockerPlugin) HandleCommand(cmd *pb.GatewayCommand) *pb.CommandResult {
	result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
	if p.cfg.Docker.Mode == "builder" {
		switch payload := cmd.Payload.(type) {
		case *pb.GatewayCommand_DockerBuild:
			if p.builderManager == nil {
				result.Success = false
				result.Error = "builder execution is not initialized"
			} else if err := p.builderManager.Start(payload.DockerBuild); err != nil {
				result.Success = false
				result.Error = err.Error()
			}
		case *pb.GatewayCommand_DockerBuildCancel:
			if p.builderManager == nil || !p.builderManager.Cancel(payload.DockerBuildCancel.GetBuildId()) {
				result.Success = false
				result.Error = "build is not running"
			}
		case *pb.GatewayCommand_SyncDockerRegistryBindings:
			detail, err := p.SyncDockerRegistryBindings(payload.SyncDockerRegistryBindings)
			if err != nil {
				result.Success = false
				result.Error = err.Error()
			} else {
				result.Detail = detail
			}
		case *pb.GatewayCommand_SetDaemonLogStream:
			stream.SetDaemonLogStreaming(payload.SetDaemonLogStream.Enabled, payload.SetDaemonLogStream.MinLevel)
		default:
			result.Success = false
			result.Error = "builder-profile daemon accepts only docker_build, docker_build_cancel, and registry binding commands"
		}
		return result
	}
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

	case *pb.GatewayCommand_DockerCompose:
		p.handleComposeCommand(payload.DockerCompose, result)

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

	case *pb.GatewayCommand_SyncDockerRegistryBindings:
		detail, err := p.SyncDockerRegistryBindings(payload.SyncDockerRegistryBindings)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
		} else {
			result.Detail = detail
		}

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

func (p *DockerPlugin) emitBuildEvent(event *pb.DockerBuildEvent) {
	if event == nil || p.writer == nil {
		return
	}
	if err := p.writer.Send(&pb.DaemonMessage{Payload: &pb.DaemonMessage_DockerBuildEvent{DockerBuildEvent: event}}); err != nil && p.logger != nil {
		p.logger.Warn("failed to report Docker build event", "build_id", event.GetBuildId(), "error", err)
	}
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
