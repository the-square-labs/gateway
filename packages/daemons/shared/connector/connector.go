package connector

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"fmt"
	"log/slog"
	"math"
	"math/rand/v2"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/auth"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/tlsbatch"
	"google.golang.org/grpc"
	"google.golang.org/grpc/backoff"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"
)

const (
	// MaxBackoff caps the wait between connection attempts before jitter (Jitter: up to 1.5 times this). A relay or
	// Gateway that comes back after a long outage hears from every node within 15 s: with a 60 s cap the nodes
	// trickled back over 60-70 s after a five-minute outage of the local relay.
	MaxBackoff = 10 * time.Second
	// RestartQuiet is how long failed connection attempts log as information
	// before they warn: a Gateway or relay update restarts it within it.
	RestartQuiet          = time.Minute
	InitialBackoff        = 1 * time.Second
	ConnectAttemptTimeout = 10 * time.Second
	MaxMessageBytes       = 512 * 1024 * 1024
	// relayLaneAckTimeout bounds how long data sent on a relay lane may stay
	// unacknowledged before the lane's connection closes (gRPC sets
	// TCP_USER_TIMEOUT to the keepalive timeout). A relay whose host or path
	// went dark leaves its lanes open but silent: with the control session's
	// 10 s, new tunnels kept trying that relay first and waited out their
	// setup for that long. A closed lane takes the relay out of selection
	// until it connects again. The relay holds its side of the same
	// connections to 2 s (peer liveness), so a lane stalled this long is
	// dropped there anyway.
	relayLaneAckTimeout = 2 * time.Second
	// LaneStreamWindow and LaneConnWindow are a relay lane's HTTP/2 receive
	// windows per stream and per connection; the relay serves its side with
	// the same values.
	LaneStreamWindow = 8 << 20
	LaneConnWindow   = 32 << 20
)

var (
	sessionKeepalive = keepalive.ClientParameters{Time: 30 * time.Second, Timeout: 10 * time.Second, PermitWithoutStream: true}
	laneKeepalive    = keepalive.ClientParameters{Time: 30 * time.Second, Timeout: relayLaneAckTimeout, PermitWithoutStream: true}
)

// ReconnectParams pace grpc's own reconnects of a connection whose transport dropped. Relay lanes and the control
// session keep their ClientConn across a relay restart (an update recreates the local relay), so how fast they come
// back is grpc's reconnect backoff: with its default 1 s base growing by 1.6 the lanes were up again 1-3 s after the
// relay listened again, every Secure Link route answering 502 meanwhile (single-relay install). Starting at 100 ms and
// capping at 5 s brings them back within a few hundred ms, and a relay that stays down is still only retried every
// few seconds. The connect timeout keeps grpc's 20 s: a handshake is never cut by the short backoff.
var ReconnectParams = grpc.ConnectParams{
	Backoff:           backoff.Config{BaseDelay: 100 * time.Millisecond, Multiplier: 1.6, Jitter: 0.2, MaxDelay: 5 * time.Second},
	MinConnectTimeout: 20 * time.Second,
}

type Connector struct {
	Address string
	TLSMgr  *auth.TLSManager
	Logger  *slog.Logger
}

func NewConnector(address string, tlsMgr *auth.TLSManager, logger *slog.Logger) *Connector {
	return &Connector{
		Address: address,
		TLSMgr:  tlsMgr,
		Logger:  logger,
	}
}

// Connect creates a gRPC client connection configured for mTLS.
func (c *Connector) Connect(ctx context.Context) (*grpc.ClientConn, error) {
	return c.connect(ctx, c.Address, "", false)
}

// ConnectTarget creates a relay lane to the pool relay at address.
func (c *Connector) ConnectTarget(ctx context.Context, address, serverName, certificateFingerprint string) (*grpc.ClientConn, error) {
	return c.connectTarget(ctx, address, serverName, certificateFingerprint)
}

func (c *Connector) connectTarget(ctx context.Context, address, serverName, certificateFingerprint string) (*grpc.ClientConn, error) {
	tlsCfg, err := c.TLSMgr.ClientTLSConfig()
	if err != nil {
		return nil, err
	}
	tlsCfg.ServerName = serverName
	tlsCfg.VerifyConnection = func(state tls.ConnectionState) error {
		if len(state.PeerCertificates) == 0 {
			return fmt.Errorf("relay target did not present a certificate")
		}
		digest := sha256.Sum256(state.PeerCertificates[0].Raw)
		actual := "sha256:" + hex.EncodeToString(digest[:])
		if actual != certificateFingerprint {
			return fmt.Errorf("relay target certificate fingerprint mismatch")
		}
		return nil
	}
	return newLane(address, tlsCfg)
}

// newLane dials a relay lane and keeps the socket beneath it (LaneSocket).
func newLane(address string, tlsCfg *tls.Config) (*grpc.ClientConn, error) {
	socket := &LaneSocket{}
	conn, err := grpc.NewClient(address, dialOptionsWith(tlsCfg, true, socket.attach)...)
	if err != nil {
		return nil, err
	}
	laneSockets.Store(conn, socket)
	return conn, nil
}

func (c *Connector) connect(ctx context.Context, address, serverName string, lane bool) (*grpc.ClientConn, error) {
	tlsCfg, err := c.TLSMgr.ClientTLSConfig()
	if err != nil {
		return nil, err
	}

	tlsCfg.ServerName = serverName
	if lane {
		return newLane(address, tlsCfg)
	}
	conn, err := grpc.NewClient(address, dialOptions(tlsCfg, lane)...)
	if err != nil {
		return nil, err
	}
	return conn, nil
}

// LaneDialOptions are the options of a relay lane over tlsCfg (the relay's
// throughput tests dial with them).
func LaneDialOptions(tlsCfg *tls.Config) []grpc.DialOption { return dialOptions(tlsCfg, true) }

// dialOptions configures a control session or, with lane set, a relay lane:
// a lane is never left idle (it stays connected for the life of the process
// and is selected by whether it is connected) and is closed once the relay
// stops acknowledging it.
func dialOptions(tlsCfg *tls.Config, lane bool) []grpc.DialOption {
	return dialOptionsWith(tlsCfg, lane, nil)
}

// dialOptionsWith is dialOptions whose lane hands each new socket to dialed.
func dialOptionsWith(tlsCfg *tls.Config, lane bool, dialed func(*tlsbatch.Conn)) []grpc.DialOption {
	keepaliveParams := sessionKeepalive
	if lane {
		keepaliveParams = laneKeepalive
	}
	transportCredentials := credentials.NewTLS(tlsCfg)
	if lane {
		transportCredentials = tlsbatch.CredentialsWithHook(transportCredentials, dialed)
	}
	options := []grpc.DialOption{
		grpc.WithTransportCredentials(transportCredentials),
		grpc.WithConnectParams(ReconnectParams),
		grpc.WithKeepaliveParams(keepaliveParams),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(MaxMessageBytes),
			grpc.MaxCallSendMsgSize(MaxMessageBytes),
		),
	}
	if lane {
		options = append(options, grpc.WithIdleTimeout(0),
			// A bulk stream's frames leave in writes of up to 256 KiB, one
			// send each (tlsbatch); the buffer is pooled while the lane is idle.
			grpc.WithWriteBufferSize(tlsbatch.WriteBuffer), grpc.WithSharedWriteBuffer(true),
			// Fixed HTTP/2 windows: gRPC's BDP estimator grows a connection's
			// windows only on a new maximum of measured bandwidth, so a lane
			// that once carried LAN traffic kept LAN-sized windows when its
			// round trip grew and carried under 0.5 MB/s at 300 ms. Setting
			// them turns the estimator off.
			grpc.WithInitialWindowSize(LaneStreamWindow), grpc.WithInitialConnWindowSize(LaneConnWindow))
	}
	return options
}

func (c *Connector) ConnectTargetAttempt(ctx context.Context, addresses []string, serverName, certificateFingerprint string) (*grpc.ClientConn, error) {
	var lastErr error
	for _, address := range addresses {
		conn, err := c.ConnectTarget(ctx, address, serverName, certificateFingerprint)
		if err == nil {
			attemptCtx, cancel := context.WithTimeout(ctx, ConnectAttemptTimeout)
			err = waitUntilReady(attemptCtx, conn)
			cancel()
			if err == nil {
				return conn, nil
			}
			_ = conn.Close()
			ForgetLane(conn)
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("relay target has no addresses")
	}
	return nil, lastErr
}

// ConnectWithRetry retries connection with exponential backoff + jitter.
func (c *Connector) ConnectWithRetry(ctx context.Context) (*grpc.ClientConn, error) {
	return c.connectWithRetry(ctx, false)
}

// ConnectLaneWithRetry is ConnectWithRetry for a relay lane to the relay at
// the Gateway address (the local relay).
func (c *Connector) ConnectLaneWithRetry(ctx context.Context) (*grpc.ClientConn, error) {
	return c.connectWithRetry(ctx, true)
}

func (c *Connector) connectWithRetry(ctx context.Context, lane bool) (*grpc.ClientConn, error) {
	backoff := InitialBackoff
	failingSince := time.Time{}
	for {
		conn, err := c.connect(ctx, c.Address, "", lane)
		if err == nil {
			attemptCtx, cancel := context.WithTimeout(ctx, ConnectAttemptTimeout)
			err = waitUntilReady(attemptCtx, conn)
			cancel()
			if err == nil {
				return conn, nil
			}
			_ = conn.Close()
			ForgetLane(conn)
		}

		delay := Jitter(backoff, rand.Float64)
		if failingSince.IsZero() {
			failingSince = time.Now()
		}
		log := c.Logger.Warn
		if time.Since(failingSince) < RestartQuiet {
			// A Gateway or relay restarting for its update refuses
			// connections for a while (rc.11 upgrade run N-2: "connection
			// refused" at every Gateway restart); a longer outage warns.
			log = c.Logger.Info
		}
		log("connection failed, retrying",
			"error", err,
			"attempt_timeout", ConnectAttemptTimeout,
			"backoff", delay.Round(time.Millisecond),
		)

		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(delay):
		}

		backoff = NextBackoff(backoff)
	}
}

// NextBackoff doubles a retry backoff up to MaxBackoff.
func NextBackoff(backoff time.Duration) time.Duration {
	return time.Duration(math.Min(float64(backoff)*2, float64(MaxBackoff)))
}

// Jitter spreads a backoff over 0.5 to 1.5 times its value (random draws from [0, 1)), so nodes that lost the same
// relay or Gateway do not all retry in the same instant.
func Jitter(backoff time.Duration, random func() float64) time.Duration {
	return time.Duration(float64(backoff) * (0.5 + random()))
}

func waitUntilReady(ctx context.Context, conn *grpc.ClientConn) error {
	conn.Connect()

	for {
		state := conn.GetState()
		switch state {
		case connectivity.Ready:
			return nil
		case connectivity.Idle:
			conn.Connect()
		case connectivity.Shutdown:
			return fmt.Errorf("connection shut down before becoming ready")
		}

		if !conn.WaitForStateChange(ctx, state) {
			if err := ctx.Err(); err != nil {
				return err
			}
			return fmt.Errorf("timed out waiting for connection to become ready")
		}
	}
}

// OpenCommandStream opens the bidirectional CommandStream RPC.
func OpenCommandStream(ctx context.Context, conn *grpc.ClientConn) (pb.NodeControl_CommandStreamClient, error) {
	client := pb.NewNodeControlClient(conn)
	return client.CommandStream(ctx)
}

// OpenLogStream opens the bidirectional LogStream RPC.
func OpenLogStream(ctx context.Context, conn *grpc.ClientConn) (pb.LogStream_StreamLogsClient, error) {
	client := pb.NewLogStreamClient(conn)
	return client.StreamLogs(ctx)
}

// OpenMigrationTransferStream opens the dedicated bidirectional artifact RPC.
func OpenMigrationTransferStream(ctx context.Context, conn *grpc.ClientConn) (pb.MigrationTransfer_TransferClient, error) {
	client := pb.NewMigrationTransferClient(conn)
	return client.Transfer(ctx)
}
