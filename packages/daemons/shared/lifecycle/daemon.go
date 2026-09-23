package lifecycle

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"runtime"
	"sync/atomic"
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
	// controlReconnect asks the running control session to reconnect, so the
	// gateway sees a renewed certificate (and promotes it) before the relay
	// tunnel switches to it.
	controlReconnect chan struct{}
	// tunnelIdentityPending is set after a renewal; the tunnel is told to
	// switch identities once the gateway accepted the renewed certificate.
	tunnelIdentityPending atomic.Bool
	// sessionReceivedCommand is set by runSession once the gateway sent a
	// command, i.e. accepted the registration. Only the Run loop reads it.
	sessionReceivedCommand bool
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
		controlReconnect:      make(chan struct{}, 1),
	}, nil
}

// Run starts the daemon lifecycle: enroll, connect, session loop.
func (d *DaemonBase) Run(ctx context.Context) error {
	if shutdown, ok := d.plugin.(ShutdownPlugin); ok {
		defer shutdown.Shutdown()
	}
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
		if poolTunnel, poolCapable := relayTunnel.(RelayPoolTunnelPlugin); poolCapable {
			go runProcessRelayPool(ctx, d.connector, poolTunnel, d.state.NodeID, d.tunnelIdentityChanged, d.logger)
		} else {
			go runProcessRelayTunnel(
				ctx,
				d.connector.ConnectWithRetry,
				relayTunnel,
				d.state.NodeID,
				d.tunnelIdentityChanged,
				d.logger,
			)
		}
	}

	// Step 4: Connect and run (with reconnection loop)
	backoff := controlSessionBackoff{}
	for {
		d.sessionReceivedCommand = false
		startedAt := time.Now()
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
			return restart
		}
		var delay time.Duration
		if rejected, ok := err.(*RegistrationRejectedError); ok {
			// Exiting would only let the supervisor restart us every few
			// seconds. Stay up and retry rarely: an operator may restore the
			// node (or re-enroll this host) without touching the daemon.
			delay = backoff.nextRejected()
			d.logger.Error("gateway rejected registration; retrying later", "reason", rejected.Message, "retry_in", delay)
		} else {
			// The relay can remain reachable while its app upstream is
			// restarting, and a gateway can refuse a registration outright.
			// Both end the session immediately without any command, so the
			// transport-level connector backoff is never reached. Back off
			// exponentially until a session is accepted again.
			delay = backoff.next(d.sessionReceivedCommand, time.Since(startedAt))
			d.logger.Warn("session ended, reconnecting", "error", err, "retry_in", delay)
		}
		if !waitForControlSessionReconnectDelay(ctx, delay) {
			return nil
		}
	}
}

const (
	controlSessionMaxReconnectDelay = 60 * time.Second
	// A session shorter than this that never received a command counts as a
	// failed attempt for backoff purposes.
	controlSessionQuickFailure      = 10 * time.Second
	controlSessionRejectedBaseDelay = time.Minute
	controlSessionRejectedMaxDelay  = 30 * time.Minute
)

// controlSessionBackoff grows the reconnect delay while sessions keep failing
// quickly without the gateway ever sending a command, and resets once a
// session was accepted.
type controlSessionBackoff struct {
	failures int
	rejected int
}

func (b *controlSessionBackoff) next(receivedCommand bool, lasted time.Duration) time.Duration {
	b.rejected = 0
	if receivedCommand || lasted >= controlSessionQuickFailure {
		b.failures = 0
		return controlSessionReconnectDelay
	}
	b.failures++
	return exponentialDelay(controlSessionReconnectDelay, b.failures-1, controlSessionMaxReconnectDelay)
}

func (b *controlSessionBackoff) nextRejected() time.Duration {
	b.failures = 0
	b.rejected++
	return exponentialDelay(controlSessionRejectedBaseDelay, b.rejected-1, controlSessionRejectedMaxDelay)
}

func exponentialDelay(base time.Duration, exponent int, max time.Duration) time.Duration {
	delay := base
	for i := 0; i < exponent && delay < max; i++ {
		delay *= 2
	}
	if delay > max {
		return max
	}
	return delay
}

func runProcessRelayPool(
	ctx context.Context,
	connector *connector.Connector,
	plugin RelayPoolTunnelPlugin,
	nodeID string,
	identityChanged <-chan struct{},
	logger *slog.Logger,
) {
	for ctx.Err() == nil {
		laneCount := plugin.RelayTunnelLaneCount()
		if laneCount < 1 {
			laneCount = 1
		}
		if laneCount > 16 {
			laneCount = 16
		}
		targets := plugin.RelayTunnelTargets()
		if len(targets) == 0 {
			targets = []RelayTunnelTarget{{ID: "local"}}
		}
		generationCtx, cancelGeneration := context.WithCancel(ctx)
		ended := make(chan struct{}, len(targets))
		for _, target := range targets {
			target := target
			go func() {
				runRelayPoolTarget(generationCtx, connector, plugin, nodeID, target, laneCount, logger)
				ended <- struct{}{}
			}()
		}
		select {
		case <-ctx.Done():
		case <-identityChanged:
			logger.Info("relay tunnel identity changed, reconnecting pool lanes")
		case <-plugin.RelayTunnelRuntimeChanged():
			logger.Info("relay tunnel targets changed, reconciling pool lanes")
		}
		cancelGeneration()
		for range targets {
			select {
			case <-ended:
			case <-ctx.Done():
				return
			}
		}
	}
}

func runRelayPoolTarget(
	ctx context.Context,
	connector *connector.Connector,
	plugin RelayPoolTunnelPlugin,
	nodeID string,
	target RelayTunnelTarget,
	laneCount int,
	logger *slog.Logger,
) {
	for ctx.Err() == nil {
		connections := make([]*grpc.ClientConn, 0, laneCount)
		for len(connections) < laneCount && ctx.Err() == nil {
			var conn *grpc.ClientConn
			var err error
			if len(target.Addresses) == 0 {
				conn, err = connector.ConnectWithRetry(ctx)
			} else {
				conn, err = connector.ConnectTargetAttempt(ctx, target.Addresses, target.CertificateIdentity, target.CertificateFingerprint)
			}
			if err != nil {
				logger.Warn("relay target lane connection failed", "relay_instance_id", target.ID, "error", err)
				break
			}
			connections = append(connections, conn)
		}
		if len(connections) == 0 {
			if !waitForControlSessionReconnect(ctx) {
				return
			}
			continue
		}
		targetCtx, cancelTarget := context.WithCancel(ctx)
		laneEnded := make(chan struct{}, len(connections))
		for _, conn := range connections {
			conn := conn
			go func() {
				plugin.RunRelayTargetTunnels(targetCtx, conn, nodeID, target.ID)
				laneEnded <- struct{}{}
			}()
		}
		select {
		case <-ctx.Done():
		case <-laneEnded:
		}
		cancelTarget()
		for _, conn := range connections {
			_ = conn.Close()
		}
		if ctx.Err() == nil && !waitForControlSessionReconnect(ctx) {
			return
		}
	}
}

type relayTunnelConnect func(context.Context) (*grpc.ClientConn, error)

const controlSessionReconnectDelay = time.Second

func waitForControlSessionReconnect(ctx context.Context) bool {
	return waitForControlSessionReconnectDelay(ctx, controlSessionReconnectDelay)
}

func waitForControlSessionReconnectDelay(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
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

// requestControlReconnect makes the control session reconnect with the
// current credentials. The relay tunnel switches after the gateway accepted them.
func (d *DaemonBase) requestControlReconnect() {
	d.tunnelIdentityPending.Store(true)
	select {
	case d.controlReconnect <- struct{}{}:
	default:
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
	hostIdentityID, err := loadOrCreateHostIdentity(d.cfg.HostIdentityPath)
	if err != nil {
		return err
	}

	resp, err := enrollment.Enroll(
		d.cfg.Gateway.Address,
		d.cfg.Gateway.Token,
		d.cfg.Gateway.CertSHA256,
		hostname,
		"", // nginxVersion — filled by plugin if applicable
		osInfo,
		Version,
		d.plugin.Type(),
		hostIdentityID,
	)
	if err != nil {
		return err
	}
	if resp.HostIdentityId != "" && resp.HostIdentityId != hostIdentityID {
		return fmt.Errorf("gateway returned a conflicting host identity")
	}

	// Save credentials
	if err := d.saveCertificates(resp.CaCertificate, resp.ClientCertificate, resp.ClientKey); err != nil {
		return fmt.Errorf("save credentials: %w", err)
	}
	if enrollmentPlugin, ok := d.plugin.(EnrollmentBundlePlugin); ok {
		if err := enrollmentPlugin.PersistEnrollmentBundle(resp); err != nil {
			return fmt.Errorf("persist enrollment bundle: %w", err)
		}
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
