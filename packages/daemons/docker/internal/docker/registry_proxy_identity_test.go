package docker

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newTestRegistryProxyManager(t *testing.T, root string) *dockerRegistryProxyManager {
	t.Helper()
	directory := filepath.Join(root, "registry-proxy")
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	return &dockerRegistryProxyManager{
		directory: directory,
		trustRoot: filepath.Join(root, "trust"),
		bindings:  map[string]*registryProxyBinding{},
	}
}

func readRegistryProxyTestFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// storedRegistryProxyCA returns the CA and key persisted in directory.
func storedRegistryProxyCA(t *testing.T, directory string) (*x509.Certificate, *ecdsa.PrivateKey) {
	t.Helper()
	paths := newRegistryProxyIdentityPaths(directory)
	_, caCert := readRegistryProxyCA(paths.caCert)
	if caCert == nil {
		t.Fatal("stored registry proxy CA is unreadable")
	}
	caKey := readRegistryProxyCAKey(paths.caKey, caCert)
	if caKey == nil {
		t.Fatal("stored registry proxy CA key is missing or does not match the CA")
	}
	return caCert, caKey
}

// writeStoredRegistryProxyLeaf replaces the stored server certificate with one
// valid until notAfter and signed by signer.
func writeStoredRegistryProxyLeaf(t *testing.T, directory string, notAfter time.Time, signer *x509.Certificate, signerKey *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: randomSerial(), Subject: pkix.Name{CommonName: registryProxyServer},
		NotBefore: notAfter.AddDate(-2, 0, 0), NotAfter: notAfter,
		IPAddresses: []net.IP{net.ParseIP(registryProxyAddress)}, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		KeyUsage: x509.KeyUsageDigitalSignature,
	}
	der, err := x509.CreateCertificate(rand.Reader, template, signer, &key.PublicKey, signerKey)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	paths := newRegistryProxyIdentityPaths(directory)
	if err := os.WriteFile(paths.serverCert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.serverKey, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
}

func servedRegistryProxyLeaf(t *testing.T, m *dockerRegistryProxyManager) *x509.Certificate {
	t.Helper()
	cert, err := m.getCertificate(nil)
	if err != nil {
		t.Fatalf("getCertificate: %v", err)
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	return leaf
}

// handshakeServedLeaf runs a TLS 1.3 handshake against the manager's
// GetCertificate callback, verifying the chain with caPEM like Docker does.
func handshakeServedLeaf(t *testing.T, m *dockerRegistryProxyManager, caPEM []byte) *x509.Certificate {
	t.Helper()
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(caPEM) {
		t.Fatal("CA PEM is not parseable")
	}
	clientSide, serverSide := net.Pipe()
	defer clientSide.Close()
	defer serverSide.Close()
	server := tls.Server(serverSide, &tls.Config{GetCertificate: m.getCertificate, MinVersion: tls.VersionTLS13})
	serverErr := make(chan error, 1)
	go func() { serverErr <- server.Handshake() }()
	client := tls.Client(clientSide, &tls.Config{RootCAs: roots, ServerName: registryProxyServer, MinVersion: tls.VersionTLS13})
	if err := client.Handshake(); err != nil {
		t.Fatalf("client handshake: %v", err)
	}
	if err := <-serverErr; err != nil {
		t.Fatalf("server handshake: %v", err)
	}
	return client.ConnectionState().PeerCertificates[0]
}

func TestRegistryProxyIdentityFreshCreatePersistsCAKey(t *testing.T) {
	m := newTestRegistryProxyManager(t, t.TempDir())
	if err := m.loadOrCreateIdentity(); err != nil {
		t.Fatalf("loadOrCreateIdentity: %v", err)
	}
	paths := newRegistryProxyIdentityPaths(m.directory)
	info, err := os.Stat(paths.caKey)
	if err != nil {
		t.Fatalf("ca-key.pem was not persisted: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("ca-key.pem mode = %o, want 600", mode)
	}
	if mode := statRegistryProxyTestFile(t, paths.serverKey).Mode().Perm(); mode != 0o600 {
		t.Fatalf("server-key.pem mode = %o, want 600", mode)
	}
	caCert, _ := storedRegistryProxyCA(t, m.directory)
	if !bytes.Equal(m.currentCAPEM(), readRegistryProxyTestFile(t, paths.caCert)) {
		t.Fatal("served CA PEM differs from ca.pem")
	}
	leaf := servedRegistryProxyLeaf(t, m)
	if err := leaf.CheckSignatureFrom(caCert); err != nil {
		t.Fatalf("served leaf is not signed by the stored CA: %v", err)
	}
	if lifetime := leaf.NotAfter.Sub(leaf.NotBefore); lifetime < 700*24*time.Hour {
		t.Fatalf("leaf lifetime = %v, want about two years", lifetime)
	}
	if handshakeServedLeaf(t, m, m.currentCAPEM()).SerialNumber.Cmp(leaf.SerialNumber) != 0 {
		t.Fatal("handshake served a different leaf")
	}
	if _, err := os.Stat(m.dockerTrustPath()); !os.IsNotExist(err) {
		t.Fatalf("Docker trust must wait for the first binding sync, stat err = %v", err)
	}
	entries, err := os.ReadDir(m.directory)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 4 {
		t.Fatalf("identity directory holds %d entries, want exactly the 4 identity files (no temp leftovers)", len(entries))
	}
}

func TestRegistryProxyIdentityReissuesExpiringLeafFromSameCA(t *testing.T) {
	root := t.TempDir()
	first := newTestRegistryProxyManager(t, root)
	if err := first.loadOrCreateIdentity(); err != nil {
		t.Fatal(err)
	}
	paths := newRegistryProxyIdentityPaths(first.directory)
	caPEM := readRegistryProxyTestFile(t, paths.caCert)
	caKeyPEM := readRegistryProxyTestFile(t, paths.caKey)
	caCert, caKey := storedRegistryProxyCA(t, first.directory)
	writeStoredRegistryProxyLeaf(t, first.directory, time.Now().Add(10*24*time.Hour), caCert, caKey)
	expiring := readRegistryProxyTestFile(t, paths.serverCert)

	restarted := newTestRegistryProxyManager(t, root)
	outcome, err := restarted.refreshIdentity(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if outcome != registryProxyIdentityLeafReissued {
		t.Fatalf("outcome = %s, want %s", outcome, registryProxyIdentityLeafReissued)
	}
	if !bytes.Equal(readRegistryProxyTestFile(t, paths.caCert), caPEM) || !bytes.Equal(readRegistryProxyTestFile(t, paths.caKey), caKeyPEM) {
		t.Fatal("reissuing the leaf must keep the CA and its key")
	}
	if bytes.Equal(readRegistryProxyTestFile(t, paths.serverCert), expiring) {
		t.Fatal("the expiring leaf was not replaced on disk")
	}
	leaf := servedRegistryProxyLeaf(t, restarted)
	if err := leaf.CheckSignatureFrom(caCert); err != nil {
		t.Fatalf("reissued leaf is not signed by the same CA: %v", err)
	}
	if time.Until(leaf.NotAfter) < 700*24*time.Hour {
		t.Fatalf("reissued leaf expires at %v, want about two years out", leaf.NotAfter)
	}
	if leaf.Subject.CommonName != registryProxyServer || leaf.VerifyHostname(registryProxyServer) != nil {
		t.Fatalf("reissued leaf subject %q does not cover %s", leaf.Subject.CommonName, registryProxyServer)
	}
	if len(leaf.ExtKeyUsage) != 1 || leaf.ExtKeyUsage[0] != x509.ExtKeyUsageServerAuth {
		t.Fatalf("reissued leaf ext key usage = %v", leaf.ExtKeyUsage)
	}
	if !bytes.Equal(restarted.currentCAPEM(), caPEM) {
		t.Fatal("served CA changed although only the leaf was reissued")
	}
}

func TestRegistryProxyIdentityReissuesLeafNotSignedByStoredCA(t *testing.T) {
	root := t.TempDir()
	first := newTestRegistryProxyManager(t, root)
	if err := first.loadOrCreateIdentity(); err != nil {
		t.Fatal(err)
	}
	foreignCAPEM, foreignCA, foreignKey, err := generateRegistryProxyCA(time.Now())
	if err != nil || len(foreignCAPEM) == 0 {
		t.Fatal(err)
	}
	writeStoredRegistryProxyLeaf(t, first.directory, time.Now().AddDate(1, 6, 0), foreignCA, foreignKey)

	restarted := newTestRegistryProxyManager(t, root)
	outcome, err := restarted.refreshIdentity(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if outcome != registryProxyIdentityLeafReissued {
		t.Fatalf("outcome = %s, want %s", outcome, registryProxyIdentityLeafReissued)
	}
	caCert, _ := storedRegistryProxyCA(t, restarted.directory)
	if err := servedRegistryProxyLeaf(t, restarted).CheckSignatureFrom(caCert); err != nil {
		t.Fatalf("reissued leaf is not signed by the stored CA: %v", err)
	}
}

func TestRegistryProxyIdentityWithoutCAKeyRegeneratesCA(t *testing.T) {
	root := t.TempDir()
	first := newTestRegistryProxyManager(t, root)
	if err := first.loadOrCreateIdentity(); err != nil {
		t.Fatal(err)
	}
	// Existing installs stored only ca.pem, server.pem and server-key.pem.
	paths := newRegistryProxyIdentityPaths(first.directory)
	oldCAPEM := readRegistryProxyTestFile(t, paths.caCert)
	oldCA, oldCAKey := storedRegistryProxyCA(t, first.directory)
	writeStoredRegistryProxyLeaf(t, first.directory, time.Now().Add(10*24*time.Hour), oldCA, oldCAKey)
	if err := os.Remove(paths.caKey); err != nil {
		t.Fatal(err)
	}
	// Docker already trusts the old CA.
	if err := first.installDockerTrust(); err != nil {
		t.Fatal(err)
	}

	restarted := newTestRegistryProxyManager(t, root)
	outcome, err := restarted.refreshIdentity(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if outcome != registryProxyIdentityCARegenerated {
		t.Fatalf("outcome = %s, want %s", outcome, registryProxyIdentityCARegenerated)
	}
	newCAPEM := readRegistryProxyTestFile(t, paths.caCert)
	if bytes.Equal(newCAPEM, oldCAPEM) {
		t.Fatal("CA was not regenerated")
	}
	newCA, _ := storedRegistryProxyCA(t, restarted.directory) // ca-key.pem persisted and matching
	if err := servedRegistryProxyLeaf(t, restarted).CheckSignatureFrom(newCA); err != nil {
		t.Fatalf("new leaf is not signed by the new CA: %v", err)
	}
	if !bytes.Equal(restarted.currentCAPEM(), newCAPEM) {
		t.Fatal("status CA does not reflect the regenerated CA")
	}
	if !bytes.Equal(readRegistryProxyTestFile(t, restarted.dockerTrustPath()), newCAPEM) {
		t.Fatal("existing Docker trust was not updated to the regenerated CA")
	}
	handshakeServedLeaf(t, restarted, readRegistryProxyTestFile(t, restarted.dockerTrustPath()))
}

func TestRegistryProxyIdentityRenewalCheckSwapsServedCertificate(t *testing.T) {
	m := newTestRegistryProxyManager(t, t.TempDir())
	if err := m.loadOrCreateIdentity(); err != nil {
		t.Fatal(err)
	}
	caPEM := m.currentCAPEM()
	before := handshakeServedLeaf(t, m, caPEM)

	// Seventeen months later only seven of the leaf's 24 months remain.
	outcome, err := m.refreshIdentity(time.Now().AddDate(0, 17, 0))
	if err != nil {
		t.Fatal(err)
	}
	if outcome != registryProxyIdentityLeafReissued {
		t.Fatalf("outcome = %s, want %s", outcome, registryProxyIdentityLeafReissued)
	}
	if !bytes.Equal(m.currentCAPEM(), caPEM) {
		t.Fatal("a leaf renewal must keep the CA")
	}
	after := servedRegistryProxyLeaf(t, m)
	if after.SerialNumber.Cmp(before.SerialNumber) == 0 {
		t.Fatal("GetCertificate still serves the old leaf after the renewal check")
	}
	if !after.NotAfter.After(before.NotAfter) {
		t.Fatalf("renewed leaf expires %v, not after the old %v", after.NotAfter, before.NotAfter)
	}
}

func TestRegistryProxyIdentityRotatesCANearExpiryAndTrustsBothDuringSwap(t *testing.T) {
	m := newTestRegistryProxyManager(t, t.TempDir())
	if err := m.loadOrCreateIdentity(); err != nil {
		t.Fatal(err)
	}
	oldCAPEM := m.currentCAPEM()
	if err := m.installDockerTrust(); err != nil {
		t.Fatal(err)
	}

	// Nine and a half years in, the CA has less than a year left.
	outcome, err := m.refreshIdentity(time.Now().AddDate(9, 6, 0))
	if err != nil {
		t.Fatal(err)
	}
	if outcome != registryProxyIdentityCARegenerated {
		t.Fatalf("outcome = %s, want %s", outcome, registryProxyIdentityCARegenerated)
	}
	newCAPEM := m.currentCAPEM()
	if bytes.Equal(newCAPEM, oldCAPEM) {
		t.Fatal("CA near expiry was not rotated")
	}
	trust := readRegistryProxyTestFile(t, m.dockerTrustPath())
	if !bytes.Contains(trust, newCAPEM) || !bytes.Contains(trust, oldCAPEM) {
		t.Fatal("Docker trust must hold both CAs while the served certificate is swapped")
	}
	if err := m.installDockerTrust(); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(readRegistryProxyTestFile(t, m.dockerTrustPath()), newCAPEM) {
		t.Fatal("the next trust install must collapse to the current CA")
	}
}

func TestRegistryProxyIdentityKeepsHealthyLeaf(t *testing.T) {
	root := t.TempDir()
	first := newTestRegistryProxyManager(t, root)
	if err := first.loadOrCreateIdentity(); err != nil {
		t.Fatal(err)
	}
	paths := newRegistryProxyIdentityPaths(first.directory)
	snapshot := map[string][]byte{}
	for _, path := range []string{paths.caCert, paths.caKey, paths.serverCert, paths.serverKey} {
		snapshot[path] = readRegistryProxyTestFile(t, path)
	}
	servedBefore := servedRegistryProxyLeaf(t, first)

	outcome, err := first.refreshIdentity(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if outcome != registryProxyIdentityUnchanged {
		t.Fatalf("periodic check outcome = %s, want %s", outcome, registryProxyIdentityUnchanged)
	}
	restarted := newTestRegistryProxyManager(t, root)
	outcome, err = restarted.refreshIdentity(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if outcome != registryProxyIdentityUnchanged {
		t.Fatalf("restart outcome = %s, want %s", outcome, registryProxyIdentityUnchanged)
	}
	for path, data := range snapshot {
		if !bytes.Equal(readRegistryProxyTestFile(t, path), data) {
			t.Fatalf("%s changed although the leaf is healthy", filepath.Base(path))
		}
	}
	if servedRegistryProxyLeaf(t, restarted).SerialNumber.Cmp(servedBefore.SerialNumber) != 0 {
		t.Fatal("a healthy leaf must be served unchanged")
	}
	if _, err := os.Stat(restarted.dockerTrustPath()); !os.IsNotExist(err) {
		t.Fatal("an unchanged CA must not install Docker trust")
	}
}

func TestRegistryProxyStartupRewritesStaleDockerTrust(t *testing.T) {
	root := t.TempDir()
	first := newTestRegistryProxyManager(t, root)
	if err := first.loadOrCreateIdentity(); err != nil {
		t.Fatal(err)
	}
	caPEM := readRegistryProxyTestFile(t, newRegistryProxyIdentityPaths(first.directory).caCert)
	// A CA swap whose trust write failed before a restart leaves the old CA in certs.d.
	stale := []byte("-----BEGIN CERTIFICATE-----\nb2xkLWNh\n-----END CERTIFICATE-----\n")
	if err := first.writeDockerTrust(stale); err != nil {
		t.Fatal(err)
	}

	restarted := newTestRegistryProxyManager(t, root)
	if err := restarted.loadOrCreateIdentity(); err != nil {
		t.Fatal(err)
	}
	if got := readRegistryProxyTestFile(t, restarted.dockerTrustPath()); !bytes.Equal(got, caPEM) {
		t.Fatalf("Docker trust was not rewritten to the served CA:\n%s", got)
	}

	// A trust file that already holds the served CA (alone or during a swap) stays as it is.
	both := append(append([]byte{}, caPEM...), stale...)
	if err := restarted.writeDockerTrust(both); err != nil {
		t.Fatal(err)
	}
	if _, err := restarted.refreshIdentity(time.Now()); err != nil {
		t.Fatal(err)
	}
	if got := readRegistryProxyTestFile(t, restarted.dockerTrustPath()); !bytes.Equal(got, both) {
		t.Fatal("a trust file that contains the served CA must not be rewritten")
	}
}

func TestRegistryProxyLeafRenewalReason(t *testing.T) {
	now := time.Now()
	caPEM, caCert, caKey, err := generateRegistryProxyCA(now)
	if err != nil || len(caPEM) == 0 {
		t.Fatal(err)
	}
	load := func(notAfter time.Time) *tls.Certificate {
		dir := t.TempDir()
		writeStoredRegistryProxyLeaf(t, dir, notAfter, caCert, caKey)
		paths := newRegistryProxyIdentityPaths(dir)
		pair, err := tls.LoadX509KeyPair(paths.serverCert, paths.serverKey)
		if err != nil {
			t.Fatal(err)
		}
		return &pair
	}
	// Two-year leaves: renew at eight months (a third) or 30 days left.
	if reason := registryProxyLeafRenewalReason(load(now.AddDate(0, 9, 0)), nil, caCert, now); reason != "" {
		t.Fatalf("leaf with nine months left renewed: %s", reason)
	}
	if reason := registryProxyLeafRenewalReason(load(now.AddDate(0, 7, 0)), nil, caCert, now); reason == "" {
		t.Fatal("leaf with seven months left of two years was not renewed")
	}
	if reason := registryProxyLeafRenewalReason(load(now.Add(-time.Hour)), nil, caCert, now); reason == "" {
		t.Fatal("expired leaf was not renewed")
	}
	if reason := registryProxyLeafRenewalReason(&tls.Certificate{}, os.ErrNotExist, caCert, now); reason == "" {
		t.Fatal("missing leaf was not renewed")
	}
}

func statRegistryProxyTestFile(t *testing.T, path string) os.FileInfo {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info
}
