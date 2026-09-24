package supervisor

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

const (
	workerServerCertificate         = "external-server.crt"
	workerServerKey                 = "external-server.key"
	workerPreviousServerCertificate = "external-server.previous.crt"
	workerPreviousServerKey         = "external-server.previous.key"
	workerAdminClientCertificate    = "app-relay-client.crt"
	workerAdminClientKey            = "app-relay-client.key"
	workerAppClientCertificate      = "relay-app-client.crt"
	workerAppClientKey              = "relay-app-client.key"
	workerTrustManifest             = "trust-manifest.json"
	workerIdentityUpdatingMarker    = ".updating"
	adminClientSyncInterval         = 10 * time.Minute
	workerRestartReadyTimeout       = 30 * time.Second
)

// errNoIdentityChange means the worker already holds the material.
var errNoIdentityChange = errors.New("relay worker identity is already current")

func fingerprintDER(der []byte) string {
	digest := sha256.Sum256(der)
	return "sha256:" + hex.EncodeToString(digest[:])
}

func pemFingerprint(certificatePEM []byte) (string, *x509.Certificate, error) {
	block, _ := pem.Decode(certificatePEM)
	if block == nil || block.Type != "CERTIFICATE" {
		return "", nil, fmt.Errorf("certificate is not PEM encoded")
	}
	certificate, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return "", nil, err
	}
	return fingerprintDER(block.Bytes), certificate, nil
}

func systemRoots(identityDir string) (*x509.CertPool, error) {
	caPEM, err := os.ReadFile(filepath.Join(identityDir, "system-ca.crt"))
	if err != nil {
		return nil, err
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("relay worker system CA is invalid")
	}
	return roots, nil
}

// verifiedPair checks that a certificate/key pair belongs together, chains to
// the system CA for the given usage and is valid now.
func verifiedPair(certificatePEM, keyPEM []byte, roots *x509.CertPool, usage x509.ExtKeyUsage, serverName string, now time.Time) (string, error) {
	if _, err := tls.X509KeyPair(certificatePEM, keyPEM); err != nil {
		return "", fmt.Errorf("certificate and key do not match: %w", err)
	}
	fingerprint, leaf, err := pemFingerprint(certificatePEM)
	if err != nil {
		return "", err
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, KeyUsages: []x509.ExtKeyUsage{usage}, DNSName: serverName, CurrentTime: now}); err != nil {
		return "", fmt.Errorf("certificate is not valid for the relay: %w", err)
	}
	return fingerprint, nil
}

type identityFile struct {
	name    string
	content []byte
	mode    os.FileMode
}

// stagedWorkerIdentity is the worker identity material a renewal writes.
type stagedWorkerIdentity struct {
	files       []identityFile
	removals    []string
	adminChange bool
}

// planWorkerIdentity decides what the worker identity directory needs: a
// renewed server certificate (keeping the one daemons pin as "previous"),
// and/or the supervisor's current client certificate as its admin client.
func planWorkerIdentity(identityDir string, renewal *pb.RenewRelayIdentityCommand, adminCertificate, adminKey []byte, now time.Time) (*stagedWorkerIdentity, error) {
	roots, err := systemRoots(identityDir)
	if err != nil {
		return nil, err
	}
	plan := &stagedWorkerIdentity{}
	if renewal != nil {
		if renewal.GetServerIdentity() == "" {
			return nil, fmt.Errorf("renewed relay server identity is required")
		}
		renewed, err := verifiedPair(renewal.GetServerCertificate(), renewal.GetServerKey(), roots, x509.ExtKeyUsageServerAuth, renewal.GetServerIdentity(), now)
		if err != nil {
			return nil, fmt.Errorf("renewed relay server certificate: %w", err)
		}
		// Keep the certificate daemons pin, whichever file holds it now.
		var retained *[2][]byte
		for _, pair := range [][2]string{{workerServerCertificate, workerServerKey}, {workerPreviousServerCertificate, workerPreviousServerKey}} {
			certificatePEM, certErr := os.ReadFile(filepath.Join(identityDir, pair[0]))
			keyPEM, keyErr := os.ReadFile(filepath.Join(identityDir, pair[1]))
			if certErr != nil || keyErr != nil {
				continue
			}
			fingerprint, leaf, parseErr := pemFingerprint(certificatePEM)
			if parseErr != nil || fingerprint != renewal.GetRetainServerFingerprint() || fingerprint == renewed || !now.Before(leaf.NotAfter) {
				continue
			}
			retained = &[2][]byte{certificatePEM, keyPEM}
			break
		}
		if retained != nil {
			plan.files = append(plan.files,
				identityFile{workerPreviousServerCertificate, retained[0], 0o644},
				identityFile{workerPreviousServerKey, retained[1], 0o600},
			)
		} else {
			plan.removals = append(plan.removals, workerPreviousServerCertificate, workerPreviousServerKey)
		}
		plan.files = append(plan.files,
			identityFile{workerServerCertificate, renewal.GetServerCertificate(), 0o644},
			identityFile{workerServerKey, renewal.GetServerKey(), 0o600},
		)
	}
	if len(adminCertificate) > 0 {
		adminFingerprint, err := verifiedPair(adminCertificate, adminKey, roots, x509.ExtKeyUsageClientAuth, "", now)
		if err != nil {
			return nil, fmt.Errorf("relay supervisor client certificate: %w", err)
		}
		currentPEM, readErr := os.ReadFile(filepath.Join(identityDir, workerAdminClientCertificate))
		current := ""
		if readErr == nil {
			current, _, _ = pemFingerprint(currentPEM)
		}
		if current != adminFingerprint {
			plan.adminChange = true
			trust, _ := json.Marshal(map[string]any{
				"version": 1, "appRelayClientFingerprint": adminFingerprint, "relayAppClientFingerprint": adminFingerprint,
			})
			plan.files = append(plan.files,
				identityFile{workerAdminClientCertificate, adminCertificate, 0o644},
				identityFile{workerAdminClientKey, adminKey, 0o600},
				identityFile{workerAppClientCertificate, adminCertificate, 0o644},
				identityFile{workerAppClientKey, adminKey, 0o600},
				identityFile{workerTrustManifest, trust, 0o600},
			)
		}
	}
	if len(plan.files) == 0 && len(plan.removals) == 0 {
		return nil, errNoIdentityChange
	}
	return plan, nil
}

// writeWorkerIdentity writes the plan under the worker's update marker, so a
// worker that reads its identity meanwhile waits instead of loading a mix.
func writeWorkerIdentity(identityDir string, plan *stagedWorkerIdentity) error {
	marker := filepath.Join(identityDir, workerIdentityUpdatingMarker)
	if err := os.WriteFile(marker, []byte(fmt.Sprintf("%d\n", os.Getpid())), 0o600); err != nil {
		return err
	}
	defer os.Remove(marker)
	for _, file := range plan.files {
		if err := atomicWrite(filepath.Join(identityDir, file.name), file.content, file.mode); err != nil {
			return err
		}
	}
	for _, name := range plan.removals {
		if err := os.Remove(filepath.Join(identityDir, name)); err != nil && !os.IsNotExist(err) {
			return err
		}
	}
	return nil
}

func randomOperationID() string {
	value := make([]byte, 16)
	_, _ = rand.Read(value)
	return hex.EncodeToString(value)
}

// renewIdentity installs a renewed server certificate on the worker and
// returns the fingerprint the worker now serves for the renewed identity.
func (m *workerManager) renewIdentity(ctx context.Context, renewal *pb.RenewRelayIdentityCommand, adminCertificatePath, adminKeyPath string) (string, error) {
	m.updateMu.Lock()
	defer m.updateMu.Unlock()
	adminCertificate, adminKey := readOptionalPair(adminCertificatePath, adminKeyPath)
	plan, err := planWorkerIdentity(m.cfg.IdentityDir, renewal, adminCertificate, adminKey, time.Now())
	if err != nil && !errors.Is(err, errNoIdentityChange) {
		return "", err
	}
	if plan != nil {
		if err := writeWorkerIdentity(m.cfg.IdentityDir, plan); err != nil {
			return "", fmt.Errorf("write relay worker identity: %w", err)
		}
		if err := m.applyStagedIdentity(ctx, renewal.GetServerIdentity()); err != nil {
			return "", err
		}
	}
	served, err := m.servedServerFingerprint(ctx, renewal.GetServerIdentity())
	if err != nil {
		return "", fmt.Errorf("relay worker does not serve the renewed certificate: %w", err)
	}
	expected, _, _ := pemFingerprint(renewal.GetServerCertificate())
	if served != expected {
		return "", fmt.Errorf("relay worker serves %s for %s, expected %s", served, renewal.GetServerIdentity(), expected)
	}
	return served, nil
}

// syncAdminClient keeps the worker's admin client on the supervisor's current
// certificate, which the daemon lifecycle renews before it expires. Skipped
// while a worker update or renewal holds the worker.
func (m *workerManager) syncAdminClient(ctx context.Context, adminCertificatePath, adminKeyPath string) error {
	if !m.updateMu.TryLock() {
		return nil
	}
	defer m.updateMu.Unlock()
	adminCertificate, adminKey := readOptionalPair(adminCertificatePath, adminKeyPath)
	if len(adminCertificate) == 0 {
		return nil
	}
	plan, err := planWorkerIdentity(m.cfg.IdentityDir, nil, adminCertificate, adminKey, time.Now())
	if errors.Is(err, errNoIdentityChange) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := writeWorkerIdentity(m.cfg.IdentityDir, plan); err != nil {
		return err
	}
	return m.applyStagedIdentity(ctx, "")
}

func readOptionalPair(certificatePath, keyPath string) ([]byte, []byte) {
	if certificatePath == "" || keyPath == "" {
		return nil, nil
	}
	certificatePEM, certErr := os.ReadFile(certificatePath)
	keyPEM, keyErr := os.ReadFile(keyPath)
	if certErr != nil || keyErr != nil {
		return nil, nil
	}
	return certificatePEM, keyPEM
}

// applyStagedIdentity makes the running worker load the staged files. A live
// reload keeps every tunnel; the admin client that is still trusted asks for
// it, and the new admin client then commits the rotation. Only when the
// worker cannot be asked (not running, or its admin client expired) is it
// restarted onto the new files.
func (m *workerManager) applyStagedIdentity(ctx context.Context, serverIdentity string) error {
	operationID := randomOperationID()
	reloadErr := func() error {
		client, err := m.connectAdmin(ctx)
		if err != nil {
			return err
		}
		callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		_, err = client.ReloadIdentity(callCtx, &relayv1.ReloadIdentityRequest{OperationId: operationID})
		return err
	}()
	if serverIdentity != "" {
		if err := m.setServerIdentity(serverIdentity); err != nil {
			return err
		}
	}
	m.resetAdminClient()
	if reloadErr != nil {
		m.shutdown()
		if err := m.ensureRunning(); err != nil {
			return fmt.Errorf("restart relay worker with renewed identity: %w", err)
		}
		deadline := time.Now().Add(workerRestartReadyTimeout)
		for {
			if _, err := m.health(ctx); err == nil {
				return nil
			} else if time.Now().After(deadline) {
				return fmt.Errorf("relay worker did not come back after an identity restart: %w", err)
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(500 * time.Millisecond):
			}
		}
	}
	client, err := m.connectAdmin(ctx)
	if err != nil {
		return err
	}
	callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err := client.CommitIdentityRotation(callCtx, &relayv1.CommitIdentityRotationRequest{OperationId: operationID}); err != nil {
		// The previous admin client stays trusted until a commit; nothing is lost.
		return fmt.Errorf("commit relay worker identity rotation: %w", err)
	}
	return nil
}

// setServerIdentity records the identity the supervisor asks its worker for.
func (m *workerManager) setServerIdentity(identity string) error {
	state, err := loadEnrollmentState(m.enrollmentStateDir)
	if err != nil {
		return err
	}
	state.RelayServerIdentity = identity
	encoded, err := json.Marshal(state)
	if err != nil {
		return err
	}
	if err := atomicWrite(filepath.Join(m.enrollmentStateDir, "enrollment.json"), encoded, 0o600); err != nil {
		return err
	}
	m.mu.Lock()
	m.state = state
	m.mu.Unlock()
	return nil
}

func (m *workerManager) resetAdminClient() {
	m.mu.Lock()
	conn := m.clientConn
	m.client = nil
	m.clientConn = nil
	m.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

// servedServerFingerprint completes a TLS handshake with the worker as a
// daemon does for serverName and returns the certificate it was given.
func (m *workerManager) servedServerFingerprint(ctx context.Context, serverName string) (string, error) {
	roots, err := systemRoots(m.cfg.IdentityDir)
	if err != nil {
		return "", err
	}
	certificate, err := tls.LoadX509KeyPair(
		filepath.Join(m.cfg.IdentityDir, workerAdminClientCertificate),
		filepath.Join(m.cfg.IdentityDir, workerAdminClientKey),
	)
	if err != nil {
		return "", err
	}
	dialer := &tls.Dialer{Config: &tls.Config{
		MinVersion: tls.VersionTLS13, RootCAs: roots, ServerName: serverName,
		Certificates: []tls.Certificate{certificate}, NextProtos: []string{"h2"},
	}}
	dialCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	conn, err := dialer.DialContext(dialCtx, "tcp", fmt.Sprintf("127.0.0.1:%d", m.cfg.ServicePort))
	if err != nil {
		return "", err
	}
	defer conn.Close()
	peers := conn.(*tls.Conn).ConnectionState().PeerCertificates
	if len(peers) == 0 {
		return "", fmt.Errorf("relay worker presented no certificate")
	}
	return fingerprintDER(peers[0].Raw), nil
}
