package docker

import (
	"bytes"
	"crypto"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	"github.com/wiolett-industries/gateway/docker-daemon/internal/lease"
)

// identityRotationOverlap bounds how long the previous identity key keeps
// signing after a certificate renewal when manifests never catch up.
const identityRotationOverlap = 24 * time.Hour

// identityKeySigner signs lease frames with the node's mTLS identity key
// (ECDSA P-256, D3). Peers verify frames against the key the adopted
// manifests list for this node, so a certificate renewal must not switch
// keys at once (H3): the previous key keeps signing until every adopted
// manifest naming this node lists the new key, or 24 h passed. The previous
// key is kept on disk so a daemon restart inside the overlap keeps it.
//
// Dual signatures (old and new key on every frame) need T1's multi-signature
// frame API; until it lands the signer picks the key the manifests list.
type identityKeySigner struct {
	certPath, keyPath, previousPath string
	now                             func() time.Time

	mu        sync.Mutex
	modTime   time.Time
	key       crypto.Signer
	previous  crypto.Signer
	rotatedAt time.Time
	// newListed is true once every adopted manifest naming this node lists
	// the current key (lease.KeyListener).
	newListed bool
}

var _ lease.KeyListener = (*identityKeySigner)(nil)

type previousIdentity struct {
	RotatedAtUnixMs int64  `json:"rotatedAtUnixMs"`
	KeyPEM          []byte `json:"keyPem"`
}

func newIdentityKeySigner(certPath, keyPath, previousPath string) (*identityKeySigner, error) {
	signer := &identityKeySigner{certPath: certPath, keyPath: keyPath, previousPath: previousPath, now: time.Now}
	if _, err := signer.current(); err != nil {
		return nil, err
	}
	signer.loadPrevious()
	return signer, nil
}

// current returns the newest key, reloading it after a renewal and keeping
// the key it replaced as the previous one.
func (s *identityKeySigner) current() (crypto.Signer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	info, err := os.Stat(s.keyPath)
	if err != nil {
		if s.key != nil {
			return s.key, nil
		}
		return nil, err
	}
	if s.key != nil && info.ModTime().Equal(s.modTime) {
		return s.key, nil
	}
	pair, err := tls.LoadX509KeyPair(s.certPath, s.keyPath)
	if err != nil {
		if s.key != nil {
			return s.key, nil
		}
		return nil, err
	}
	key, ok := pair.PrivateKey.(crypto.Signer)
	if !ok {
		return nil, errors.New("node identity key cannot sign")
	}
	if s.key != nil && !bytes.Equal(publicDER(s.key), publicDER(key)) {
		s.previous, s.rotatedAt, s.newListed = s.key, s.now(), false
		s.savePreviousLocked()
	}
	s.key, s.modTime = key, info.ModTime()
	return key, nil
}

// signingKey is the key peers can verify: the previous one while manifests
// still list it, inside the overlap.
func (s *identityKeySigner) signingKey() (crypto.Signer, error) {
	key, err := s.current()
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.previous != nil && !s.newListed && s.now().Sub(s.rotatedAt) < identityRotationOverlap {
		return s.previous, nil
	}
	return key, nil
}

func (s *identityKeySigner) Sign(message []byte) ([]byte, error) {
	key, err := s.signingKey()
	if err != nil {
		return nil, fmt.Errorf("load node identity key: %w", err)
	}
	return availabilitylease.ECDSASigner{Key: key}.Sign(message)
}

// ObserveListedKeys implements lease.KeyListener: listed holds, per adopted
// manifest naming this node, the key it lists for it.
func (s *identityKeySigner) ObserveListedKeys(listed [][]byte) {
	key, err := s.current()
	if err != nil {
		return
	}
	current := publicDER(key)
	all := true
	for _, der := range listed {
		all = all && bytes.Equal(der, current)
	}
	s.mu.Lock()
	switched := all && !s.newListed && s.previous != nil
	s.newListed = all
	if switched {
		s.previous = nil
		_ = os.Remove(s.previousPath)
	}
	s.mu.Unlock()
}

// publicKeyDER is the newest key: the one reported to the Gateway so it
// republishes manifests with it.
func (s *identityKeySigner) publicKeyDER() []byte {
	key, err := s.current()
	if err != nil {
		return nil
	}
	return publicDER(key)
}

func publicDER(key crypto.Signer) []byte {
	der, err := x509.MarshalPKIXPublicKey(key.Public())
	if err != nil {
		return nil
	}
	return der
}

func (s *identityKeySigner) savePreviousLocked() {
	if s.previousPath == "" {
		return
	}
	der, err := x509.MarshalPKCS8PrivateKey(s.previous)
	if err != nil {
		return
	}
	data, _ := json.Marshal(previousIdentity{
		RotatedAtUnixMs: s.rotatedAt.UnixMilli(),
		KeyPEM:          pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}),
	})
	if err := os.MkdirAll(filepath.Dir(s.previousPath), 0o700); err == nil {
		_ = writeDurableFile(s.previousPath, data)
	}
}

func (s *identityKeySigner) loadPrevious() {
	data, err := os.ReadFile(s.previousPath)
	if err != nil {
		return
	}
	var stored previousIdentity
	if json.Unmarshal(data, &stored) != nil {
		return
	}
	block, _ := pem.Decode(stored.KeyPEM)
	rotatedAt := time.UnixMilli(stored.RotatedAtUnixMs)
	if block == nil || s.now().Sub(rotatedAt) >= identityRotationOverlap {
		_ = os.Remove(s.previousPath)
		return
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return
	}
	if key, ok := parsed.(crypto.Signer); ok {
		s.mu.Lock()
		s.previous, s.rotatedAt = key, rotatedAt
		s.mu.Unlock()
	}
}

func writeDurableFile(path string, data []byte) error {
	temporary, err := os.CreateTemp(filepath.Dir(path), ".identity-*.tmp")
	if err != nil {
		return err
	}
	name := temporary.Name()
	defer os.Remove(name)
	if err := temporary.Chmod(0o600); err != nil {
		_ = temporary.Close()
		return err
	}
	if _, err := temporary.Write(data); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	return os.Rename(name, path)
}
