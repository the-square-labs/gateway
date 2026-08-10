package lifecycle

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/connector"
	"github.com/wiolett-industries/gateway/daemon-shared/exec"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/stream"
	"github.com/wiolett-industries/gateway/daemon-shared/sysmetrics"
	"google.golang.org/grpc"
)

const maxAsyncCommandHandlers = 4

// runSession connects to the gateway, registers, and runs the command loop.
func runSession(ctx context.Context, conn *grpc.ClientConn, d *DaemonBase) error {
	// Enable log streaming by default — backend can disable via SetDaemonLogStream command
	stream.SetDaemonLogStreaming(true, "info")

	cmdStream, err := connector.OpenCommandStream(ctx, conn)
	if err != nil {
		return err
	}

	// Wrap stream for thread-safe Send calls
	writer := stream.NewWriter(cmdStream)

	// Send registration message
	regMsg := d.plugin.BuildRegisterMessage(d.state.NodeID)
	if err := writer.Send(&pb.DaemonMessage{
		Payload: &pb.DaemonMessage_Register{Register: regMsg},
	}); err != nil {
		return err
	}

	d.logger.Info("connected to gateway", "node_id", d.state.NodeID)

	// Install gRPC log forwarder so daemon logs are streamed to the gateway
	sessionLogger := slog.New(stream.NewGrpcLogHandlerWithWriter(writer, d.baseHandler))
	d.logger = sessionLogger
	// Update plugin's logger so its logs also forward to gRPC
	d.plugin.SetLogger(sessionLogger)

	// Notify plugin of session start
	sessionCtx, sessionCancel := context.WithCancel(ctx)
	defer sessionCancel()

	// Create shared node-level exec manager for host console
	nodeExecMgr := exec.NewManager(d.logger, writer)
	defer nodeExecMgr.CloseAll()

	if err := d.plugin.OnSessionStart(sessionCtx, writer); err != nil {
		d.logger.Warn("plugin session start failed", "error", err)
	}
	defer d.plugin.OnSessionEnd()

	if logStreamer, ok := d.plugin.(LogStreamPlugin); ok {
		go logStreamer.RunLogStream(sessionCtx, conn)
	}
	if migrationStreamer, ok := d.plugin.(MigrationStreamPlugin); ok {
		go migrationStreamer.RunMigrationStream(sessionCtx, conn, d.state.NodeID)
	}
	asyncCommandSlots := make(chan struct{}, maxAsyncCommandHandlers)
	sendAsyncCommandResult := func(c *pb.GatewayCommand, handle func(*pb.GatewayCommand) *pb.CommandResult) {
		select {
		case asyncCommandSlots <- struct{}{}:
		default:
			go func() {
				result := &pb.CommandResult{
					CommandId: c.CommandId,
					Success:   false,
					Error:     "daemon is busy handling long-running commands; retry shortly",
				}
				if err := writer.Send(&pb.DaemonMessage{
					Payload: &pb.DaemonMessage_CommandResult{CommandResult: result},
				}); err != nil {
					d.logger.Warn("failed to send async command overload result", "command_id", c.CommandId, "error", err)
					sessionCancel()
					_ = cmdStream.CloseSend()
				}
			}()
			return
		}

		go func() {
			defer func() { <-asyncCommandSlots }()

			result := handle(c)
			if err := writer.Send(&pb.DaemonMessage{
				Payload: &pb.DaemonMessage_CommandResult{CommandResult: result},
			}); err != nil {
				d.logger.Warn("failed to send async command result", "command_id", c.CommandId, "error", err)
				sessionCancel()
				_ = cmdStream.CloseSend()
			}
		}()
	}

	// Start health reporter in background
	go runHealthReporter(sessionCtx, d, writer)

	// Main command loop
	for {
		cmd, err := cmdStream.Recv()
		if err == io.EOF {
			return err
		}
		if err != nil {
			return err
		}

		// Check for registration rejection (fatal — daemon must exit)
		if cmd.CommandId == "__registration_rejected__" {
			if ac, ok := cmd.Payload.(*pb.GatewayCommand_ApplyConfig); ok && ac.ApplyConfig != nil {
				return &FatalError{Message: ac.ApplyConfig.ConfigContent}
			}
			return &FatalError{Message: "registration rejected by gateway"}
		}

		// Handle RequestHealth and RequestStats inline
		switch cmd.Payload.(type) {
		case *pb.GatewayCommand_RequestHealth:
			report := collectFullHealth(d)
			writer.Send(&pb.DaemonMessage{
				Payload: &pb.DaemonMessage_HealthReport{HealthReport: report},
			})
			continue
		case *pb.GatewayCommand_RequestStats:
			report := d.plugin.CollectStats()
			if report != nil {
				writer.Send(&pb.DaemonMessage{
					Payload: &pb.DaemonMessage_StatsReport{StatsReport: report},
				})
			}
			continue
		case *pb.GatewayCommand_ExecInput:
			// Fire-and-forget: try shared node exec manager first, then fall through to plugin
			if input := cmd.GetExecInput(); input != nil && nodeExecMgr.HasSession(input.ExecId) {
				nodeExecMgr.HandleInput(input.ExecId, input.Data)
			} else {
				d.plugin.HandleCommand(cmd)
			}
			continue
		case *pb.GatewayCommand_NodeExec:
			// Handle node-level console exec (create/resize)
			sendAsyncCommandResult(cmd, func(c *pb.GatewayCommand) *pb.CommandResult {
				return handleNodeExec(sessionCtx, nodeExecMgr, c, d.cfg.Console.User)
			})
			continue
		case *pb.GatewayCommand_NodeFile:
			// Handle node-level filesystem operations in shared lifecycle so all daemon types support them.
			sendAsyncCommandResult(cmd, func(c *pb.GatewayCommand) *pb.CommandResult {
				return handleNodeFile(sessionCtx, c)
			})
			continue
		case *pb.GatewayCommand_DockerImage,
			*pb.GatewayCommand_DockerLogs,
			*pb.GatewayCommand_DockerDeployment,
			*pb.GatewayCommand_DockerVolume,
			*pb.GatewayCommand_DockerFile,
			*pb.GatewayCommand_DockerExec,
			*pb.GatewayCommand_DockerMigration,
			*pb.GatewayCommand_DockerDatabase:
			// Long-running Docker I/O must not block the command receive loop.
			sendAsyncCommandResult(cmd, d.plugin.HandleCommand)
			continue
		case *pb.GatewayCommand_SyncRelayGrants:
			result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
			relayPlugin, ok := d.plugin.(RelayTunnelPlugin)
			if !ok {
				result.Success = false
				result.Error = "daemon does not support relay grants"
			} else if detail, err := relayPlugin.SyncRelayGrants(cmd.GetSyncRelayGrants()); err != nil {
				result.Success = false
				result.Error = err.Error()
			} else {
				result.Detail = detail
			}
			if err := writer.Send(&pb.DaemonMessage{Payload: &pb.DaemonMessage_CommandResult{CommandResult: result}}); err != nil {
				return err
			}
			continue
		case *pb.GatewayCommand_SyncProxySecureLinks:
			result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
			secureLinkPlugin, ok := d.plugin.(ProxySecureLinkPlugin)
			if !ok {
				result.Success = false
				result.Error = "daemon does not support proxy secure links"
			} else if detail, err := secureLinkPlugin.SyncProxySecureLinks(cmd.GetSyncProxySecureLinks()); err != nil {
				result.Success = false
				result.Error = err.Error()
			} else {
				result.Detail = detail
			}
			if err := writer.Send(&pb.DaemonMessage{Payload: &pb.DaemonMessage_CommandResult{CommandResult: result}}); err != nil {
				return err
			}
			continue
		case *pb.GatewayCommand_ProbeProxySecureLink:
			result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
			secureLinkPlugin, ok := d.plugin.(ProxySecureLinkProbePlugin)
			if !ok {
				result.Success = false
				result.Error = "daemon does not support proxy secure-link probes"
			} else if detail, err := secureLinkPlugin.ProbeProxySecureLink(cmd.GetProbeProxySecureLink()); err != nil {
				result.Success = false
				result.Error = err.Error()
			} else {
				result.Detail = detail
			}
			if err := writer.Send(&pb.DaemonMessage{Payload: &pb.DaemonMessage_CommandResult{CommandResult: result}}); err != nil {
				return err
			}
			continue
		case *pb.GatewayCommand_UpdateDaemon:
			// Self-update: download new binary, replace it on disk, acknowledge the
			// command to the gateway, then exit so systemd restarts the daemon.
			updateCmd := cmd.GetUpdateDaemon()
			result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
			if err := SelfUpdate(
				updateCmd.DownloadUrl,
				updateCmd.TargetVersion,
				updateCmd.Checksum,
				updateCmd.SignedManifest,
				d.plugin.Type(),
				d.logger,
			); err != nil {
				result.Success = false
				result.Error = err.Error()
			}
			if err := writer.Send(&pb.DaemonMessage{
				Payload: &pb.DaemonMessage_CommandResult{CommandResult: result},
			}); err != nil {
				return err
			}
			if result.Success {
				d.logger.Info("self-update staged successfully, exiting for restart", "target_version", updateCmd.TargetVersion)
				return &RestartRequestedError{Message: "self-update staged successfully"}
			}
			d.logger.Error("self-update failed", "target_version", updateCmd.TargetVersion, "error", result.Error)
			continue
		}

		// Process command and send result
		result := d.plugin.HandleCommand(cmd)
		if err := writer.Send(&pb.DaemonMessage{
			Payload: &pb.DaemonMessage_CommandResult{CommandResult: result},
		}); err != nil {
			return err
		}
	}
}

// runHealthReporter periodically sends health reports to the gateway.
func runHealthReporter(ctx context.Context, d *DaemonBase, writer *stream.Writer) {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			report := collectFullHealth(d)
			if err := writer.Send(&pb.DaemonMessage{
				Payload: &pb.DaemonMessage_HealthReport{HealthReport: report},
			}); err != nil {
				d.logger.Debug("failed to send health report", "error", err)
				return
			}
		}
	}
}

// collectFullHealth gathers system metrics and enriches them with plugin-specific data.
func collectFullHealth(d *DaemonBase) *pb.HealthReport {
	report := d.sysReporter.CollectSystemHealth(nil)
	return d.plugin.CollectHealth(report)
}

// runCertRenewal checks cert expiry daily and renews when within 7 days.
func runCertRenewal(ctx context.Context, d *DaemonBase) {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()

	check := func() {
		expiresAt := d.state.GetCertExpiry()
		if expiresAt == 0 {
			return
		}
		remaining := time.Until(time.Unix(expiresAt, 0))
		if remaining > 7*24*time.Hour {
			return
		}

		d.logger.Info("mTLS cert expiring soon, renewing", "remaining", remaining)

		conn, err := d.connector.Connect(ctx)
		if err != nil {
			d.logger.Warn("cert renewal: failed to connect", "error", err)
			return
		}
		defer conn.Close()

		client := pb.NewNodeEnrollmentClient(conn)
		renewCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()

		resp, err := client.RenewCertificate(renewCtx, &pb.RenewCertRequest{
			NodeId: d.state.NodeID,
		})
		if err != nil {
			d.logger.Warn("cert renewal failed", "error", err)
			return
		}

		if err := d.saveCertificates(nil, resp.ClientCertificate, resp.ClientKey); err != nil {
			d.logger.Warn("cert renewal: save failed", "error", err)
			return
		}

		// Hot-swap the TLS credentials
		if err := d.connector.TLSMgr.LoadCredentials(); err != nil {
			d.logger.Warn("cert renewal: hot-swap failed", "error", err)
			return
		}

		d.state.SetCertExpiry(resp.CertExpiresAt)
		if err := d.state.Save(); err != nil {
			d.logger.Warn("cert renewal: state save failed", "error", err)
		}
		d.notifyTunnelIdentityChanged()
		d.logger.Info("mTLS cert renewed successfully")
	}

	check() // Run immediately
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			check()
		}
	}
}

// handleNodeExec handles node-level console create/resize commands.
func handleNodeExec(ctx context.Context, mgr *exec.Manager, cmd *pb.GatewayCommand, consoleUser string) *pb.CommandResult {
	nodeExec := cmd.GetNodeExec()
	result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
	sessionKey := nodeConsoleSessionKey(nodeExec.GetSessionKey())

	switch nodeExec.GetAction() {
	case "run":
		runCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		commandResult, err := exec.RunCommand(runCtx, nodeExec.GetCommand(), consoleUser, 128*1024)
		detailJSON, _ := json.Marshal(commandResult)
		result.Detail = string(detailJSON)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return result
		}

	case "create":
		shell := ""
		if cmds := nodeExec.GetCommand(); len(cmds) > 0 {
			shell = cmds[0]
		}
		execID, isNew, err := mgr.CreatePTYSession(ctx, sessionKey, shell, int(nodeExec.GetRows()), int(nodeExec.GetCols()), consoleUser)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
			return result
		}

		// Build detail JSON with exec_id, is_new, and buffered output
		detail := map[string]interface{}{
			"exec_id": execID,
			"is_new":  isNew,
		}
		if !isNew {
			detail["buffer"] = mgr.GetBufferBase64(sessionKey)
		}
		detailJSON, _ := json.Marshal(detail)
		result.Detail = string(detailJSON)

	case "resize":
		// Find the session and resize
		session := mgr.GetSessionByKey(sessionKey)
		if session != nil {
			if err := mgr.Resize(session.ID, int(nodeExec.GetRows()), int(nodeExec.GetCols())); err != nil {
				result.Success = false
				result.Error = err.Error()
			}
		}

	default:
		result.Success = false
		result.Error = "unknown node exec action: " + nodeExec.GetAction()
	}

	return result
}

func nodeConsoleSessionKey(ownerKey string) string {
	if ownerKey == "" {
		return "node-console"
	}
	return "node-console:" + ownerKey
}

// newSystemReporter creates a new system metrics reporter.
func newSystemReporter() *sysmetrics.SystemReporter {
	return sysmetrics.NewSystemReporter()
}
