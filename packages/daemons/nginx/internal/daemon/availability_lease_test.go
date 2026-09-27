package daemon

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"math/big"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// fakeLeaseClock is a manually-advanced availabilitylease.Clock, so restart
// and abstention tests do not depend on real elapsed time.
type fakeLeaseClock struct{ now time.Duration }

func (c *fakeLeaseClock) Now() time.Duration { return c.now }

func generateTestIdentity(t *testing.T) (*ecdsa.PrivateKey, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicKey, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return key, publicKey
}

// writeTestClientPair writes a self-signed ECDSA P-256 client certificate and
// key to dir, as the daemon's mTLS identity files, and returns their paths
// together with the private key.
func writeTestClientPair(t *testing.T, dir, commonName string) (certPath, keyPath string, key *ecdsa.PrivateKey) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: commonName},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPath = filepath.Join(dir, "client.crt")
	keyPath = filepath.Join(dir, "client.key")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	return certPath, keyPath, key
}

func TestLoadAvailabilityLeaseIdentityAcceptsP256AndReturnsItsPublicKey(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, key := writeTestClientPair(t, dir, "node-1")
	identityKey, publicKey, err := loadAvailabilityLeaseIdentity(certPath, keyPath)
	if err != nil {
		t.Fatal(err)
	}
	if identityKey.D.Cmp(key.D) != 0 {
		t.Fatal("loaded identity key does not match the written key")
	}
	wantPublicKey, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if string(publicKey) != string(wantPublicKey) {
		t.Fatal("loaded public key does not match the written key's public half")
	}
}

func TestAvailabilityLeaseCoordinatorEnsureNodeIsIdempotentAndGatesCapability(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, _ := writeTestClientPair(t, dir, "node-1")
	coordinator := newAvailabilityLeaseCoordinator(t.TempDir(), nil, nil)
	defer coordinator.close()

	if coordinator.ready() {
		t.Fatal("coordinator must not be ready before a node id is known")
	}
	if err := coordinator.ensureNode("node-1", certPath, keyPath); err != nil {
		t.Fatal(err)
	}
	if !coordinator.ready() {
		t.Fatal("coordinator must be ready once its node is constructed")
	}
	first := coordinator.currentNode()
	if err := coordinator.ensureNode("node-1", certPath, keyPath); err != nil {
		t.Fatal(err)
	}
	if coordinator.currentNode() != first {
		t.Fatal("ensureNode must not reconstruct an already-initialized node")
	}
}

// buildLeaseTestFixture signs a voter config naming nginxID as the sole voter
// and a manifest naming candidateID as the sole failover candidate of
// policyID, using a fresh Ed25519 policy key.
func buildLeaseTestFixture(nginxID, nginxPublicKey, candidateID string, candidatePublicKey []byte, policyID string) (
	policyPublic ed25519.PublicKey, voterBlock, manifestBlock *relayv1.LeaseSignedBlock,
) {
	policyPublic, policyPrivate, _ := ed25519.GenerateKey(rand.Reader)
	voterConfig := &relayv1.LeaseVoterConfig{
		SchemaVersion: 1, Epoch: 1,
		Members: []*relayv1.LeaseMember{
			{Id: nginxID, PublicKey: []byte(nginxPublicKey), Role: relayv1.LeaseMemberRole_LEASE_MEMBER_ROLE_DAEMON},
		},
		QuorumSets: []*relayv1.LeaseQuorumSet{{VoterIds: []string{nginxID}}},
	}
	voterPayload, _ := proto.Marshal(voterConfig)
	voterBlock = availabilitylease.SignPolicyBlock("k1", policyPrivate, relayv1.LeaseBlockKind_LEASE_BLOCK_KIND_VOTER_CONFIG, voterPayload)

	manifest := &relayv1.LeaseManifest{
		SchemaVersion: 1, PolicyId: policyID, ManifestVersion: 1,
		Mode: relayv1.LeasePolicyMode_LEASE_POLICY_MODE_FAILOVER, PartitionMode: relayv1.LeasePartitionMode_LEASE_PARTITION_MODE_STRICT,
		Slots: 1, Epoch: 1,
		Candidates:  []*relayv1.LeaseCandidate{{Id: candidateID, PublicKey: candidatePublicKey}},
		LeaseTermMs: uint32(availabilitylease.LeaseTerm.Milliseconds()),
	}
	manifestPayload, _ := proto.Marshal(manifest)
	manifestBlock = availabilitylease.SignPolicyBlock("k1", policyPrivate, relayv1.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, manifestPayload)
	return policyPublic, voterBlock, manifestBlock
}

func sendTestPrepare(t *testing.T, node *availabilitylease.Node, proposerID string, proposerKey *ecdsa.PrivateKey, key availabilitylease.Key, ballot *relayv1.LeaseBallot, epoch, manifestVersion uint64) {
	t.Helper()
	batch := &relayv1.LeaseBatch{
		MessageId: fmt.Sprintf("%s/%d/%d", proposerID, ballot.GetRound(), ballot.GetIncarnation()), SenderId: proposerID, SenderIncarnation: 1,
		DestinationId: node.ID(),
		Items: []*relayv1.LeaseItem{{Body: &relayv1.LeaseItem_Prepare{Prepare: &relayv1.LeasePrepare{
			Key: &relayv1.LeaseKey{PolicyId: key.PolicyID, Slot: key.Slot}, Ballot: ballot,
			Epoch: epoch, ManifestVersion: manifestVersion,
		}}}},
	}
	frame, err := availabilitylease.SealFrame(batch, availabilitylease.ECDSASigner{Key: proposerKey})
	if err != nil {
		t.Fatal(err)
	}
	if err := node.ReceiveFrame(frame); err != nil {
		t.Fatalf("prepare rejected: %v", err)
	}
}

// TestAvailabilityLeaseFileStorePersistsBallotAndAbstainsAfterRestart covers
// the acceptor restart rule (A3, A16) over the daemon's own durable store: a
// freshly started node abstains (only a shadow promise, nothing persisted),
// a node past its abstain window persists what it promises, and a restarted
// node recovers that promise from disk and abstains again for a fresh
// window.
func TestAvailabilityLeaseFileStorePersistsBallotAndAbstainsAfterRestart(t *testing.T) {
	stateDir := t.TempDir()
	nginxKey, nginxPublicKey := generateTestIdentity(t)
	candidateKey, candidatePublicKey := generateTestIdentity(t)

	policyPublic, voterBlock, manifestBlock := buildLeaseTestFixture(
		"nginx-1", string(nginxPublicKey), "docker-1", candidatePublicKey, "policy-1")

	buildNode := func(clock availabilitylease.Clock) *availabilitylease.Node {
		store := newAvailabilityLeaseFileStore(stateDir)
		node, err := availabilitylease.NewNode(availabilitylease.Config{
			ID: "nginx-1", Clock: clock, Store: store, Signer: availabilitylease.ECDSASigner{Key: nginxKey},
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := node.TrustPolicyKey("k1", policyPublic); err != nil {
			t.Fatal(err)
		}
		if _, err := node.AdoptVoterConfig(voterBlock); err != nil {
			t.Fatal(err)
		}
		if _, err := node.AdoptManifest(manifestBlock); err != nil {
			t.Fatal(err)
		}
		return node
	}

	key := availabilitylease.Key{PolicyID: "policy-1", Slot: 0}
	clock := &fakeLeaseClock{now: time.Hour}
	node := buildNode(clock)

	recordsBeforeAnyPrepare, err := newAvailabilityLeaseFileStore(stateDir).Load()
	if err != nil {
		t.Fatal(err)
	}

	// Fresh start: still inside the abstain window, so the vote is a shadow
	// promise. Nothing new reaches durable storage for it (A3).
	sendTestPrepare(t, node, "docker-1", candidateKey, key,
		&relayv1.LeaseBallot{Round: 1, Incarnation: 1, ProposerId: "docker-1"}, 1, 1)
	if views := node.AcceptorView(); len(views) != 1 || !views[0].Abstaining {
		t.Fatalf("a fresh node must abstain: %#v", views)
	}
	recordsAfterShadowPromise, err := newAvailabilityLeaseFileStore(stateDir).Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(recordsAfterShadowPromise) != len(recordsBeforeAnyPrepare) {
		t.Fatalf("a shadow promise made while abstaining must not be persisted: before=%d after=%d",
			len(recordsBeforeAnyPrepare), len(recordsAfterShadowPromise))
	}

	// Past the abstain window, the same node votes for real and persists it.
	clock.now += availabilitylease.AbstainAfterStart + time.Second
	sendTestPrepare(t, node, "docker-1", candidateKey, key,
		&relayv1.LeaseBallot{Round: 2, Incarnation: 1, ProposerId: "docker-1"}, 1, 1)
	views := node.AcceptorView()
	if len(views) != 1 || views[0].Abstaining || views[0].Promised.Round != 2 {
		t.Fatalf("a voting node must promise for real once past the abstain window: %#v", views)
	}
	recordsAfterRealPromise, err := newAvailabilityLeaseFileStore(stateDir).Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(recordsAfterRealPromise) <= len(recordsAfterShadowPromise) {
		t.Fatalf("a real promise must be persisted durably: shadow=%d real=%d",
			len(recordsAfterShadowPromise), len(recordsAfterRealPromise))
	}

	// Restart: a fresh Node over the same durable store recovers the
	// promised ballot from disk, bumps its incarnation, and abstains again,
	// without needing to see any frame at all (A3, A16).
	restarted := buildNode(&fakeLeaseClock{now: time.Hour})
	if restarted.Incarnation() <= node.Incarnation() {
		t.Fatalf("restarted node must bump its persisted incarnation: got %d, had %d", restarted.Incarnation(), node.Incarnation())
	}
	views = restarted.AcceptorView()
	if len(views) != 1 {
		t.Fatalf("restarted node lost track of the key: %#v", views)
	}
	if !views[0].Abstaining {
		t.Fatal("a restarted node must abstain again for a fresh window")
	}
	if views[0].Promised.Round < 2 {
		t.Fatalf("restarted node lost its persisted promise across restart: %#v", views[0].Promised)
	}
}

func TestAvailabilityLeaseCoordinatorApplyAndBuildReportRoundTrip(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, _ := writeTestClientPair(t, dir, "nginx-1")
	_, candidatePublicKey := generateTestIdentity(t)

	coordinator := newAvailabilityLeaseCoordinator(t.TempDir(), nil, nil)
	defer coordinator.close()
	if err := coordinator.ensureNode("nginx-1", certPath, keyPath); err != nil {
		t.Fatal(err)
	}
	nginxPublicKey := coordinator.identityPublicKey

	policyPublic, voterBlock, manifestBlock := buildLeaseTestFixture(
		"nginx-1", string(nginxPublicKey), "docker-1", candidatePublicKey, "policy-1")
	voterPayload, err := proto.Marshal(voterBlock)
	if err != nil {
		t.Fatal(err)
	}
	manifestPayload, err := proto.Marshal(manifestBlock)
	if err != nil {
		t.Fatal(err)
	}
	command := &pb.SyncAvailabilityLeaseCommand{
		Revision: 7, MemberId: "nginx-1",
		PolicyKeys:  []*pb.AvailabilityLeasePolicyKey{{KeyId: "k1", PublicKey: policyPublic}},
		VoterConfig: voterPayload,
		Manifests:   [][]byte{manifestPayload},
	}
	if _, err := coordinator.apply(command); err != nil {
		t.Fatal(err)
	}
	report := coordinator.buildReport()
	if report == nil {
		t.Fatal("buildReport returned nil after a successful apply")
	}
	if report.MemberId != "nginx-1" || report.LeaseRevision != 7 {
		t.Fatalf("report identity/revision: %#v", report)
	}
	if len(report.TrustedPolicyKeyIds) != 1 || report.TrustedPolicyKeyIds[0] != "k1" {
		t.Fatalf("report should ack the trusted policy key: %#v", report.TrustedPolicyKeyIds)
	}
	if len(report.Manifests) != 1 || report.Manifests[0].PolicyId != "policy-1" || report.Manifests[0].Closed {
		t.Fatalf("report should ack the adopted manifest: %#v", report.Manifests)
	}
}
