package lifecycle

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/auth"
	"github.com/wiolett-industries/gateway/daemon-shared/connector"
	"github.com/wiolett-industries/gateway/daemon-shared/enrollment"
	"github.com/wiolett-industries/gateway/daemon-shared/state"
	"github.com/wiolett-industries/gateway/daemon-shared/stream"
	"github.com/wiolett-industries/gateway/daemon-shared/sysmetrics"
	"google.golang.org/grpc"
)

// Version is set via -ldflags at build time; falls back to "dev".
var Version = "dev"

// DaemonBase is the shared daemon lifecycle manager.
// It handles enrollment, mTLS, reconnection, and delegates
// daemon-specific behavior to the DaemonPlugin.
type DaemonBase struct {
	cfg                   *BaseConfig
	cfgPath               string
	state                 *state.State
	connector             *connector.Connector
	plugin                DaemonPlugin
	sysReporter           *sysmetrics.SystemReporter
	logger                *slog.Logger
	baseHandler           slog.Handler // original handler, never wrapped
	tunnelIdentityChanged chan struct{}
}

// NewDaemonBase creates a new DaemonBase with the given plugin.
func NewDaemonBase(cfg *BaseConfig, cfgPath string, plugin DaemonPlugin, logger *slog.Logger) (*DaemonBase, error) {
	// Wrap logger with startup buffer so pre-session logs can be replayed
	startupLogger := slog.New(stream.NewStartupLogHandler(logger.Handler()))
	if err := plugin.Init(cfg, startupLogger); err != nil {
		return nil, fmt.Errorf("plugin init: %w", err)
	}

	// Load state
	st, err := state.Load(cfg.StateDir)
	if err != nil {
		return nil, fmt.Errorf("load state: %w", err)
	}

	return &DaemonBase{
		cfg:                   cfg,
		cfgPath:               cfgPath,
		state:                 st,
		plugin:                plugin,
		sysReporter:           newSystemReporter(),
		logger:                startupLogger,
		baseHandler:           logger.Handler(), // original handler without startup buffer
		tunnelIdentityChanged: make(chan struct{}, 1),
	}, nil
}

// Run starts the daemon lifecycle: enroll, connect, session loop.
func (d *DaemonBase) Run(ctx context.Context) error {
	// Step 1: Enroll if not yet enrolled
	if !d.cfg.IsEnrolled() {
		if err := d.enroll(); err != nil {
			return fmt.Errorf("enrollment: %w", err)
		}
	}

	// Step 2: Set up mTLS connector
	tlsMgr := auth.NewTLSManager(d.cfg.TLS.CACert, d.cfg.TLS.ClientCert, d.cfg.TLS.ClientKey)
	d.connector = connector.NewConnector(d.cfg.Gateway.Address, tlsMgr, d.logger)

	// Step 3: Start background cert renewal
	go runCertRenewal(ctx, d)
	go d.sysReporter.RunPublicIPDiscovery(ctx)
	if relayTunnel, ok := d.plugin.(RelayTunnelPlugin); ok {
		// The tunnel owns one process-lifetime ClientConn. It is intentionally
		// outside runSessionCycle: control reconnects must not cancel tunnel
		// streams or the TCP sessions multiplexed through them.
		go runProcessRelayTunnel(
			ctx,
			d.connector.ConnectWithRetry,
			relayTunnel,
			d.state.NodeID,
			d.tunnelIdentityChanged,
			d.logger,
		)
	}

	// Step 4: Connect and run (with reconnection loop)
	for {
		err := d.runSessionCycle(ctx)
		if ctx.Err() != nil {
			d.logger.Info("shutting down")
			return nil
		}
		// Fatal errors: do NOT reconnect, exit immediately
		if fatal, ok := err.(*FatalError); ok {
			d.logger.Error("fatal: "+fatal.Message, "action", "exiting")
			return fmt.Errorf("fatal: %s", fatal.Message)
		}
		if restart, ok := err.(*RestartRequestedError); ok {
			d.logger.Info(restart.Message, "action", "restarting")
			return fmt.Errorf("restart requested: %s", restart.Message)
		}
		d.logger.Warn("session ended, reconnecting", "error", err)
		// The relay can remain reachable while its app upstream is restarting.
		// In that state a control RPC fails immediately with EOF, so the
		// transport-level connector backoff is never reached. Bound the retry
		// rate here to avoid a CPU and log storm during normal Gateway updates.
		if !waitForControlSessionReconnect(ctx) {
			return nil
		}
	}
}

type relayTunnelConnect func(context.Context) (*grpc.ClientConn, error)

const controlSessionReconnectDelay = time.Second

func waitForControlSessionReconnect(ctx context.Context) bool {
	timer := time.NewTimer(controlSessionReconnectDelay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func runProcessRelayTunnel(
	ctx context.Context,
	connect relayTunnelConnect,
	plugin RelayTunnelPlugin,
	nodeID string,
	identityChanged <-chan struct{},
	logger *slog.Logger,
) {
	for ctx.Err() == nil {
		laneCount := 1
		var runtimeChanged <-chan struct{}
		if runtime, ok := plugin.(RelayTunnelRuntimePlugin); ok {
			laneCount = runtime.RelayTunnelLaneCount()
			if laneCount < 1 {
				laneCount = 1
			}
			if laneCount > 16 {
				laneCount = 16
			}
			runtimeChanged = runtime.RelayTunnelRuntimeChanged()
		}
		connections := make([]*grpc.ClientConn, 0, laneCount)
		var connectErr error
		for lane := 0; lane < laneCount; lane++ {
			conn, err := connect(ctx)
			if err != nil {
				connectErr = err
				break
			}
			connections = append(connections, conn)
		}
		if connectErr != nil {
			for _, conn := range connections {
				if conn != nil {
					_ = conn.Close()
				}
			}
			if ctx.Err() != nil {
				return
			}
			logger.Warn("relay tunnel lane connection failed, retrying", "error", connectErr)
			select {
			case <-ctx.Done():
				return
			case <-time.After(time.Second):
				continue
			}
		}
		tunnelCtx, cancelTunnel := context.WithCancel(ctx)
		tunnelEnded := make(chan struct{}, laneCount)
		for _, conn := range connections {
			laneConn := conn
			go func() {
				plugin.RunRelayTunnels(tunnelCtx, laneConn, nodeID)
				tunnelEnded <- struct{}{}
			}()
		}
		rotated := false
		resized := false
		ended := 0
		select {
		case <-ctx.Done():
		case <-identityChanged:
			rotated = true
			logger.Info("relay tunnel identity changed, reconnecting")
		case <-runtimeChanged:
			resized = true
			logger.Info("relay tunnel runtime changed, resizing lanes")
		case <-tunnelEnded:
			ended = 1
		}
		cancelTunnel()
		for _, conn := range connections {
			if conn != nil {
				_ = conn.Close()
			}
		}
		for ended < len(connections) {
			select {
			case <-tunnelEnded:
				ended++
			case <-ctx.Done():
				return
			}
		}
		if ctx.Err() != nil {
			return
		}
		if rotated || resized {
			continue
		}
		logger.Warn("relay tunnel lifecycle ended unexpectedly, restarting")
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

func (d *DaemonBase) notifyTunnelIdentityChanged() {
	select {
	case d.tunnelIdentityChanged <- struct{}{}:
	default:
	}
}

func (d *DaemonBase) enroll() error {
	d.logger.Info("enrolling with gateway", "address", d.cfg.Gateway.Address)
	if d.cfg.Gateway.CertSHA256 == "" {
		return fmt.Errorf("gateway.cert_sha256 is required for initial enrollment")
	}

	hostname, _ := os.Hostname()
	osInfo := fmt.Sprintf("%s/%s", runtime.GOOS, runtime.GOARCH)

	resp, err := enrollment.Enroll(
		d.cfg.Gateway.Address,
		d.cfg.Gateway.Token,
		d.cfg.Gateway.CertSHA256,
		hostname,
		"", // nginxVersion — filled by plugin if applicable
		osInfo,
		Version,
		d.plugin.Type(),
	)
	if err != nil {
		return err
	}

	// Save credentials
	if err := d.saveCertificates(resp.CaCertificate, resp.ClientCertificate, resp.ClientKey); err != nil {
		return fmt.Errorf("save credentials: %w", err)
	}

	d.state.SetEnrolled(resp.NodeId)
	d.state.SetCertExpiry(resp.CertExpiresAt)
	if err := d.state.Save(); err != nil {
		return fmt.Errorf("save state: %w", err)
	}

	// Clear token from config file on disk to prevent re-use
	d.cfg.Gateway.Token = ""
	if err := ClearTokenFromFile(d.cfgPath); err != nil {
		d.logger.Warn("failed to clear token from config file", "error", err)
	}
	d.logger.Info("enrolled successfully", "node_id", resp.NodeId)
	return nil
}

func (d *DaemonBase) runSessionCycle(ctx context.Context) error {
	conn, err := d.connector.ConnectWithRetry(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()

	return runSession(ctx, conn, d)
}

func (d *DaemonBase) saveCertificates(caCert, clientCert, clientKey []byte) error {
	return auth.SaveCredentials(
		d.cfg.TLS.CACert,
		d.cfg.TLS.ClientCert,
		d.cfg.TLS.ClientKey,
		caCert,
		clientCert,
		clientKey,
	)
}

// GetState returns the daemon's state for use by plugins.
func (d *DaemonBase) GetState() *state.State {
	return d.state
}
