package lease

import (
	"bytes"
	"crypto"
	"crypto/x509"
	"encoding/binary"
	"errors"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	"github.com/wiolett-industries/gateway/relay/internal/identity"
)

// KeyOverlap bounds how long the relay keeps signing with its previous
// identity key after a certificate renewal changed the key (H3).
const KeyOverlap = 24 * time.Hour

const domainAccept = "gateway-availability-lease/accept/v1"

// IdentityKeys yields the relay's identity keys: the current external server
// certificate key and, after a renewal replaced it, the previous one with the
// time the current certificate became valid.
type IdentityKeys interface {
	Keys() (current, previous crypto.Signer, renewedAt time.Time)
}

// StoreKeys reads the keys from the relay identity store. The previous key is
// the retained external-server.previous.* pair, which also survives restarts.
type StoreKeys struct {
	Identity *identity.Store
}

func (k StoreKeys) Keys() (crypto.Signer, crypto.Signer, time.Time) {
	snapshot := k.Identity.Current()
	if snapshot == nil {
		return nil, nil, time.Time{}
	}
	current, _ := snapshot.External.PrivateKey.(crypto.Signer)
	var renewedAt time.Time
	if snapshot.External.Leaf != nil {
		renewedAt = snapshot.External.Leaf.NotBefore
	}
	var previous crypto.Signer
	if snapshot.PreviousExternal != nil {
		previous, _ = snapshot.PreviousExternal.PrivateKey.(crypto.Signer)
	}
	return current, previous, renewedAt
}

// IdentitySigner signs lease frames and accept statements with the relay's
// identity (ECDSA P-256). After a renewal changed the key, peers verify the
// relay against the key their adopted manifests list, so the relay keeps the
// previous key while any open manifest naming it still lists that key, for at
// most KeyOverlap (H3):
//   - an accept statement is signed with the key its own policy's manifest
//     lists for the relay, so QCs verify under that manifest;
//   - a frame is signed with every key in use (SignAll), the previous key
//     first, so a peer holding either manifest version verifies it.
type IdentitySigner struct {
	ID   string
	Keys IdentityKeys
	// view tells which keys the adopted manifests list for this relay.
	view *memberView
	wall func() time.Time
}

// NewIdentitySigner builds the relay signer. The coordinator attaches its
// member view with bind before the first signature.
func NewIdentitySigner(id string, keys IdentityKeys) *IdentitySigner {
	return &IdentitySigner{ID: id, Keys: keys, wall: time.Now}
}

func (s *IdentitySigner) bind(view *memberView, wall func() time.Time) {
	s.view, s.wall = view, wall
}

// signingKeys returns the keys to sign with, primary first.
func (s *IdentitySigner) signingKeys(message []byte) ([]crypto.Signer, error) {
	current, previous, renewedAt := s.Keys.Keys()
	if current == nil {
		return nil, errors.New("relay identity key cannot sign")
	}
	previousDER := publicKeyDER(previous)
	currentDER := publicKeyDER(current)
	if previous == nil || previousDER == nil || bytes.Equal(previousDER, currentDER) || s.view == nil ||
		(!renewedAt.IsZero() && !s.wall().Before(renewedAt.Add(KeyOverlap))) {
		return []crypto.Signer{current}, nil
	}
	if policyID, ok := acceptPolicy(message); ok {
		if listed, found := s.view.memberKey(policyID, s.ID); found && bytes.Equal(listed, previousDER) {
			return []crypto.Signer{previous}, nil
		}
		return []crypto.Signer{current}, nil
	}
	if s.view.listsOtherKey(s.ID, currentDER) {
		return []crypto.Signer{previous, current}, nil
	}
	return []crypto.Signer{current}, nil
}

// Sign signs with the primary key: the previous one while open manifests
// still list it, else the current one.
func (s *IdentitySigner) Sign(message []byte) ([]byte, error) {
	keys, err := s.signingKeys(message)
	if err != nil {
		return nil, err
	}
	return availabilitylease.ECDSASigner{Key: keys[0]}.Sign(message)
}

// SignAll signs with every key in use, primary first.
func (s *IdentitySigner) SignAll(message []byte) ([][]byte, error) {
	keys, err := s.signingKeys(message)
	if err != nil {
		return nil, err
	}
	signatures := make([][]byte, 0, len(keys))
	for _, key := range keys {
		signature, err := availabilitylease.ECDSASigner{Key: key}.Sign(message)
		if err != nil {
			return nil, err
		}
		signatures = append(signatures, signature)
	}
	return signatures, nil
}

// PublicKey returns the PKIX DER current public key, reported to Gateway as
// the relay's lease identity key so it publishes it in the next manifests.
func (s *IdentitySigner) PublicKey() []byte {
	current, _, _ := s.Keys.Keys()
	return publicKeyDER(current)
}

func publicKeyDER(key crypto.Signer) []byte {
	if key == nil {
		return nil
	}
	encoded, err := x509.MarshalPKIXPublicKey(key.Public())
	if err != nil {
		return nil
	}
	return encoded
}

// acceptPolicy extracts the policy id of an accept statement (doc.go wire
// contract: domain 0x00 str(policy_id) ...).
func acceptPolicy(message []byte) (string, bool) {
	prefix := append([]byte(domainAccept), 0)
	if !bytes.HasPrefix(message, prefix) || len(message) < len(prefix)+4 {
		return "", false
	}
	rest := message[len(prefix):]
	size := binary.BigEndian.Uint32(rest)
	if uint64(len(rest)-4) < uint64(size) {
		return "", false
	}
	return string(rest[4 : 4+size]), true
}
