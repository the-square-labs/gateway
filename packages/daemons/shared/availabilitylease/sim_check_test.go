package availabilitylease

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"sort"
	"strings"
	"sync"
	"time"
)

// fakeSigner and fakeVerifier keep the simulation fast; wire-mode seeds and
// the crypto tests use real ECDSA P-256.
type fakeSigner struct{ id string }

func (s fakeSigner) Sign([]byte) ([]byte, error) { return []byte(s.id), nil }

type fakeVerifier struct{}

func (fakeVerifier) Verify(publicKey, _, signature []byte) bool {
	return len(publicKey) > 3 && string(publicKey[3:]) == string(signature)
}

type wireIdentity struct {
	key *ecdsa.PrivateKey
	der []byte
}

var (
	wireMu         sync.Mutex
	wireIdentities = map[string]wireIdentity{}
)

func (n *simNode) wirePublicKey() []byte { return wireIdentityFor(n.id).der }

func wireIdentityFor(id string) wireIdentity {
	wireMu.Lock()
	defer wireMu.Unlock()
	if identity, ok := wireIdentities[id]; ok {
		return identity
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		panic(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		panic(err)
	}
	identity := wireIdentity{key: key, der: der}
	wireIdentities[id] = identity
	return identity
}

func (w *simWorld) newNode(id string, relay bool, rate float64) *simNode {
	n := w.addNode(id, relay, rate)
	if w.wire {
		identity := wireIdentityFor(id)
		n.signer, n.verify = ECDSASigner{Key: identity.key}, &ECDSAVerifier{}
	} else {
		n.signer, n.verify = fakeSigner{id: id}, fakeVerifier{}
	}
	return n
}

// checkInvariants runs after every simulated event.
//
//	I1: strict mode, at most one live container per key. Containers on a
//	    frozen VM do not run; after resume they are the A2.5 residual until
//	    they renew or die, and I2 still has to refuse them.
//	I2: at most one holder admitted by all relay gates together.
func (w *simWorld) checkInvariants() {
	for _, key := range w.keys {
		if !w.strict[key.PolicyID] {
			continue
		}
		if w.checkI1 {
			var live []string
			for _, id := range w.daemons {
				n := w.nodes[id]
				if !n.hostUp || n.frozen {
					continue
				}
				if c := n.containers[key]; c != nil && c.live && !c.residual {
					live = append(live, id)
				}
			}
			if len(live) > 1 {
				w.fail("I1 violated: key %s has live containers on %s", key, strings.Join(live, ","))
				return
			}
		}
		if w.checkI2 {
			holders := map[string]string{}
			for _, id := range w.relays {
				n := w.nodes[id]
				if !n.processUp() || n.frozen || n.node == nil {
					continue
				}
				if decision := n.node.Gate(key); decision.Open {
					holders[decision.Holder] = id
				}
			}
			if len(holders) > 0 {
				w.gateOpenChecks++
			}
			w.gateChecks++
			if len(holders) > 1 {
				var parts []string
				for _, holder := range sortedKeys(holders) {
					parts = append(parts, holder+"@"+holders[holder])
				}
				w.fail("I2 violated: key %s admitted for %s", key, strings.Join(parts, ","))
				return
			}
		}
	}
}

// liveCopies returns daemons with a live container for key.
func (w *simWorld) liveCopies(key Key) []string {
	var out []string
	for _, id := range w.daemons {
		n := w.nodes[id]
		if c := n.containers[key]; n.hostUp && c != nil && c.live {
			out = append(out, id)
		}
	}
	sort.Strings(out)
	return out
}

// holder returns the unique node holding key with a live container.
func (w *simWorld) holder(key Key) string {
	var found []string
	for _, id := range w.daemons {
		n := w.nodes[id]
		if !n.processUp() || n.frozen || n.node == nil {
			continue
		}
		c := n.containers[key]
		if c != nil && c.live && !c.residual && n.node.HolderStatus(key).Holding {
			found = append(found, id)
		}
	}
	if len(found) != 1 {
		return ""
	}
	return found[0]
}

// waitFor runs until cond holds or timeout passes; it reports success.
func (w *simWorld) waitFor(timeout time.Duration, cond func() bool) bool {
	end := w.now + timeout
	for w.violation == "" {
		if cond() {
			return true
		}
		if w.now >= end {
			return false
		}
		w.runUntil(w.now + 250*time.Millisecond)
	}
	return false
}
