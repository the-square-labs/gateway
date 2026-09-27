package lease

import (
	"crypto"
	"crypto/x509"
	"errors"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	"github.com/wiolett-industries/gateway/relay/internal/identity"
)

// IdentitySigner signs frames with the relay's external server certificate
// key (ECDSA P-256), the identity daemons verify it by. It reads the current
// identity on every signature, so a certificate rotation takes effect at once;
// Gateway publishes the new public key in the next voter config.
type IdentitySigner struct {
	Identity *identity.Store
}

func (s IdentitySigner) key() (crypto.Signer, error) {
	current := s.Identity.Current()
	if current == nil {
		return nil, errors.New("relay identity is not loaded")
	}
	signer, ok := current.External.PrivateKey.(crypto.Signer)
	if !ok {
		return nil, errors.New("relay identity key cannot sign")
	}
	return signer, nil
}

func (s IdentitySigner) Sign(message []byte) ([]byte, error) {
	key, err := s.key()
	if err != nil {
		return nil, err
	}
	return availabilitylease.ECDSASigner{Key: key}.Sign(message)
}

// PublicKey returns the PKIX DER public key reported to Gateway as the relay's
// lease identity key.
func (s IdentitySigner) PublicKey() []byte {
	key, err := s.key()
	if err != nil {
		return nil
	}
	encoded, err := x509.MarshalPKIXPublicKey(key.Public())
	if err != nil {
		return nil
	}
	return encoded
}
