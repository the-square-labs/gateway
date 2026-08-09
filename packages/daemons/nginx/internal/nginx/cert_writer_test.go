package nginx

import (
	"bytes"
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

func TestVersionedCertificateSwitchesCurrentAndCanBeRestored(t *testing.T) {
	certsDir := t.TempDir()
	certID := "11111111-1111-4111-8111-111111111111"
	versionOne := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	versionTwo := "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

	if _, err := DeployVersionedCert(certsDir, certID, versionOne, "1", []byte("leaf one"), []byte("key one"), []byte("chain one")); err != nil {
		t.Fatalf("DeployVersionedCert(versionOne) error = %v", err)
	}
	pointer, err := DeployVersionedCert(certsDir, certID, versionTwo, "2", []byte("leaf two"), []byte("key two"), []byte("chain two"))
	if err != nil {
		t.Fatalf("DeployVersionedCert(versionTwo) error = %v", err)
	}

	snapshot, err := InspectCertificate(certsDir, certID)
	if err != nil {
		t.Fatalf("InspectCertificate() error = %v", err)
	}
	if !snapshot.Present || snapshot.Version != versionTwo {
		t.Fatalf("snapshot = %#v, want present version %q", snapshot, versionTwo)
	}
	if err := RestoreCertPointer(certsDir, certID, pointer); err != nil {
		t.Fatalf("RestoreCertPointer() error = %v", err)
	}
	assertFileContent(t, filepath.Join(certsDir, certID, "current", "fullchain.pem"), "leaf one\nchain one")
	assertFileContent(t, filepath.Join(certsDir, certID, ".gateway-replica-generation"), "1")
}

func TestLegacyExportReturnsLeafAndChainWithoutDuplication(t *testing.T) {
	certsDir := t.TempDir()
	certID := "22222222-2222-4222-8222-222222222222"
	leaf := []byte("leaf certificate")
	chain := []byte("intermediate certificate\n")
	key := []byte("private key")
	if err := DeployCert(certsDir, certID, leaf, key, chain); err != nil {
		t.Fatalf("DeployCert() error = %v", err)
	}

	certPem, keyPem, chainPem, err := ReadCertificateForExport(certsDir, certID)
	if err != nil {
		t.Fatalf("ReadCertificateForExport() error = %v", err)
	}
	if !bytes.Equal(certPem, leaf) || !bytes.Equal(keyPem, key) || !bytes.Equal(chainPem, chain) {
		t.Fatalf("unexpected export cert=%q key=%q chain=%q", certPem, keyPem, chainPem)
	}
}

func TestRemoveCertificateReplicaRequiresExpectedVersionAndGeneration(t *testing.T) {
	certsDir := t.TempDir()
	certID := "33333333-3333-4333-8333-333333333333"
	version := "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	if _, err := DeployVersionedCert(certsDir, certID, version, "7", []byte("leaf"), []byte("key"), nil); err != nil {
		t.Fatalf("DeployVersionedCert() error = %v", err)
	}
	if err := RemoveCertificateReplica(certsDir, certID, "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd", "7"); err == nil {
		t.Fatal("RemoveCertificateReplica() expected generation mismatch")
	}
	if _, err := os.Stat(filepath.Join(certsDir, certID)); err != nil {
		t.Fatalf("certificate directory was removed on mismatch: %v", err)
	}
	if err := RemoveCertificateReplica(certsDir, certID, version, "8"); err == nil {
		t.Fatal("RemoveCertificateReplica() expected replica generation mismatch")
	}
	if err := RemoveCertificateReplica(certsDir, certID, version, "7"); err != nil {
		t.Fatalf("RemoveCertificateReplica() error = %v", err)
	}
	if _, err := os.Stat(filepath.Join(certsDir, certID)); !os.IsNotExist(err) {
		t.Fatalf("certificate directory stat error = %v, want not exist", err)
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
