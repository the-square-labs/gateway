package supervisor

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

func TestPersistEnrollmentBundleRejectsPolicyKeyFingerprintMismatch(t *testing.T) {
	response := &pb.EnrollResponse{
		RelayPoolId: "system", RelayInstanceId: "relay-1", HostIdentityId: "host-1",
		PolicySigningKeyId: "policy-1", PolicySigningPublicKey: make([]byte, 32),
		PolicySigningPublicKeyFingerprint: "sha256:" + strings.Repeat("f", 64),
		RelayServerIdentity:               "relay-relay-1", RelayServerCertificate: []byte("cert"), RelayServerKey: []byte("key"),
	}
	if err := persistEnrollmentBundle(t.TempDir(), filepath.Join(t.TempDir(), "identity"), response); err == nil {
		t.Fatal("mismatched enrollment policy key fingerprint was accepted")
	}
}

func TestPersistEnrollmentBundleStagesWorkerIdentityAndPinnedTrust(t *testing.T) {
	clientCert, clientKey := testCertificate(t, "relay-node")
	serverCert, serverKey := testCertificate(t, "relay-instance")
	publicKey := make([]byte, 32)
	if _, err := rand.Read(publicKey); err != nil {
		t.Fatal(err)
	}
	response := &pb.EnrollResponse{
		CaCertificate: clientCert, ClientCertificate: clientCert, ClientKey: clientKey,
		RelayPoolId: "system", RelayInstanceId: "relay-1", HostIdentityId: "host-1",
		PolicySigningKeyId: "policy-1", PolicySigningPublicKey: publicKey,
		PolicySigningPublicKeyFingerprint: policyFingerprint(publicKey), RelayServerIdentity: "relay-relay-1",
		RelayServerCertificate: serverCert, RelayServerKey: serverKey,
	}
	root := t.TempDir()
	stateDir, identityDir := filepath.Join(root, "state"), filepath.Join(root, "identity")
	if err := persistEnrollmentBundle(stateDir, identityDir, response); err != nil {
		t.Fatal(err)
	}
	state, err := loadEnrollmentState(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if state.InstanceID != "relay-1" || state.PolicySigningFingerprint != policyFingerprint(publicKey) {
		t.Fatalf("unexpected enrollment state: %#v", state)
	}
	for _, name := range []string{"system-ca.crt", "external-server.crt", "external-server.key", "app-relay-client.crt", "app-relay-client.key", "trust-manifest.json"} {
		if _, err := os.Stat(filepath.Join(identityDir, name)); err != nil {
			t.Fatalf("missing staged worker identity file %s: %v", name, err)
		}
	}
}

func policyFingerprint(publicKey []byte) string {
	digest := sha256Sum(publicKey)
	return "sha256:" + digest
}

func sha256Sum(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func testCertificate(t *testing.T, commonName string) ([]byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: commonName},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth, x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
}
