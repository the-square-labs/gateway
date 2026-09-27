package lease

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

type fixedKeys struct {
	current, previous crypto.Signer
	renewedAt         time.Time
}

func (k fixedKeys) Keys() (crypto.Signer, crypto.Signer, time.Time) {
	return k.current, k.previous, k.renewedAt
}

func verifies(key *ecdsa.PrivateKey, message, signature []byte) bool {
	digest := sha256.Sum256(message)
	return ecdsa.VerifyASN1(&key.PublicKey, digest[:], signature)
}

func acceptMessage(policy string) []byte {
	message := append([]byte(domainAccept), 0)
	message = binary.BigEndian.AppendUint32(message, uint32(len(policy)))
	return append(append(message, policy...), 0, 0, 0, 0, 0, 0, 0, 1)
}

// H3: after a renewal the relay keeps its previous identity key while an
// open manifest still lists it: frames carry both signatures, accepts use the
// key of their own policy's manifest, and the overlap ends when every open
// manifest lists the new key or after KeyOverlap.
func TestIdentitySignerKeepsThePreviousKeyWhileManifestsListIt(t *testing.T) {
	oldKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	newKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	policyPublic, policyPrivate, _ := ed25519.GenerateKey(rand.Reader)
	now := time.Unix(1_800_000_000, 0)
	view := newMemberView()
	view.trust("k1", policyPublic)
	versions := map[string]uint64{}
	publish := func(policy string, key *ecdsa.PrivateKey, closed bool) {
		versions[policy]++
		value := &relayv1.LeaseManifest{SchemaVersion: 1, PolicyId: policy, ManifestVersion: versions[policy], Slots: 1, Closed: closed,
			Members: []*relayv1.LeaseMember{{Id: relayID, PublicKey: publicKeyDER(key), Role: relayv1.LeaseMemberRole_LEASE_MEMBER_ROLE_RELAY}}}
		payload, _ := proto.Marshal(value)
		if !view.adoptBlock(availabilitylease.SignPolicyBlock("k1", policyPrivate, relayv1.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, payload)) {
			t.Fatalf("manifest %s was not adopted", policy)
		}
	}
	publish("p-old", oldKey, false)
	publish("p-new", newKey, false)
	signer := NewIdentitySigner(relayID, fixedKeys{current: newKey, previous: oldKey, renewedAt: now})
	signer.bind(view, func() time.Time { return now })

	frame := []byte("gateway-availability-lease/frame/v1\x00payload")
	signatures, err := signer.SignAll(frame)
	if err != nil || len(signatures) != 2 || !verifies(oldKey, frame, signatures[0]) || !verifies(newKey, frame, signatures[1]) {
		t.Fatalf("frame during the overlap: %d signatures, err %v", len(signatures), err)
	}
	if primary, _ := signer.Sign(frame); !verifies(oldKey, frame, primary) {
		t.Fatal("single frame signature does not use the key open manifests still list")
	}
	for policy, key := range map[string]*ecdsa.PrivateKey{"p-old": oldKey, "p-new": newKey} {
		message := acceptMessage(policy)
		signature, err := signer.Sign(message)
		if err != nil || !verifies(key, message, signature) {
			t.Fatalf("accept for %s is not signed with the key its manifest lists", policy)
		}
	}

	// Every open manifest lists the new key; a closed one with the old key
	// does not hold the overlap open.
	publish("p-old", newKey, false)
	publish("p-closed", oldKey, true)
	if signatures, _ := signer.SignAll(frame); len(signatures) != 1 || !verifies(newKey, frame, signatures[0]) {
		t.Fatal("overlap did not end once every open manifest listed the new key")
	}

	// A manifest that never republishes cannot keep the old key beyond 24 h.
	publish("p-stale", oldKey, false)
	if signatures, _ := signer.SignAll(frame); len(signatures) != 2 {
		t.Fatal("stale manifest did not reopen the overlap within 24 h")
	}
	now = now.Add(KeyOverlap)
	if signatures, _ := signer.SignAll(frame); len(signatures) != 1 || !verifies(newKey, frame, signatures[0]) {
		t.Fatal("overlap outlived KeyOverlap")
	}
	if string(signer.PublicKey()) != string(publicKeyDER(newKey)) {
		t.Fatal("reported identity key is not the current key")
	}
}
