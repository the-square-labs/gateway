package nginx

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDeployCertWritesCertificateAndChainToFullchain(t *testing.T) {
	certsDir := t.TempDir()
	certPem := []byte("leaf certificate")
	chainPem := []byte("intermediate certificate\nroot certificate\n")
	keyPem := []byte("private key")

	if err := DeployCert(certsDir, "cert-id", certPem, keyPem, chainPem); err != nil {
		t.Fatalf("DeployCert() error = %v", err)
	}

	certDir := filepath.Join(certsDir, "cert-id")
	assertFileContent(t, filepath.Join(certDir, "fullchain.pem"), "leaf certificate\nintermediate certificate\nroot certificate\n")
	assertFileContent(t, filepath.Join(certDir, "chain.pem"), string(chainPem))
	assertFileContent(t, filepath.Join(certDir, "privkey.pem"), string(keyPem))

	keyInfo, err := os.Stat(filepath.Join(certDir, "privkey.pem"))
	if err != nil {
		t.Fatalf("stat private key: %v", err)
	}
	if got, want := keyInfo.Mode().Perm(), os.FileMode(0600); got != want {
		t.Fatalf("private key mode = %o, want %o", got, want)
	}
}

func TestDeployCertWritesOnlyCertificateWhenChainIsEmpty(t *testing.T) {
	certsDir := t.TempDir()
	certPem := []byte("leaf certificate\n")

	if err := DeployCert(certsDir, "cert-id", certPem, []byte("private key"), nil); err != nil {
		t.Fatalf("DeployCert() error = %v", err)
	}

	certDir := filepath.Join(certsDir, "cert-id")
	assertFileContent(t, filepath.Join(certDir, "fullchain.pem"), string(certPem))
	if _, err := os.Stat(filepath.Join(certDir, "chain.pem")); !os.IsNotExist(err) {
		t.Fatalf("chain.pem stat error = %v, want not exist", err)
	}
}

func assertFileContent(t *testing.T, path, want string) {
	t.Helper()

	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	if got := string(content); got != want {
		t.Fatalf("%s content = %q, want %q", path, got, want)
	}
}
