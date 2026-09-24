package supervisor

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	"github.com/wiolett-industries/gateway/daemon-shared/lifecycle"
	"github.com/wiolett-industries/gateway/relay-supervisor/internal/config"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func enrolledBaseConfig(t *testing.T, token string) *lifecycle.BaseConfig {
	t.Helper()
	dir := t.TempDir()
	cfg := &lifecycle.BaseConfig{}
	cfg.Gateway.Token = token
	cfg.TLS.CACert = filepath.Join(dir, "ca.pem")
	cfg.TLS.ClientCert = filepath.Join(dir, "node.pem")
	cfg.TLS.ClientKey = filepath.Join(dir, "node-key.pem")
	for _, path := range identityPaths(cfg) {
		if err := os.WriteFile(path, []byte("previous "+filepath.Base(path)), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return cfg
}

func TestBeginReenrollmentOnlyWithTokenWhileEnrolled(t *testing.T) {
	cfg := enrolledBaseConfig(t, "")
	if reenrollment, err := BeginReenrollment(cfg); err != nil || reenrollment != nil {
		t.Fatalf("re-enrollment started without a token: %v %v", reenrollment, err)
	}
	if !cfg.IsEnrolled() {
		t.Fatal("identity was moved without a token")
	}
}

// A rejected or failed enrollment must leave the relay with the identity it had.
func TestFailedReenrollmentRestoresPreviousIdentity(t *testing.T) {
	cfg := enrolledBaseConfig(t, "token")
	reenrollment, err := BeginReenrollment(cfg)
	if err != nil || reenrollment == nil {
		t.Fatalf("re-enrollment did not start: %v", err)
	}
	if cfg.IsEnrolled() {
		t.Fatal("the lifecycle would not enroll while the identity is in place")
	}
	// A partial enrollment wrote one new file before failing.
	if err := os.WriteFile(cfg.TLS.CACert, []byte("partial"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := reenrollment.Restore(); err != nil {
		t.Fatal(err)
	}
	for _, path := range identityPaths(cfg) {
		content, err := os.ReadFile(path)
		if err != nil || string(content) != "previous "+filepath.Base(path) {
			t.Fatalf("%s was not restored: %q %v", path, content, err)
		}
	}
}

func TestInterruptedReenrollmentIsRestoredOnStart(t *testing.T) {
	cfg := enrolledBaseConfig(t, "token")
	if _, err := BeginReenrollment(cfg); err != nil {
		t.Fatal(err)
	}
	// The process died before it restored or committed anything.
	if err := RecoverInterruptedReenrollment(cfg); err != nil {
		t.Fatal(err)
	}
	if !cfg.IsEnrolled() {
		t.Fatal("interrupted re-enrollment left the supervisor without an identity")
	}
}

func TestEnrollmentTokenRejectedClassifiesGatewayRefusals(t *testing.T) {
	wrapped := fmt.Errorf("enrollment: %w", fmt.Errorf("enrollment failed: %w", status.Error(codes.Unauthenticated, "Invalid enrollment token")))
	if !EnrollmentTokenRejected(wrapped) {
		t.Fatal("an invalid token was not treated as rejected")
	}
	if EnrollmentTokenRejected(fmt.Errorf("enrollment: %w", status.Error(codes.Unavailable, "connection refused"))) {
		t.Fatal("an unreachable Gateway was treated as a rejected token")
	}
}

// Enrollment is what authorizes policy trust. A relay locked out with trust
// only in keys Gateway destroyed is repaired by enrolling again: the worker's
// pinned trust and identity rotation state are moved aside and the stashed
// supervisor identity is dropped.
func TestPersistEnrollmentBundleResetsWorkerPolicyTrust(t *testing.T) {
	root := t.TempDir()
	base := enrolledBaseConfig(t, "token")
	cfg := &config.Config{BaseConfig: *base}
	cfg.StateDir = filepath.Join(root, "state")
	cfg.Worker.IdentityDir = filepath.Join(root, "worker-identity")
	cfg.Worker.StateDir = filepath.Join(root, "worker-state")
	if err := os.MkdirAll(cfg.Worker.StateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"relay.db", "identity-rotation.json"} {
		if err := os.WriteFile(filepath.Join(cfg.Worker.StateDir, name), []byte("old"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := BeginReenrollment(&cfg.BaseConfig); err != nil {
		t.Fatal(err)
	}
	// The lifecycle saved the new identity before handing over the bundle.
	for _, path := range identityPaths(&cfg.BaseConfig) {
		if err := os.WriteFile(path, []byte("new"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	plugin := New(cfg)
	if err := plugin.PersistEnrollmentBundle(&pb.EnrollResponse{RelayPoolId: "system"}); err == nil {
		t.Fatal("an incomplete bundle was accepted")
	}
	if _, err := os.Stat(filepath.Join(cfg.Worker.StateDir, "relay.db")); err != nil {
		t.Fatal("an invalid bundle reset the worker's policy trust")
	}
	if err := plugin.PersistEnrollmentBundle(validEnrollResponse(t)); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"relay.db", "identity-rotation.json"} {
		if _, err := os.Stat(filepath.Join(cfg.Worker.StateDir, name)); !os.IsNotExist(err) {
			t.Fatalf("worker %s survived the enrollment: %v", name, err)
		}
		matches, _ := filepath.Glob(filepath.Join(cfg.Worker.StateDir, name+".pre-enrollment-*"))
		if len(matches) != 1 {
			t.Fatalf("worker %s was not kept aside: %v", name, matches)
		}
	}
	for _, path := range identityPaths(&cfg.BaseConfig) {
		if _, err := os.Stat(path + stashedIdentitySuffix); !os.IsNotExist(err) {
			t.Fatalf("superseded identity %s was kept: %v", path, err)
		}
	}
}

func validEnrollResponse(t *testing.T) *pb.EnrollResponse {
	t.Helper()
	clientCert, clientKey := testCertificate(t, "relay-node")
	serverCert, serverKey := testCertificate(t, "relay-instance")
	publicKey := make([]byte, 32)
	if _, err := rand.Read(publicKey); err != nil {
		t.Fatal(err)
	}
	return &pb.EnrollResponse{
		CaCertificate: clientCert, ClientCertificate: clientCert, ClientKey: clientKey,
		RelayPoolId: "system", RelayInstanceId: "relay-1", HostIdentityId: "host-1",
		PolicySigningKeyId: "policy-1", PolicySigningPublicKey: publicKey,
		PolicySigningPublicKeyFingerprint: policyFingerprint(publicKey), RelayServerIdentity: "relay-relay-1",
		RelayServerCertificate: serverCert, RelayServerKey: serverKey,
	}
}
