package supervisor

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

type testCA struct {
	certificate *x509.Certificate
	key         *ecdsa.PrivateKey
	pem         []byte
}

func newTestCA(t *testing.T) testCA {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "gateway-system-ca"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(10 * 365 * 24 * time.Hour),
		IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certificate, _ := x509.ParseCertificate(der)
	return testCA{certificate: certificate, key: key, pem: pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})}
}

var testSerial int64 = 100

func (ca testCA) issue(t *testing.T, name string, usage x509.ExtKeyUsage, notAfter time.Time) ([]byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	testSerial++
	template := &x509.Certificate{
		SerialNumber: big.NewInt(testSerial), Subject: pkix.Name{CommonName: name},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: notAfter,
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{usage},
	}
	if usage == x509.ExtKeyUsageServerAuth {
		template.DNSNames = []string{name, "relay.example.test"}
	}
	der, err := x509.CreateCertificate(rand.Reader, template, ca.certificate, &key.PublicKey, ca.key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalPKCS8PrivateKey(key)
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
}

func workerIdentityDir(t *testing.T, ca testCA, serverCert, serverKey, adminCert, adminKey []byte) string {
	t.Helper()
	dir := t.TempDir()
	for name, content := range map[string][]byte{
		"system-ca.crt": ca.pem, workerServerCertificate: serverCert, workerServerKey: serverKey,
		workerAdminClientCertificate: adminCert, workerAdminClientKey: adminKey,
	} {
		if err := os.WriteFile(filepath.Join(dir, name), content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func fileFingerprint(t *testing.T, path string) string {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	fingerprint, _, err := pemFingerprint(content)
	if err != nil {
		t.Fatal(err)
	}
	return fingerprint
}

// A renewal installs the new server certificate and keeps the one daemons still
// pin beside it, and moves the admin client onto the supervisor's renewed certificate.
func TestRenewalStagesServerCertificateAndKeepsThePinnedOne(t *testing.T) {
	ca := newTestCA(t)
	year := time.Now().Add(365 * 24 * time.Hour)
	oldServer, oldServerKey := ca.issue(t, "relay-instance", x509.ExtKeyUsageServerAuth, time.Now().Add(20*24*time.Hour))
	newServer, newServerKey := ca.issue(t, "relay-instance-r2", x509.ExtKeyUsageServerAuth, year)
	oldAdmin, oldAdminKey := ca.issue(t, "node-1", x509.ExtKeyUsageClientAuth, time.Now().Add(10*24*time.Hour))
	newAdmin, newAdminKey := ca.issue(t, "node-1", x509.ExtKeyUsageClientAuth, year)
	dir := workerIdentityDir(t, ca, oldServer, oldServerKey, oldAdmin, oldAdminKey)
	oldFingerprint := fileFingerprint(t, filepath.Join(dir, workerServerCertificate))

	renewal := &pb.RenewRelayIdentityCommand{
		ServerCertificate: newServer, ServerKey: newServerKey, ServerIdentity: "relay-instance-r2",
		RetainServerFingerprint: oldFingerprint,
	}
	plan, err := planWorkerIdentity(dir, renewal, newAdmin, newAdminKey, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if !plan.adminChange {
		t.Fatal("renewed supervisor certificate was not planned as the admin client")
	}
	if err := writeWorkerIdentity(dir, plan); err != nil {
		t.Fatal(err)
	}
	if got := fileFingerprint(t, filepath.Join(dir, workerPreviousServerCertificate)); got != oldFingerprint {
		t.Fatal("the certificate daemons pin was not retained")
	}
	newFingerprint, _, _ := pemFingerprint(newServer)
	if got := fileFingerprint(t, filepath.Join(dir, workerServerCertificate)); got != newFingerprint {
		t.Fatal("the renewed certificate is not current")
	}
	adminFingerprint, _, _ := pemFingerprint(newAdmin)
	var trust map[string]any
	manifest, _ := os.ReadFile(filepath.Join(dir, workerTrustManifest))
	if err := json.Unmarshal(manifest, &trust); err != nil || trust["appRelayClientFingerprint"] != adminFingerprint {
		t.Fatalf("trust manifest does not name the renewed admin client: %s", manifest)
	}
	if _, err := os.Stat(filepath.Join(dir, workerIdentityUpdatingMarker)); !os.IsNotExist(err) {
		t.Fatal("update marker was left behind")
	}

	// A second renewal retains the certificate daemons were moved to, not the oldest one.
	newestServer, newestKey := ca.issue(t, "relay-instance-r3", x509.ExtKeyUsageServerAuth, year)
	plan, err = planWorkerIdentity(dir, &pb.RenewRelayIdentityCommand{
		ServerCertificate: newestServer, ServerKey: newestKey, ServerIdentity: "relay-instance-r3",
		RetainServerFingerprint: newFingerprint,
	}, newAdmin, newAdminKey, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if plan.adminChange {
		t.Fatal("an unchanged admin client was rewritten")
	}
	if err := writeWorkerIdentity(dir, plan); err != nil {
		t.Fatal(err)
	}
	if got := fileFingerprint(t, filepath.Join(dir, workerPreviousServerCertificate)); got != newFingerprint {
		t.Fatal("the pinned certificate was not the one retained")
	}
}

func TestRenewalRefusesMaterialThatDoesNotBelongToTheRelay(t *testing.T) {
	ca := newTestCA(t)
	foreign := newTestCA(t)
	year := time.Now().Add(365 * 24 * time.Hour)
	server, serverKey := ca.issue(t, "relay-instance", x509.ExtKeyUsageServerAuth, year)
	admin, adminKey := ca.issue(t, "node-1", x509.ExtKeyUsageClientAuth, year)
	dir := workerIdentityDir(t, ca, server, serverKey, admin, adminKey)

	foreignServer, foreignKey := foreign.issue(t, "relay-instance-r2", x509.ExtKeyUsageServerAuth, year)
	otherServer, otherKey := ca.issue(t, "relay-instance-r2", x509.ExtKeyUsageServerAuth, year)
	for name, renewal := range map[string]*pb.RenewRelayIdentityCommand{
		"another CA":         {ServerCertificate: foreignServer, ServerKey: foreignKey, ServerIdentity: "relay-instance-r2"},
		"another identity":   {ServerCertificate: otherServer, ServerKey: otherKey, ServerIdentity: "relay-instance-r9"},
		"a mismatched key":   {ServerCertificate: otherServer, ServerKey: serverKey, ServerIdentity: "relay-instance-r2"},
		"a missing identity": {ServerCertificate: otherServer, ServerKey: otherKey},
	} {
		if _, err := planWorkerIdentity(dir, renewal, admin, adminKey, time.Now()); err == nil {
			t.Fatalf("renewal with %s was accepted", name)
		}
	}
	// Nothing to do when the admin client is already current.
	if _, err := planWorkerIdentity(dir, nil, admin, adminKey, time.Now()); err != errNoIdentityChange {
		t.Fatalf("unchanged admin client: %v", err)
	}
}
