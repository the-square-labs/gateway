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

func signedBy(t *testing.T, signer availabilitylease.Signer, key *ecdsa.PrivateKey) bool {
	t.Helper()
	message := []byte("frame")
	signature, err := signer.Sign(message)
	if err != nil {
		t.Fatal(err)
	}
	return (&availabilitylease.ECDSAVerifier{}).Verify(e2eDER(key), message, signature)
}

func TestIdentityKeysHandRenewalsToTheNodeAndSurviveRestarts(t *testing.T) {
	dir := t.TempDir()
	oldKey, newKey := e2eKey(), e2eKey()
	certPath, keyPath := writeIdentityFiles(t, dir, oldKey)
	previousPath := filepath.Join(dir, "state", "previous-identity.json")
	keys, err := newIdentityKeys(certPath, keyPath, previousPath)
	if err != nil {
		t.Fatal(err)
	}
	if !signedBy(t, keys.InitialSigner(), oldKey) {
		t.Fatal("the node starts with the enrolled key")
	}
	if _, _, pending := keys.PendingRotation(); pending {
		t.Fatal("no rotation before a renewal")
	}
	writeIdentityFiles(t, dir, newKey) // certificate renewal
	next, der, pending := keys.PendingRotation()
	if !pending || !signedBy(t, next, newKey) || string(der) != string(e2eDER(newKey)) {
		t.Fatal("a renewal must be handed to the node as a rotation")
	}
	keys.RotationApplied(der)
	if _, _, again := keys.PendingRotation(); again {
		t.Fatal("an applied rotation is not handed twice")
	}
	if string(keys.publicKeyDER()) != string(e2eDER(newKey)) {
		t.Fatal("the report carries the renewed key")
	}

	// A daemon restart inside the overlap starts with the previous key and
	// rotates to the renewed one again (T1's overlap is in memory).
	restarted, err := newIdentityKeys(certPath, keyPath, previousPath)
	if err != nil {
		t.Fatal(err)
	}
	if !signedBy(t, restarted.InitialSigner(), oldKey) {
		t.Fatal("a restart inside the overlap starts with the previous key")
	}
	if next, _, pending := restarted.PendingRotation(); !pending || !signedBy(t, next, newKey) {
		t.Fatal("the restarted daemon rotates to the renewed key again")
	}
	restarted.OverlapEnded()
	if _, err := os.Stat(previousPath); !os.IsNotExist(err) {
		t.Fatal("the previous key is dropped once the overlap ends")
	}

	// A persisted previous key older than the overlap is ignored.
	keys.RotationApplied(e2eDER(newKey)) // no-op: already applied
	stale, err := newIdentityKeys(certPath, keyPath, previousPath)
	if err != nil {
		t.Fatal(err)
	}
	stale.now = func() time.Time { return time.Now().Add(availabilitylease.IdentityKeyOverlap) }
	if _, _, ok := stale.loadPrevious(); ok {
		t.Fatal("a previous key past the 24 h overlap must not be used")
	}
}
