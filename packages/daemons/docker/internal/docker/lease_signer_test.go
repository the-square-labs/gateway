package docker

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
)

var identityFileTick = time.Unix(1_900_000_000, 0)

// writeIdentityFiles writes an mTLS certificate and key for key, as a
// certificate renewal does, with a fresh modification time.
func writeIdentityFiles(t *testing.T, dir string, key *ecdsa.PrivateKey) (string, string) {
	t.Helper()
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "node"}, NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(time.Hour)}
	certDER, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, _ := x509.MarshalECPrivateKey(key)
	certPath, keyPath := filepath.Join(dir, "node.pem"), filepath.Join(dir, "node.key")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	identityFileTick = identityFileTick.Add(time.Minute)
	_ = os.Chtimes(keyPath, identityFileTick, identityFileTick)
	return certPath, keyPath
}

func signedBy(t *testing.T, signer *identityKeySigner, key *ecdsa.PrivateKey) bool {
	t.Helper()
	message := []byte("frame")
	signature, err := signer.Sign(message)
	if err != nil {
		t.Fatal(err)
	}
	return (&availabilitylease.ECDSAVerifier{}).Verify(e2eDER(key), message, signature)
}

func TestIdentityRotationKeepsTheListedKeyUntilManifestsCatchUp(t *testing.T) {
	dir := t.TempDir()
	oldKey, newKey := e2eKey(), e2eKey()
	certPath, keyPath := writeIdentityFiles(t, dir, oldKey)
	previousPath := filepath.Join(dir, "state", "previous-identity.json")
	signer, err := newIdentityKeySigner(certPath, keyPath, previousPath)
	if err != nil {
		t.Fatal(err)
	}
	if !signedBy(t, signer, oldKey) {
		t.Fatal("signer must use the enrolled key")
	}
	writeIdentityFiles(t, dir, newKey) // certificate renewal
	signer.ObserveListedKeys([][]byte{e2eDER(oldKey), e2eDER(newKey)})
	if !signedBy(t, signer, oldKey) {
		t.Fatal("while any adopted manifest lists the old key, frames stay signed with it (H3)")
	}
	if string(signer.publicKeyDER()) != string(e2eDER(newKey)) {
		t.Fatal("the Gateway must learn the new key from the report")
	}

	// A daemon restart inside the overlap keeps the previous key.
	restarted, err := newIdentityKeySigner(certPath, keyPath, previousPath)
	if err != nil {
		t.Fatal(err)
	}
	if !signedBy(t, restarted, oldKey) {
		t.Fatal("the previous key must survive a daemon restart inside the overlap")
	}

	signer.ObserveListedKeys([][]byte{e2eDER(newKey), e2eDER(newKey)})
	if !signedBy(t, signer, newKey) {
		t.Fatal("once every manifest lists the new key, frames switch to it")
	}
	if _, err := os.Stat(previousPath); !os.IsNotExist(err) {
		t.Fatal("the previous key is dropped after the switch")
	}

	// Manifests that never catch up (a closed policy) cap the overlap at 24 h.
	late, err := newIdentityKeySigner(certPath, keyPath, filepath.Join(dir, "late.json"))
	if err != nil {
		t.Fatal(err)
	}
	nextKey := e2eKey()
	clock := time.Now()
	late.now = func() time.Time { return clock }
	writeIdentityFiles(t, dir, nextKey)
	late.ObserveListedKeys([][]byte{e2eDER(newKey)})
	if !signedBy(t, late, newKey) {
		t.Fatal("inside the overlap the listed key signs")
	}
	clock = clock.Add(identityRotationOverlap)
	if !signedBy(t, late, nextKey) {
		t.Fatal("after 24 h the new key signs regardless")
	}
}
