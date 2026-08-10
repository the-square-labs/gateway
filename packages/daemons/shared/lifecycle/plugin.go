package lifecycle

import (
	"context"
	"log/slog"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/stream"
	"google.golang.org/grpc"
)

// FatalError is returned when the daemon must exit and NOT retry.
type FatalError struct {
	Message string
}

func (e *FatalError) Error() string {
	return e.Message
}

// RestartRequestedError is returned when the daemon should exit immediately
// so its supervisor can restart it (e.g. after a successful self-update).
type RestartRequestedError struct {
	Message string
}

func (e *RestartRequestedError) Error() string {
	return e.Message
}

// DaemonPlugin defines the interface that daemon-specific logic must implement.
// The lifecycle manager calls these methods at appropriate points in the
// enrollment, connection, and session lifecycle.
type DaemonPlugin interface {
	// Type returns the daemon type string (e.g., "nginx", "monitoring").
	Type() string

	// Init is called once at startup to initialize plugin-specific resources.
	Init(cfg *BaseConfig, logger *slog.Logger) error

	// BuildRegisterMessage constructs the registration message sent to the
	// gateway when a new session begins.
	BuildRegisterMessage(nodeID string) *pb.RegisterMessage

	// HandleCommand processes a gateway command and returns a result.
	HandleCommand(cmd *pb.GatewayCommand) *pb.CommandResult

	// CollectHealth enriches a base health report with plugin-specific metrics.
	// The base report already contains system-level metrics.
	CollectHealth(base *pb.HealthReport) *pb.HealthReport

	// CollectStats returns plugin-specific statistics, or nil if not applicable.
	CollectStats() *pb.StatsReport

	// OnSessionStart is called when a new gRPC session is established.
	// Plugins can use this to start background tasks tied to the session.
	// The writer allows plugins to send asynchronous messages (e.g. exec output).
	OnSessionStart(ctx context.Context, writer *stream.Writer) error

	// OnSessionEnd is called when a gRPC session ends (before reconnect).
	// Plugins should clean up session-specific resources.
	OnSessionEnd()

	// SetLogger replaces the plugin's logger (called when session logger is created).
	SetLogger(logger *slog.Logger)
}

// LogStreamPlugin is implemented by plugins that maintain a separate
// bidirectional log stream beside the command stream.
type LogStreamPlugin interface {
	RunLogStream(ctx context.Context, conn *grpc.ClientConn)
}

// MigrationStreamPlugin is implemented by Docker plugins that maintain the
// separately authenticated migration artifact stream.
type MigrationStreamPlugin interface {
	RunMigrationStream(ctx context.Context, conn *grpc.ClientConn, nodeID string)
}

// RelayTunnelPlugin is implemented by daemons that consume generic, signed
// relay assignments using their process-lifetime mTLS connection.
type RelayTunnelPlugin interface {
	RunRelayTunnels(ctx context.Context, conn *grpc.ClientConn, nodeID string)
	SyncRelayGrants(command *pb.SyncRelayGrantsCommand) (detail string, err error)
}

// ProxySecureLinkPlugin is implemented by nginx and general Docker daemons.
// The command is a complete desired-state snapshot, so reconnects and daemon
// restarts can reconcile listeners and connector bindings idempotently.
type ProxySecureLinkPlugin interface {
	SyncProxySecureLinks(command *pb.SyncProxySecureLinksCommand) (detail string, err error)
}

// ProxySecureLinkProbePlugin is implemented only by nginx-daemon, which owns
// the loopback source listener used for full-path HTTP health probes.
type ProxySecureLinkProbePlugin interface {
	ProbeProxySecureLink(command *pb.ProbeProxySecureLinkCommand) (detail string, err error)
}
