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
	"google.golang.org/grpc"
	"google.golang.org/grpc/connectivity"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/keepalive"
)

const (
	MaxBackoff            = 60 * time.Second
	InitialBackoff        = 1 * time.Second
	ConnectAttemptTimeout = 10 * time.Second
	MaxMessageBytes       = 512 * 1024 * 1024
)

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
	return c.connect(ctx, c.Address, "")
}

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
	return grpc.NewClient(address,
		grpc.WithTransportCredentials(credentials.NewTLS(tlsCfg)),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time: 30 * time.Second, Timeout: 10 * time.Second, PermitWithoutStream: true,
		}),
		grpc.WithDefaultCallOptions(grpc.MaxCallRecvMsgSize(MaxMessageBytes), grpc.MaxCallSendMsgSize(MaxMessageBytes)),
	)
}

func (c *Connector) connect(ctx context.Context, address, serverName string) (*grpc.ClientConn, error) {
	tlsCfg, err := c.TLSMgr.ClientTLSConfig()
	if err != nil {
		return nil, err
	}

	tlsCfg.ServerName = serverName
	conn, err := grpc.NewClient(address,
		grpc.WithTransportCredentials(credentials.NewTLS(tlsCfg)),
		grpc.WithKeepaliveParams(keepalive.ClientParameters{
			Time:                30 * time.Second,
			Timeout:             10 * time.Second,
			PermitWithoutStream: true,
		}),
		grpc.WithDefaultCallOptions(
			grpc.MaxCallRecvMsgSize(MaxMessageBytes),
			grpc.MaxCallSendMsgSize(MaxMessageBytes),
		),
	)
	if err != nil {
		return nil, err
	}
	return conn, nil
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
	backoff := InitialBackoff
	for {
		conn, err := c.Connect(ctx)
		if err == nil {
			attemptCtx, cancel := context.WithTimeout(ctx, ConnectAttemptTimeout)
			err = waitUntilReady(attemptCtx, conn)
			cancel()
			if err == nil {
				return conn, nil
			}
			_ = conn.Close()
		}

		c.Logger.Warn("connection failed, retrying",
			"error", err,
			"attempt_timeout", ConnectAttemptTimeout,
			"backoff", backoff,
		)

		// Add jitter: 0.5x to 1.5x
		jitter := time.Duration(float64(backoff) * (0.5 + rand.Float64()))
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(jitter):
		}

		backoff = time.Duration(math.Min(float64(backoff)*2, float64(MaxBackoff)))
	}
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
