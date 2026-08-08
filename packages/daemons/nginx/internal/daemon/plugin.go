package daemon

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/connector"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	sharedstate "github.com/wiolett-industries/gateway/daemon-shared/state"
	"github.com/wiolett-industries/gateway/daemon-shared/stream"
	"github.com/wiolett-industries/gateway/daemon-shared/sysmetrics"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/config"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/nginx"
	"google.golang.org/grpc"
)

// NginxPlugin implements lifecycle.DaemonPlugin for the nginx daemon.
type NginxPlugin struct {
	cfg      *config.Config
	baseCfg  *lifecycle.BaseConfig
	mgr      *nginx.Manager
	handler  *Handler
	reporter *Reporter
	state    *sharedstate.State
	logger   *slog.Logger

	// Session-scoped resources
	sessionCancel context.CancelFunc
	conn          *grpc.ClientConn
}

// NewNginxPlugin creates a new NginxPlugin with the given config.
func NewNginxPlugin(cfg *config.Config) *NginxPlugin {
	return &NginxPlugin{cfg: cfg}
}

func (p *NginxPlugin) Type() string {
	return "nginx"
}

func (p *NginxPlugin) SetLogger(logger *slog.Logger) {
	p.logger = logger
	if p.handler != nil {
		p.handler.logger = logger
	}
	if p.reporter != nil {
		p.reporter.logger = logger
	}
}

func (p *NginxPlugin) Init(baseCfg *lifecycle.BaseConfig, logger *slog.Logger) error {
	p.baseCfg = baseCfg
	p.logger = logger

	// Verify nginx is available
	mgr := nginx.NewManager(p.cfg.Nginx.Binary, p.cfg.Nginx.ConfigDir, p.cfg.Nginx.CertsDir, p.cfg.Nginx.GlobalConfig)
	version, err := mgr.GetVersion()
	if err != nil {
		return fmt.Errorf("nginx not found at %s: %w", p.cfg.Nginx.Binary, err)
	}
	logger.Info("nginx detected", "version", version)
	p.mgr = mgr

	// Clean up leftover .tmp files from potential crashes
	nginx.CleanTmpFiles(p.cfg.Nginx.ConfigDir)
	nginx.CleanTmpFiles(p.cfg.Nginx.CertsDir)

	// Ensure gateway log format is present in nginx.conf
	if modified, err := nginx.EnsureLogFormat(p.cfg.Nginx.GlobalConfig); err != nil {
		logger.Warn("failed to inject log format", "error", err)
	} else if modified {
		logger.Info("injected gateway_combined log format into nginx.conf")
		mgr.Reload()
	}

	return nil
}

// SetState is called by the daemon wrapper to provide the shared state.
func (p *NginxPlugin) SetState(st *sharedstate.State) {
	p.state = st
	p.handler = NewHandler(p.cfg, p.mgr, st, p.logger)
	p.reporter = NewReporter(p.cfg, p.mgr, p.logger)
}

func (p *NginxPlugin) BuildRegisterMessage(nodeID string) *pb.RegisterMessage {
	hostname, _ := os.Hostname()
	nginxVersion, _ := p.mgr.GetVersion()
	uptime, _ := p.mgr.GetUptime()
	cpuModel, cpuCores := sysmetrics.GetCPUInfo()
	arch := sysmetrics.GetArchitecture()
	kernelVer := sysmetrics.GetKernelVersion()

	configVersionHash := p.state.GetExtraString("config_version_hash")

	return &pb.RegisterMessage{
		NodeId:             nodeID,
		Hostname:           hostname,
		NginxVersion:       nginxVersion,
		ConfigVersionHash:  configVersionHash,
		DaemonVersion:      lifecycle.Version,
		NginxUptimeSeconds: int64(uptime.Seconds()),
		NginxRunning:       p.mgr.IsRunning(),
		CpuModel:           cpuModel,
		CpuCores:           int32(cpuCores),
		Architecture:       arch,
		KernelVersion:      kernelVer,
		DaemonType:         "nginx",
		Capabilities:       []string{"nginx_certificate_distribution_v2"},
	}
}

func (p *NginxPlugin) HandleCommand(cmd *pb.GatewayCommand) *pb.CommandResult {
	return p.handler.HandleCommand(cmd)
}

func (p *NginxPlugin) CollectHealth(base *pb.HealthReport) *pb.HealthReport {
	return p.reporter.CollectHealth(base)
}

func (p *NginxPlugin) CollectStats() *pb.StatsReport {
	return p.reporter.CollectStats()
}

func (p *NginxPlugin) OnSessionStart(ctx context.Context, _ *stream.Writer) error {
	sessionCtx, cancel := context.WithCancel(ctx)
	p.sessionCancel = cancel

	// Start log cleanup in background
	go p.runLogCleanup(sessionCtx)

	// Start log stream if we have a connection
	// The log stream is managed at the session level for nginx
	return nil
}

func (p *NginxPlugin) OnSessionEnd() {
	if p.sessionCancel != nil {
		p.sessionCancel()
		p.sessionCancel = nil
	}
}

// runLogCleanup periodically removes nginx logs older than 7 days.
func (p *NginxPlugin) runLogCleanup(ctx context.Context) {
	ticker := time.NewTicker(6 * time.Hour)
	defer ticker.Stop()

	// Run immediately on start
	if removed, err := nginx.CleanOldLogs(p.cfg.Nginx.LogsDir, 7*24*time.Hour); err != nil {
		p.logger.Warn("log cleanup failed", "error", err)
	} else if removed > 0 {
		p.logger.Info("cleaned old nginx logs", "removed", removed)
	}

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if removed, err := nginx.CleanOldLogs(p.cfg.Nginx.LogsDir, 7*24*time.Hour); err != nil {
				p.logger.Warn("log cleanup failed", "error", err)
			} else if removed > 0 {
				p.logger.Info("cleaned old nginx logs", "removed", removed)
			}
		}
	}
}

// RunLogStream runs the log streaming loop for the nginx daemon.
// This is called from the daemon wrapper which has access to the connection.
func (p *NginxPlugin) RunLogStream(ctx context.Context, conn *grpc.ClientConn) {
	backoff := 500 * time.Millisecond
	for {
		if ctx.Err() != nil {
			return
		}

		err := p.runLogStreamSession(ctx, conn)
		if ctx.Err() != nil {
			return
		}
		p.logger.Debug("log stream stopped, reconnecting", "error", err)

		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 5*time.Second {
			backoff *= 2
		}
	}
}

func (p *NginxPlugin) runLogStreamSession(ctx context.Context, conn *grpc.ClientConn) error {
	rawStream, err := connector.OpenLogStream(ctx, conn)
	if err != nil {
		return fmt.Errorf("open log stream: %w", err)
	}

	logStream := stream.NewLogStreamWriter(rawStream)

	// Track active tailers per hostId
	tailers := make(map[string]context.CancelFunc)

	for ctx.Err() == nil {
		ctrl, err := logStream.Recv()
		if err != nil {
			for _, cancel := range tailers {
				cancel()
			}
			return fmt.Errorf("receive log control: %w", err)
		}

		if ctrl.GetSubscribe() != nil {
			sub := ctrl.GetSubscribe()
			hostId := sub.HostId
			tailLines := int(sub.TailLines)

			// Validate hostId to prevent path traversal
			if !isValidUUID(hostId) {
				p.logger.Warn("invalid hostId in log subscribe", "hostId", hostId)
				continue
			}

			accessLogPath := fmt.Sprintf("%s/proxy-%s.access.log", p.cfg.Nginx.LogsDir, hostId)
			errorLogPath := fmt.Sprintf("%s/proxy-%s.error.log", p.cfg.Nginx.LogsDir, hostId)

			if tailLines < 0 {
				lines, _ := nginx.TailLastN(accessLogPath, -tailLines)
				for _, line := range lines {
					parsed := nginx.ParseLogLine(hostId, line)
					logStream.Send(&pb.LogStreamMessage{
						Payload: &pb.LogStreamMessage_Entry{
							Entry: &pb.LogEntry{
								HostId:        hostId,
								Timestamp:     parsed.Timestamp,
								RemoteAddr:    parsed.RemoteAddr,
								Method:        parsed.Method,
								Path:          parsed.Path,
								Status:        int32(parsed.Status),
								BodyBytesSent: parsed.BodyBytesSent,
								Raw:           parsed.Raw,
								LogType:       "access",
							},
						},
					})
				}
				logStream.Send(&pb.LogStreamMessage{
					Payload: &pb.LogStreamMessage_SubscribeAck{
						SubscribeAck: &pb.LogSubscribeAck{HostId: hostId},
					},
				})
				continue
			}

			// Cancel existing tailer for this host if any
			if cancel, ok := tailers[hostId]; ok {
				cancel()
			}

			tailCtx, cancel := context.WithCancel(ctx)
			tailers[hostId] = cancel

			if tailLines > 0 {
				lines, _ := nginx.TailLastN(accessLogPath, tailLines)
				for _, line := range lines {
					parsed := nginx.ParseLogLine(hostId, line)
					logStream.Send(&pb.LogStreamMessage{
						Payload: &pb.LogStreamMessage_Entry{
							Entry: &pb.LogEntry{
								HostId:        hostId,
								Timestamp:     parsed.Timestamp,
								RemoteAddr:    parsed.RemoteAddr,
								Method:        parsed.Method,
								Path:          parsed.Path,
								Status:        int32(parsed.Status),
								BodyBytesSent: parsed.BodyBytesSent,
								Raw:           parsed.Raw,
								LogType:       "access",
							},
						},
					})
				}
			}

			// Tail access logs
			go func(hid string, lp string) {
				lines := make(chan string, 100)
				go nginx.TailFile(tailCtx, lp, lines)
				for line := range lines {
					parsed := nginx.ParseLogLine(hid, line)
					logStream.Send(&pb.LogStreamMessage{
						Payload: &pb.LogStreamMessage_Entry{
							Entry: &pb.LogEntry{
								HostId:        hid,
								Timestamp:     parsed.Timestamp,
								RemoteAddr:    parsed.RemoteAddr,
								Method:        parsed.Method,
								Path:          parsed.Path,
								Status:        int32(parsed.Status),
								BodyBytesSent: parsed.BodyBytesSent,
								Raw:           parsed.Raw,
								LogType:       "access",
							},
						},
					})
				}
			}(hostId, accessLogPath)

			// Tail error logs
			go func(hid string, lp string) {
				lines := make(chan string, 100)
				go nginx.TailFile(tailCtx, lp, lines)
				for line := range lines {
					logStream.Send(&pb.LogStreamMessage{
						Payload: &pb.LogStreamMessage_Entry{
							Entry: &pb.LogEntry{
								HostId:  hid,
								Raw:     line,
								LogType: "error",
								Level:   nginx.ParseErrorLevel(line),
							},
						},
					})
				}
			}(hostId, errorLogPath)

			logStream.Send(&pb.LogStreamMessage{
				Payload: &pb.LogStreamMessage_SubscribeAck{
					SubscribeAck: &pb.LogSubscribeAck{HostId: hostId},
				},
			})

		} else if ctrl.GetUnsubscribe() != nil {
			hostId := ctrl.GetUnsubscribe().HostId
			if cancel, ok := tailers[hostId]; ok {
				cancel()
				delete(tailers, hostId)
			}
		}
	}

	return ctx.Err()
}
