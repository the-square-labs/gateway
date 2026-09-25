package lifecycle

import (
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

const certTestDay = 24 * time.Hour

func TestClientCertRenewalDue(t *testing.T) {
	now := time.Date(2026, 9, 25, 12, 0, 0, 0, time.UTC)
	window := func(lifetime, remaining time.Duration) (time.Time, time.Time) {
		notAfter := now.Add(remaining)
		return notAfter.Add(-lifetime), notAfter
	}

	cases := []struct {
		name      string
		lifetime  time.Duration
		remaining time.Duration
		want      bool
	}{
		{"365d cert with 200d left", 365 * certTestDay, 200 * certTestDay, false},
		{"365d cert with 122d left", 365 * certTestDay, 122 * certTestDay, false},
		{"365d cert with 121d left", 365 * certTestDay, 121 * certTestDay, true},
		{"365d cert with 7d left", 365 * certTestDay, 7 * certTestDay, true},
		{"365d cert already expired", 365 * certTestDay, -certTestDay, true},
		{"30d cert with 11d left", 30 * certTestDay, 11 * certTestDay, false},
		{"30d cert with 9d left", 30 * certTestDay, 9 * certTestDay, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			notBefore, notAfter := window(tc.lifetime, tc.remaining)
			if got := clientCertRenewalDue(notBefore, notAfter, now); got != tc.want {
				t.Fatalf("clientCertRenewalDue = %v, want %v", got, tc.want)
			}
		})
	}

	if !clientCertRenewalDue(now, now, now) {
		t.Fatal("an empty validity window must be due")
	}
	if !clientCertRenewalDue(now.Add(certTestDay), now, now) {
		t.Fatal("an inverted validity window must be due")
	}
}

func TestCertRenewalRetryDelay(t *testing.T) {
	want := []time.Duration{
		0,
		5 * time.Minute,
		10 * time.Minute,
		20 * time.Minute,
		40 * time.Minute,
		time.Hour,
		time.Hour,
	}
	for failures, expected := range want {
		if got := certRenewalRetryDelay(failures); got != expected {
			t.Fatalf("certRenewalRetryDelay(%d) = %v, want %v", failures, got, expected)
		}
	}
	if got := certRenewalRetryDelay(1000); got != time.Hour {
		t.Fatalf("certRenewalRetryDelay(1000) = %v, want capped 1h", got)
	}
	if got := certRenewalRetryDelay(-1); got != 0 {
		t.Fatalf("certRenewalRetryDelay(-1) = %v, want 0", got)
	}
}

func TestLoadCertificateValidityParsesClientCertificate(t *testing.T) {
	notBefore := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	notAfter := notBefore.Add(365 * certTestDay)
	path := filepath.Join(t.TempDir(), "client.pem")
	writeTestCertificate(t, path, notBefore, notAfter)

	gotBefore, gotAfter, err := loadCertificateValidity(path)
	if err != nil {
		t.Fatalf("loadCertificateValidity: %v", err)
	}
	if !gotBefore.Equal(notBefore) || !gotAfter.Equal(notAfter) {
		t.Fatalf("validity = %v..%v, want %v..%v", gotBefore, gotAfter, notBefore, notAfter)
	}

	before, after, source, ok, loadErr := clientCertValidityWindow(path, 42)
	if !ok || loadErr != nil || source != "certificate" {
		t.Fatalf("window ok=%v source=%q err=%v, want the certificate to win over the state", ok, source, loadErr)
	}
	if !before.Equal(notBefore) || !after.Equal(notAfter) {
		t.Fatalf("window = %v..%v, want %v..%v", before, after, notBefore, notAfter)
	}
}

func TestClientCertValidityWindowFallsBackToStateExpiry(t *testing.T) {
	dir := t.TempDir()
	garbage := filepath.Join(dir, "client.pem")
	if err := os.WriteFile(garbage, []byte("not a certificate"), 0o644); err != nil {
		t.Fatal(err)
	}
	expiresAt := time.Date(2027, 3, 1, 0, 0, 0, 0, time.UTC)

	for _, path := range []string{garbage, filepath.Join(dir, "missing.pem")} {
		notBefore, notAfter, source, ok, loadErr := clientCertValidityWindow(path, expiresAt.Unix())
		if !ok || source != "state" || loadErr == nil {
			t.Fatalf("%s: ok=%v source=%q err=%v, want a state fallback", path, ok, source, loadErr)
		}
		if !notAfter.Equal(expiresAt) {
			t.Fatalf("%s: notAfter = %v, want %v", path, notAfter, expiresAt)
		}
		if lifetime := notAfter.Sub(notBefore); lifetime != 365*certTestDay {
			t.Fatalf("%s: assumed lifetime = %v, want 365d", path, lifetime)
		}
	}

	if _, _, _, ok, _ := clientCertValidityWindow(garbage, 0); ok {
		t.Fatal("without a parseable certificate or a stored expiry the window must be unknown")
	}
}

func writeTestCertificate(t *testing.T, path string, notBefore, notAfter time.Time) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "node-test"},
		NotBefore:    notBefore,
		NotAfter:     notAfter,
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644); err != nil {
		t.Fatal(err)
	}
}
