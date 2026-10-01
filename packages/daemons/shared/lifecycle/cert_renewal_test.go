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
		{"365d cert with 122d left", 365 * certTestDay, 122 * certTestDay, false},
		{"365d cert with 121d left", 365 * certTestDay, 121 * certTestDay, true},
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

// A failed renewal is retried with a capped backoff and never given up.
func TestCertRenewalRetriesForever(t *testing.T) {
	if got := certRenewalRetryDelay(0); got != 0 {
		t.Fatalf("first attempt waits %v, want none", got)
	}
	previous := time.Duration(0)
	for failures := 1; failures <= 1000; failures++ {
		delay := certRenewalRetryDelay(failures)
		if delay <= 0 || delay > time.Hour || delay < previous {
			t.Fatalf("certRenewalRetryDelay(%d) = %v after %v, want a growing delay of at most an hour", failures, delay, previous)
		}
		previous = delay
	}
}

func TestClientCertValidityWindowPrefersTheCertificate(t *testing.T) {
	notBefore := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	notAfter := notBefore.Add(365 * certTestDay)
	path := filepath.Join(t.TempDir(), "client.pem")
	writeTestCertificate(t, path, notBefore, notAfter)

	before, after, source, ok, loadErr := clientCertValidityWindow(path, 42)
	if !ok || loadErr != nil || source != "certificate" {
		t.Fatalf("window ok=%v source=%q err=%v, want the certificate to win over the state", ok, source, loadErr)
	}
	if !before.Equal(notBefore) || !after.Equal(notAfter) {
		t.Fatalf("window = %v..%v, want %v..%v", before, after, notBefore, notAfter)
	}
}

// An unreadable certificate must not stop renewal: the stored expiry still drives it.
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
		if !notAfter.Equal(expiresAt) || !clientCertRenewalDue(notBefore, notAfter, expiresAt.Add(-7*certTestDay)) {
			t.Fatalf("%s: window %v..%v is not due a week before the stored expiry", path, notBefore, notAfter)
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
