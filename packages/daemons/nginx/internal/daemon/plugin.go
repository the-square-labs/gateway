package daemon

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	sharedauth "github.com/wiolett-industries/gateway/daemon-shared/auth"
	"github.com/wiolett-industries/gateway/daemon-shared/connector"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
	sharedstate "github.com/wiolett-industries/gateway/daemon-shared/state"
	"github.com/wiolett-industries/gateway/daemon-shared/stream"
	"github.com/wiolett-industries/gateway/daemon-shared/sysmetrics"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/config"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/nginx"
	"github.com/wiolett-industries/gateway/nginx-daemon/internal/pages"
	"google.golang.org/grpc"
)

// NginxPlugin implements lifecycle.DaemonPlugin for the nginx daemon.
type NginxPlugin struct {
	cfg                         *config.Config
	baseCfg                     *lifecycle.BaseConfig
	mgr                         *nginx.Manager
	handler                     *Handler
	reporter                    *Reporter
	state                       *sharedstate.State
	logger                      *slog.Logger
	relayGrants                 *relayGrantStore
	secureLinks                 *sourceLinkManager
	registryLinks               *sourceLinkManager
	secureLinkState             *securelink.StateStore
	pagesRuntime                *pages.Runtime
	pagesV1Available            bool
	pagesRuntimeConfigAvailable bool
	relayTunnelMu               sync.Mutex
	relayTunnels                []*nginxRelayTunnel
	relaySelection              uint64
	configWatchMu               sync.Mutex
	validatedConfigFingerprint  string
	pendingConfigFingerprint    string
	configFingerprintReady      bool

	// Session-scoped resources
	sessionCancel              context.CancelFunc
	conn                       *grpc.ClientConn
	maintenanceAccess          *maintenanceAccessServer
	maintenanceAccessSupported bool
}

var _ lifecycle.ProxySecureLinkPlugin = (*NginxPlugin)(nil)
var _ lifecycle.ProxySecureLinkProbePlugin = (*NginxPlugin)(nil)
var _ lifecycle.PagesRouteProbePlugin = (*NginxPlugin)(nil)

func secureLinkProxyPassPattern(linkID string, port int) *regexp.Regexp {
	portPattern := `[0-9]+`
	if port > 0 {
		portPattern = fmt.Sprintf("%d", port)
	}
	return regexp.MustCompile(fmt.Sprintf(
		`(?m)(#[[:space:]]*gateway-managed-secure-link-upstream[[:space:]]+%s[[:space:]]*\r?\n[[:space:]]*proxy_pass[[:space:]]+https?://)127[.]0[.]0[.]1:%s`,
		regexp.QuoteMeta(linkID),
		portPattern,
	))
}

func replaceFirstSecureLinkProxyPass(content []byte, linkID string, oldPort, newPort int) ([]byte, bool) {
	pattern := secureLinkProxyPassPattern(linkID, oldPort)
	indices := pattern.FindSubmatchIndex(content)
	if indices == nil && oldPort > 0 {
		// A managed config may already be ahead of persisted listener state after
		// a crash. The per-host marker keeps this fallback out of unrelated or
		// user-owned raw configs.
		indices = secureLinkProxyPassPattern(linkID, 0).FindSubmatchIndex(content)
	}
	if indices == nil {
		return content, false
	}
	prefix := content[indices[2]:indices[3]]
	replacement := []byte(fmt.Sprintf("%s127.0.0.1:%d", prefix, newPort))
	next := make([]byte, 0, len(content)-indices[1]+indices[0]+len(replacement))
	next = append(next, content[:indices[0]]...)
	next = append(next, replacement...)
	next = append(next, content[indices[1]:]...)
	return next, true
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
	mgr.SetConfigTestObserver(p.observeConfigTest)
	p.maintenanceAccessSupported, err = mgr.HasSecureLinkModule()
	if err != nil {
		return err
	}
	if !p.maintenanceAccessSupported {
		logger.Warn("nginx secure_link module is unavailable; maintenance access codes are disabled")
	}
	p.relayGrants, err = newRelayGrantStore(baseCfg.StateDir)
	if err != nil {
		return fmt.Errorf("initialize relay grant store: %w", err)
	}
	p.secureLinks = newSourceLinkManager(p.openProxySecureLink, p.cfg.Nginx.Binary, p.mgr.GetPID)
	p.registryLinks = newSourceLinkManagerAt(
		p.openRegistrySecureLink,
		registrySecureLinkSocketDir,
		p.cfg.Nginx.Binary,
		p.mgr.GetPID,
	)
	p.secureLinkState, err = securelink.NewStateStore(baseCfg.StateDir)
	if err != nil {
		return fmt.Errorf("initialize proxy secure-link state: %w", err)
	}
	p.pagesRuntime, err = pages.New(p.cfg.Nginx.PagesRoot, p.cfg.Nginx.ConfigDir, p.cfg.Nginx.CertsDir, p.mgr)
	if err != nil {
		logger.Warn("Gateway Pages runtime is unavailable; Pages capability is disabled", "error", err)
	} else if _, err := p.pagesRuntime.StoragePreflight(0); err != nil {
		logger.Warn("Gateway Pages storage is unavailable; Pages capability is disabled", "error", err)
		p.pagesRuntime = nil
	} else {
		// Set this only after every v1 runtime dependency has initialized and the
		// confined storage root has passed a real filesystem preflight. This is
		// deliberately a capability gate, not a daemon-version heuristic.
		p.pagesV1Available = true
		p.pagesRuntimeConfigAvailable, err = nginxBuildHasSubFilter(p.cfg.Nginx.Binary)
		if err != nil {
			logger.Warn("Gateway Pages runtime configuration is unavailable; capability is disabled", "error", err)
			p.pagesRuntimeConfigAvailable = false
		} else if !p.pagesRuntimeConfigAvailable {
			logger.Warn("Gateway Pages runtime configuration is unavailable; nginx was built without http_sub_module")
		}
	}
	if restored := p.secureLinkState.Get(); len(restored.Bindings) > 0 {
		statuses, restoreErr := p.secureLinks.sync(restored)
		if restoreErr != nil {
			return fmt.Errorf("restore proxy secure-link listeners: %w", restoreErr)
		}
		if reconcileErr := p.reconcileRestoredSecureLinkPorts(restored, statuses); reconcileErr != nil {
			return fmt.Errorf("reconcile restored proxy secure-link ports: %w", reconcileErr)
		}
		if saveErr := p.secureLinkState.Save(normalizeSourceBindings(restored, statuses)); saveErr != nil {
			return fmt.Errorf("persist restored proxy secure-link listeners: %w", saveErr)
		}
	}

	// Clean up leftover .tmp files from potential crashes
	nginx.CleanTmpFiles(p.cfg.Nginx.ConfigDir)
	nginx.CleanTmpFiles(p.cfg.Nginx.CertsDir)

	globalConfigModified := false

	// Ensure gateway log format is present in nginx.conf.
	if modified, err := nginx.EnsureLogFormat(p.cfg.Nginx.GlobalConfig); err != nil {
		logger.Warn("failed to inject log format", "error", err)
	} else if modified {
		logger.Info("injected gateway_combined log format into nginx.conf")
		globalConfigModified = true
	}

	// Pages preview hostnames can exceed nginx's platform-default server-name
	// hash bucket. Keep the managed minimum in the global http block.
	if modified, err := nginx.EnsureServerNamesHashBucketSize(p.cfg.Nginx.GlobalConfig); err != nil {
		logger.Warn("failed to configure server names hash bucket size", "error", err)
	} else if modified {
		logger.Info("configured server names hash bucket size for Gateway Pages")
		globalConfigModified = true
	}

	if globalConfigModified {
		mgr.Reload()
	}
	if valid, output := mgr.TestConfig(); !valid {
		logger.Warn("nginx configuration is invalid", "output", output)
	}

	return nil
}

type secureLinkConfigChange struct {
	path string
	old  []byte
	next []byte
}

func (p *NginxPlugin) reconcileRestoredSecureLinkPorts(
	restored *pb.SyncProxySecureLinksCommand,
	statuses []sourceLinkStatus,
) error {
	ports := make(map[string]int, len(statuses))
	for _, status := range statuses {
		ports[status.LinkID] = status.Port
	}
	changes := make([]secureLinkConfigChange, 0)
	for _, binding := range restored.Bindings {
		if !binding.SourceConfigManaged {
			continue
		}
		port := ports[binding.LinkId]
		if port == 0 {
			continue
		}
		path := p.mgr.ConfigPath(binding.LinkId)
		current, err := nginx.ReadFile(path)
		if err != nil {
			return err
		}
		if current == nil {
			continue
		}
		next, changed := replaceFirstSecureLinkProxyPass(current, binding.LinkId, int(binding.ListenerPort), port)
		if !changed || bytes.Equal(current, next) {
			continue
		}
		changes = append(changes, secureLinkConfigChange{path: path, old: current, next: next})
	}
	if len(changes) == 0 {
		return nil
	}
	rollback := func(applied int) {
		for index := applied - 1; index >= 0; index-- {
			_ = nginx.WriteAtomic(changes[index].path, changes[index].old)
		}
	}
	for index, change := range changes {
		if err := nginx.WriteAtomic(change.path, change.next); err != nil {
			rollback(index)
			return err
		}
	}
	valid, output := p.mgr.TestConfig()
	if !valid {
		rollback(len(changes))
		return fmt.Errorf("nginx config test failed after secure-link port recovery: %s", output)
	}
	if err := p.mgr.Reload(); err != nil {
		rollback(len(changes))
		return err
	}
	p.logger.Info("reconciled proxy secure-link listener ports after restart", "host_count", len(changes))
	return nil
}

// SetState is called by the daemon wrapper to provide the shared state.
func (p *NginxPlugin) SetState(st *sharedstate.State) {
	p.state = st
	p.reporter = NewReporter(p.cfg, p.mgr, p.logger)
	p.handler = NewHandler(p.cfg, p.mgr, st, p.logger, p.secureLinkState, p.pagesRuntime, p.pagesRuntimeConfigAvailable)
	p.handler.reporter = p.reporter
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
		Capabilities:       p.capabilities(),
	}
}

func (p *NginxPlugin) HandleCommand(cmd *pb.GatewayCommand) *pb.CommandResult {
	if payload, ok := cmd.Payload.(*pb.GatewayCommand_SyncDockerRegistryBindings); ok {
		result := &pb.CommandResult{CommandId: cmd.CommandId, Success: true}
		detail, err := p.SyncDockerRegistryBindings(payload.SyncDockerRegistryBindings)
		if err != nil {
			result.Success = false
			result.Error = err.Error()
		} else {
			result.Detail = detail
		}
		return result
	}
	return p.handler.HandleCommand(cmd)
}

func (p *NginxPlugin) CollectHealth(base *pb.HealthReport) *pb.HealthReport {
	return p.reporter.CollectHealth(base)
}

func (p *NginxPlugin) CollectStats() *pb.StatsReport {
	return p.reporter.CollectStats()
}

func (p *NginxPlugin) capabilities() []string {
	capabilities := []string{"nginx_certificate_distribution_v2", "generic_relay_tunnel_v1", "relay_pool_v1", "proxy_secure_links_v1", "nginx_secure_link_socket_only_v1", "nginx_registry_ingress_v1"}
	if p.maintenanceAccessSupported {
		capabilities = append(capabilities, "proxy_maintenance_access_v1")
	}
	if p.pagesV1Available && p.pagesRuntime != nil {
		capabilities = append(capabilities, "nginx_pages_v1", "nginx_pages_route_probe_v1")
	}
	if p.pagesRuntimeConfigAvailable && p.pagesRuntime != nil {
		capabilities = append(capabilities, "nginx_pages_config_v1")
	}
	return capabilities
}

func nginxBuildHasSubFilter(binary string) (bool, error) {
	output, err := exec.Command(binary, "-V").CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("nginx build check failed: %w", err)
	}
	return nginxBuildOutputHasSubFilter(output), nil
}

func nginxBuildOutputHasSubFilter(output []byte) bool {
	return strings.Contains(string(output), "--with-http_sub_module")
}

func (p *NginxPlugin) OnSessionStart(ctx context.Context, _ *stream.Writer) error {
	sessionCtx, cancel := context.WithCancel(ctx)
	p.sessionCancel = cancel
	p.validateConfigIfStale(time.Now())
	go p.runConfigValidation(sessionCtx)
	if !p.maintenanceAccessSupported {
		go p.runLogCleanup(sessionCtx)
		return nil
	}
	tlsManager := sharedauth.NewTLSManager(p.baseCfg.TLS.CACert, p.baseCfg.TLS.ClientCert, p.baseCfg.TLS.ClientKey)
	conn, err := connector.NewConnector(p.baseCfg.Gateway.Address, tlsManager, p.logger).Connect(sessionCtx)
	if err != nil {
		cancel()
		return err
	}
	accessServer, err := startMaintenanceAccessServer(conn, p.logger)
	if err != nil {
		_ = conn.Close()
		cancel()
		return err
	}
	p.conn = conn
	p.maintenanceAccess = accessServer

	// Start log cleanup in background
	go p.runLogCleanup(sessionCtx)

	// Start log stream if we have a connection
	// The log stream is managed at the session level for nginx
	return nil
}

func (p *NginxPlugin) OnSessionEnd() {
	p.maintenanceAccess.close()
	p.maintenanceAccess = nil
	if p.conn != nil {
		_ = p.conn.Close()
		p.conn = nil
	}
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
