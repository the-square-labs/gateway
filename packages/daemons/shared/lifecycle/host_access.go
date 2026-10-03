package lifecycle

import (
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

// Host access switches live only in the daemon config file on the node, so
// the Gateway cannot turn a disabled feature back on remotely. The daemon
// advertises a disabled feature at registration so the Gateway refuses it
// before dispatching a command.
const (
	NodeConsoleDisabledCapability = "node_console_disabled_v1"
	NodeFilesDisabledCapability   = "node_files_disabled_v1"

	nodeConsoleDisabledError = "console is disabled in this node's daemon configuration (set console.enabled: true in the daemon config file and restart the daemon to enable it)"
	nodeFilesDisabledError   = "file access is disabled in this node's daemon configuration (set files.enabled: true in the daemon config file and restart the daemon to enable it)"
)

// IsEnabled reports whether the host console is enabled (default true).
func (c ConsoleConfig) IsEnabled() bool {
	return c.Enabled == nil || *c.Enabled
}

// IsEnabled reports whether host file access is enabled (default true).
func (c FilesConfig) IsEnabled() bool {
	return c.Enabled == nil || *c.Enabled
}

// hostAccessCapabilities lists the registration markers for the host access
// features this config disables.
func (c *BaseConfig) hostAccessCapabilities() []string {
	var values []string
	if !c.Console.IsEnabled() {
		values = append(values, NodeConsoleDisabledCapability)
	}
	if !c.Files.IsEnabled() {
		values = append(values, NodeFilesDisabledCapability)
	}
	return values
}

// refuseDisabledNodeExec returns the refusal for a node console command when
// the console is disabled, or nil when the command may run. Every node exec
// action (create, resize, run) is refused.
func refuseDisabledNodeExec(cfg *BaseConfig, cmd *pb.GatewayCommand) *pb.CommandResult {
	if cfg.Console.IsEnabled() {
		return nil
	}
	return &pb.CommandResult{CommandId: cmd.CommandId, Success: false, Error: nodeConsoleDisabledError}
}

// refuseDisabledNodeFile returns the refusal for a node file command when
// file access is disabled, or nil when the command may run. The fixed
// ensure-host-identity operation is not host file access (callers choose no
// path) and stays available.
func refuseDisabledNodeFile(cfg *BaseConfig, cmd *pb.GatewayCommand) *pb.CommandResult {
	if cfg.Files.IsEnabled() || cmd.GetNodeFile().GetAction() == "ensure-host-identity" {
		return nil
	}
	return &pb.CommandResult{CommandId: cmd.CommandId, Success: false, Error: nodeFilesDisabledError}
}
