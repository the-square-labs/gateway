package supervisor

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"sync"
	"syscall"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay-supervisor/internal/config"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/protobuf/proto"
)

type workerManager struct {
	cfg                config.WorkerConfig
	enrollmentStateDir string
	mu                 sync.Mutex
	process            *exec.Cmd
	processDone        chan struct{}
	clientConn         *grpc.ClientConn
	client             relayv1.RelayAdminClient
	state              *enrollmentState
	lastError          string
	updateMu           sync.Mutex
}

func newWorkerManager(cfg config.WorkerConfig, enrollmentStateDir string) *workerManager {
	return &workerManager{cfg: cfg, enrollmentStateDir: enrollmentStateDir}
}

func (m *workerManager) ensureRunning() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.process != nil && m.process.Process != nil {
		return nil
	}
	state, err := loadEnrollmentState(m.enrollmentStateDir)
	if err != nil {
		return fmt.Errorf("load relay enrollment state: %w", err)
	}
	if _, err := os.Stat(m.cfg.BinaryPath); err != nil {
		return fmt.Errorf("relay worker binary: %w", err)
	}
	cmd := exec.Command(m.cfg.BinaryPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = append(os.Environ(),
		"RELAY_MODE=remote",
		"RELAY_POOL_ID="+state.PoolID,
		"RELAY_INSTANCE_ID="+state.InstanceID,
		"RELAY_PORT="+strconv.Itoa(m.cfg.ServicePort),
		"RELAY_IDENTITY_DIR="+m.cfg.IdentityDir,
		"RELAY_STATE_DIR="+m.cfg.StateDir,
	)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start relay worker: %w", err)
	}
	m.process = cmd
	done := make(chan struct{})
	m.processDone = done
	m.state = state
	m.lastError = ""
	go func(expected *exec.Cmd) {
		err := expected.Wait()
		close(done)
		m.mu.Lock()
		var conn *grpc.ClientConn
		if m.process == expected {
			m.process = nil
			m.processDone = nil
			conn = m.clientConn
			m.client = nil
			m.clientConn = nil
			if err != nil {
				m.lastError = err.Error()
			}
		}
		m.mu.Unlock()
		if conn != nil {
			_ = conn.Close()
		}
	}(cmd)
	return nil
}

func (m *workerManager) connectAdmin(ctx context.Context) (relayv1.RelayAdminClient, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.client != nil {
		return m.client, nil
	}
	if m.state == nil {
		state, err := loadEnrollmentState(m.enrollmentStateDir)
		if err != nil {
			return nil, err
		}
		m.state = state
	}
	caPEM, err := os.ReadFile(filepath.Join(m.cfg.IdentityDir, "system-ca.crt"))
	if err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("relay worker system CA is invalid")
	}
	certificate, err := tls.LoadX509KeyPair(
		filepath.Join(m.cfg.IdentityDir, "app-relay-client.crt"),
		filepath.Join(m.cfg.IdentityDir, "app-relay-client.key"),
	)
	if err != nil {
		return nil, err
	}
	conn, err := grpc.NewClient(
		fmt.Sprintf("127.0.0.1:%d", m.cfg.ServicePort),
		grpc.WithTransportCredentials(credentials.NewTLS(&tls.Config{
			MinVersion: tls.VersionTLS13, RootCAs: roots, Certificates: []tls.Certificate{certificate}, ServerName: m.state.RelayServerIdentity,
		})),
	)
	if err != nil {
		return nil, err
	}
	m.clientConn = conn
	m.client = relayv1.NewRelayAdminClient(conn)
	return m.client, nil
}

func (m *workerManager) bootstrapTrust(ctx context.Context) error {
	client, err := m.connectAdmin(ctx)
	if err != nil {
		return err
	}
	m.mu.Lock()
	state := *m.state
	m.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err = client.BootstrapPolicyTrust(ctx, &relayv1.BootstrapPolicyTrustRequest{
		KeyId: state.PolicySigningKeyID, PublicKey: state.PolicySigningPublicKey,
		PublicKeyFingerprint: state.PolicySigningFingerprint,
	})
	return err
}

func (m *workerManager) applyPolicy(ctx context.Context, encoded []byte) (*relayv1.ApplySnapshotResponse, error) {
	request := &relayv1.ApplySnapshotRequest{}
	if err := proto.Unmarshal(encoded, request); err != nil {
		return nil, fmt.Errorf("decode relay policy snapshot: %w", err)
	}
	client, err := m.connectAdmin(ctx)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return client.ApplySnapshot(ctx, request)
}

func (m *workerManager) setDrain(ctx context.Context, enabled, forceDisconnect bool) error {
	client, err := m.connectAdmin(ctx)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	_, err = client.SetDrain(ctx, &relayv1.SetDrainRequest{Draining: enabled, ForceDisconnect: forceDisconnect})
	return err
}

func (m *workerManager) health(ctx context.Context) (*relayv1.HealthResponse, error) {
	client, err := m.connectAdmin(ctx)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return client.GetHealth(ctx, &relayv1.HealthRequest{})
}

func (m *workerManager) update(
	ctx context.Context,
	downloadURL string,
	targetVersion string,
	checksum string,
	signedManifest string,
	logger *slog.Logger,
) error {
	m.updateMu.Lock()
	defer m.updateMu.Unlock()

	m.shutdown()
	if err := lifecycle.ReplaceBinaryAtPath(
		downloadURL,
		targetVersion,
		checksum,
		signedManifest,
		"relay-worker",
		m.cfg.BinaryPath,
		logger,
	); err != nil {
		_ = m.ensureRunning()
		return err
	}

	if err := m.waitReadyVersion(ctx, targetVersion, 30*time.Second); err != nil {
		return fmt.Errorf("relay worker did not become ready after update: %w", err)
	}
	return nil
}

func (m *workerManager) waitReadyVersion(ctx context.Context, targetVersion string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var lastErr error
	for time.Now().Before(deadline) {
		if err := m.ensureRunning(); err != nil {
			lastErr = err
		} else if err := m.bootstrapTrust(ctx); err != nil {
			lastErr = err
		} else if health, err := m.health(ctx); err != nil {
			lastErr = err
		} else if !health.GetReadiness() {
			lastErr = fmt.Errorf("worker is not ready: %s", health.GetReason())
		} else if targetVersion != "" && health.GetBuildVersion() != targetVersion {
			lastErr = fmt.Errorf("worker reported version %s, expected %s", health.GetBuildVersion(), targetVersion)
		} else {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	return fmt.Errorf("worker did not become ready before deadline: %w", lastErr)
}

func (m *workerManager) shutdown() {
	m.mu.Lock()
	process := m.process
	done := m.processDone
	conn := m.clientConn
	m.client = nil
	m.clientConn = nil
	m.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
	if process != nil && process.Process != nil {
		_ = process.Process.Signal(syscall.SIGTERM)
		if done == nil {
			return
		}
		select {
		case <-done:
			return
		case <-time.After(10 * time.Second):
			_ = process.Process.Kill()
		}
		select {
		case <-done:
		case <-time.After(2 * time.Second):
		}
	}
}
