package docker

import (
	"encoding/json"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

// handleBackupCommand is wired by the parent-owned plugin command switch once DockerBackupCommand is generated.
func (p *DockerPlugin) handleBackupCommand(cmd *pb.DockerBackupCommand, result *pb.CommandResult) {
	runtime, err := backupRuntimeFor(p)
	if err != nil {
		result.Success = false
		result.Error = sanitizeBackupError(err.Error())
		return
	}
	status, err := runtime.apply(cmd.GetAction(), cmd.GetRunId(), cmd.GetConfigJson())
	if err != nil {
		result.Success = false
		result.Error = sanitizeBackupError(err.Error())
		return
	}
	detail, err := json.Marshal(status)
	if err != nil {
		result.Success = false
		result.Error = "encode backup status"
		return
	}
	result.Detail = string(detail)
}
