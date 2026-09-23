package auth

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testClientPair(t *testing.T, serial int64) (certPEM, keyPEM []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(serial),
		Subject:      pkix.Name{CommonName: "11111111-1111-4111-8111-111111111111"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
		pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
}

func loadedSerial(t *testing.T, manager *TLSManager) int64 {
	t.Helper()
	if err := manager.LoadCredentials(); err != nil {
		t.Fatal(err)
	}
	cert, err := manager.GetClientCertificate(nil)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	return parsed.SerialNumber.Int64()
}

func TestSaveCredentialsReplacesThePairWithoutLeftovers(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := filepath.Join(dir, "client.crt"), filepath.Join(dir, "client.key")
	manager := NewTLSManager(filepath.Join(dir, "ca.crt"), certPath, keyPath)
	cert1, key1 := testClientPair(t, 1)
	cert2, key2 := testClientPair(t, 2)

	if err := SaveCredentials(manager.CACertPath, certPath, keyPath, cert1, cert1, key1); err != nil {
		t.Fatal(err)
	}
	if got := loadedSerial(t, manager); got != 1 {
		t.Fatalf("serial = %d, want 1", got)
	}
	if err := SaveCredentials(manager.CACertPath, certPath, keyPath, nil, cert2, key2); err != nil {
		t.Fatal(err)
	}
	if got := loadedSerial(t, manager); got != 2 {
		t.Fatalf("serial = %d, want 2", got)
	}
	for _, leftover := range []string{certPath + stagedSuffix, keyPath + stagedSuffix} {
		if _, err := os.Stat(leftover); !os.IsNotExist(err) {
			t.Fatalf("staged file %s left behind: %v", leftover, err)
		}
	}
	if info, err := os.Stat(keyPath); err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("key mode = %v, %v", info.Mode().Perm(), err)
	}
}

func TestSaveCredentialsRefusesAMismatchedPair(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := filepath.Join(dir, "client.crt"), filepath.Join(dir, "client.key")
	cert1, key1 := testClientPair(t, 1)
	cert2, _ := testClientPair(t, 2)
	if err := SaveCredentials(filepath.Join(dir, "ca.crt"), certPath, keyPath, cert1, cert1, key1); err != nil {
		t.Fatal(err)
	}
	if err := SaveCredentials(filepath.Join(dir, "ca.crt"), certPath, keyPath, nil, cert2, key1); err == nil {
		t.Fatal("a certificate that does not match the key must be refused")
	}
	if current, _ := os.ReadFile(certPath); !bytes.Equal(current, cert1) {
		t.Fatal("the working certificate was replaced by a broken pair")
	}
}

func TestLoadCredentialsCompletesAnInterruptedSwap(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath := filepath.Join(dir, "client.crt"), filepath.Join(dir, "client.key")
	manager := NewTLSManager(filepath.Join(dir, "ca.crt"), certPath, keyPath)
	cert1, key1 := testClientPair(t, 1)
	cert2, key2 := testClientPair(t, 2)
	if err := SaveCredentials(manager.CACertPath, certPath, keyPath, cert1, cert1, key1); err != nil {
		t.Fatal(err)
	}
	// Crash after the new key was renamed into place but before the new
	// certificate was: the live pair is mismatched, the certificate is staged.
	if err := os.WriteFile(keyPath, key2, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(certPath+stagedSuffix, cert2, 0644); err != nil {
		t.Fatal(err)
	}

	if got := loadedSerial(t, manager); got != 2 {
		t.Fatalf("serial = %d, want the recovered certificate 2", got)
	}
	if current, _ := os.ReadFile(certPath); !bytes.Equal(current, cert2) {
		t.Fatal("recovered certificate was not installed")
	}
}
