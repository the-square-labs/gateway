package availabilitylease

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/hex"
	"testing"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

type manualClock struct{ now time.Duration }

func (c *manualClock) Now() time.Duration { return c.now }

type captureTransport struct{ frames []*pb.CoordinationFrame }

func (c *captureTransport) Send(frame *pb.CoordinationFrame) { c.frames = append(c.frames, frame) }

func TestBallotOrderingPutsRoundFirst(t *testing.T) {
	a := Ballot{Round: 2, Incarnation: 1, Proposer: "z"}
	b := Ballot{Round: 1, Incarnation: 99, Proposer: "a"}
	c := Ballot{Round: 2, Incarnation: 2, Proposer: "a"}
	d := Ballot{Round: 2, Incarnation: 2, Proposer: "b"}
	if !b.Less(a) || !a.Less(c) || !c.Less(d) || d.Less(c) || a.Compare(a) != 0 {
		t.Fatal("ballot order must be (round, incarnation, proposer)")
	}
}

// The accept statement is part of the wire contract: the Gateway or any
// other implementation verifying QCs must produce these exact bytes.
func TestAcceptStatementGolden(t *testing.T) {
	got := hex.EncodeToString(acceptStatement(Key{PolicyID: "p", Slot: 1}, Ballot{Round: 2, Incarnation: 3, Proposer: "d"}, 4, 5, "r", 6))
	want := hex.EncodeToString([]byte("gateway-availability-lease/accept/v1\x00")) +
		"0000000170" + "0000000000000001" + "0000000000000002" + "0000000000000003" + "0000000164" +
		"0000000000000004" + "0000000000000005" + "0000000172" + "0000000000000006"
	if got != want {
		t.Fatalf("accept statement\n got %s\nwant %s", got, want)
	}
}

func newIdentity(t *testing.T) (*ecdsa.PrivateKey, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return key, der
}

// wireNode builds a relay node with real ECDSA identities, trusting a policy
// key and holding a config whose members are the given identities.
func wireNode(t *testing.T, id string, key *ecdsa.PrivateKey, members map[string][]byte) (*Node, *captureTransport, ed25519.PrivateKey) {
	t.Helper()
	_, policy, _ := ed25519.GenerateKey(rand.Reader)
	transport := &captureTransport{}
	node, err := NewNode(Config{ID: id, Clock: &manualClock{now: time.Hour}, Store: NewMemoryStore(), Transport: transport, Signer: ECDSASigner{Key: key}})
	if err != nil {
		t.Fatal(err)
	}
	if err := node.TrustPolicyKey("k1", policy.Public().(ed25519.PublicKey)); err != nil {
		t.Fatal(err)
	}
	config := &pb.LeaseVoterConfig{SchemaVersion: 1, Epoch: 1}
	var voters []string
	for _, member := range sortedKeys(members) {
		config.Members = append(config.Members, &pb.LeaseMember{Id: member, PublicKey: members[member], Role: pb.LeaseMemberRole_LEASE_MEMBER_ROLE_RELAY})
		voters = append(voters, member)
	}
	config.QuorumSets = []*pb.LeaseQuorumSet{{VoterIds: voters}}
	payload, _ := proto.Marshal(config)
	if _, err := node.AdoptVoterConfig(SignPolicyBlock("k1", policy, pb.LeaseBlockKind_LEASE_BLOCK_KIND_VOTER_CONFIG, payload)); err != nil {
		t.Fatal(err)
	}
	return node, transport, policy
}

// Relays route frames but cannot forge them: a changed payload or a frame
// signed with the relay's own key under another sender id is rejected.
func TestFramesAreAuthenticatedAgainstMemberKeys(t *testing.T) {
	relayKey, relayDER := newIdentity(t)
	senderKey, senderDER := newIdentity(t)
	node, _, _ := wireNode(t, "r1", relayKey, map[string][]byte{"r1": relayDER, "r2": senderDER})
	batch := &pb.LeaseBatch{MessageId: "m1", SenderId: "r2", SenderIncarnation: 1, DestinationId: "r1",
		Items: []*pb.LeaseItem{{Body: &pb.LeaseItem_Query{Query: &pb.LeaseQuery{}}}}}
	frame, err := SealFrame(batch, ECDSASigner{Key: senderKey})
	if err != nil {
		t.Fatal(err)
	}
	if err := node.ReceiveFrame(frame); err != nil {
		t.Fatalf("genuine frame rejected: %v", err)
	}
	tampered := proto.Clone(frame).(*pb.CoordinationFrame)
	tampered.Payload = append(append([]byte(nil), tampered.Payload...), 0x28, 0x01)
	if err := node.ReceiveFrame(tampered); err == nil {
		t.Fatal("tampered frame accepted")
	}
	forged, _ := SealFrame(batch, ECDSASigner{Key: relayKey})
	if err := node.ReceiveFrame(forged); err == nil {
		t.Fatal("frame signed by another member's key accepted")
	}
	misrouted := proto.Clone(frame).(*pb.CoordinationFrame)
	misrouted.SenderId = "r1"
	if err := node.ReceiveFrame(misrouted); err == nil {
		t.Fatal("frame whose routing disagrees with its payload accepted")
	}
}

func TestKeyChainFollowsSignedRotations(t *testing.T) {
	_, k1, _ := ed25519.GenerateKey(rand.Reader)
	_, k2, _ := ed25519.GenerateKey(rand.Reader)
	_, k3, _ := ed25519.GenerateKey(rand.Reader)
	_, rogue, _ := ed25519.GenerateKey(rand.Reader)
	chain := newKeyChain()
	if _, err := chain.trust("k1", k1.Public().(ed25519.PublicKey)); err != nil {
		t.Fatal(err)
	}
	link12 := SignPolicyKeyRotation("k1", k1, "k2", k2.Public().(ed25519.PublicKey))
	link23 := SignPolicyKeyRotation("k2", k2, "k3", k3.Public().(ed25519.PublicKey))
	if !chain.adoptAll([]*pb.LeasePolicyKeyRotation{link23, link12}) {
		t.Fatal("chain not adopted out of order")
	}
	if _, ok := chain.lookup("k3"); !ok {
		t.Fatal("k3 not reachable from k1")
	}
	block := SignPolicyBlock("k3", k3, pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, []byte("payload"))
	if err := chain.verifyBlock(block, domainManifest); err != nil {
		t.Fatalf("block signed by a reachable key rejected: %v", err)
	}
	if err := chain.verifyBlock(block, domainVoterConfig); err == nil {
		t.Fatal("signature verified under another domain")
	}
	// The relay policy envelope signs raw payload bytes; such a signature
	// must never verify as a lease block.
	raw := &pb.LeaseSignedBlock{SigningKeyId: "k3", Kind: pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST,
		Payload: []byte("payload"), Signature: ed25519.Sign(k3, []byte("payload"))}
	if err := chain.verifyBlock(raw, domainManifest); err == nil {
		t.Fatal("policy-envelope style signature accepted as a lease block")
	}
	if _, err := chain.adopt(SignPolicyKeyRotation("rogue", rogue, "k4", rogue.Public().(ed25519.PublicKey))); err == nil {
		t.Fatal("rotation from an untrusted key adopted")
	}
	bad := SignPolicyKeyRotation("k3", k3, "k5", rogue.Public().(ed25519.PublicKey))
	bad.PublicKeyFingerprint = "sha256:00"
	if _, err := chain.adopt(bad); err == nil {
		t.Fatal("rotation with a wrong fingerprint adopted")
	}
	if _, err := chain.trust("k1", k2.Public().(ed25519.PublicKey)); err == nil {
		t.Fatal("key id reused with other material")
	}
}

func manifestBlock(t *testing.T, key ed25519.PrivateKey, mutate func(*pb.LeaseManifest)) *pb.LeaseSignedBlock {
	t.Helper()
	value := &pb.LeaseManifest{
		SchemaVersion: 1, PolicyId: "p1", ManifestVersion: 1, Mode: pb.LeasePolicyMode_LEASE_POLICY_MODE_FAILOVER,
		PartitionMode: pb.LeasePartitionMode_LEASE_PARTITION_MODE_STRICT, Slots: 1, Epoch: 1, LeaseTermMs: 30000,
		Candidates: []*pb.LeaseCandidate{{Id: "d1", PublicKey: []byte("pk:d1")}, {Id: "d2", PublicKey: []byte("pk:d2")}},
	}
	if mutate != nil {
		mutate(value)
	}
	payload, _ := proto.Marshal(value)
	return SignPolicyBlock("k1", key, pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, payload)
}

func TestManifestValidation(t *testing.T) {
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	if _, err := parseManifest(manifestBlock(t, key, nil)); err != nil {
		t.Fatalf("valid manifest rejected: %v", err)
	}
	cases := map[string]func(*pb.LeaseManifest){
		"timing is fixed":                  func(m *pb.LeaseManifest) { m.LeaseTermMs = 20000 },
		"failover has one slot":            func(m *pb.LeaseManifest) { m.Slots = 2 },
		"bootstrap holder is a candidate":  func(m *pb.LeaseManifest) { m.BootstrapId = 1; m.Bootstrap = []*pb.LeaseBootstrapSlot{{HolderId: "x"}} },
		"bootstrap needs an id":            func(m *pb.LeaseManifest) { m.Bootstrap = []*pb.LeaseBootstrapSlot{{HolderId: "d1"}} },
		"duplicate candidates":             func(m *pb.LeaseManifest) { m.Candidates = append(m.Candidates, m.Candidates[0]) },
		"partition mode must be specified": func(m *pb.LeaseManifest) { m.PartitionMode = 0 },
	}
	for name, mutate := range cases {
		if _, err := parseManifest(manifestBlock(t, key, mutate)); err == nil {
			t.Errorf("%s: invalid manifest accepted", name)
		}
	}
}

// Joint consensus (D2, A4): a commit needs a majority of every quorum set.
func TestCommitNeedsMajorityOfEveryQuorumSetDuringJointEpoch(t *testing.T) {
	_, policy, _ := ed25519.GenerateKey(rand.Reader)
	node, err := NewNode(Config{ID: "obs", Clock: &manualClock{}, Store: NewMemoryStore(), Signer: fakeSigner{id: "obs"}, Verifier: fakeVerifier{}})
	if err != nil {
		t.Fatal(err)
	}
	_ = node.TrustPolicyKey("k1", policy.Public().(ed25519.PublicKey))
	config := &pb.LeaseVoterConfig{SchemaVersion: 1, Epoch: 7,
		QuorumSets: []*pb.LeaseQuorumSet{{VoterIds: []string{"a", "b", "c"}}, {VoterIds: []string{"c", "d", "e"}}}}
	for _, id := range []string{"a", "b", "c", "d", "e"} {
		config.Members = append(config.Members, &pb.LeaseMember{Id: id, PublicKey: []byte("pk:" + id), Role: pb.LeaseMemberRole_LEASE_MEMBER_ROLE_DAEMON})
	}
	payload, _ := proto.Marshal(config)
	if _, err := node.AdoptVoterConfig(SignPolicyBlock("k1", policy, pb.LeaseBlockKind_LEASE_BLOCK_KIND_VOTER_CONFIG, payload)); err != nil {
		t.Fatal(err)
	}
	if _, err := node.AdoptManifest(manifestBlock(t, policy, func(m *pb.LeaseManifest) { m.Epoch = 7 })); err != nil {
		t.Fatal(err)
	}
	ballot := Ballot{Round: 1, Incarnation: 1, Proposer: "d1"}
	commit := func(ids ...string) *pb.LeaseCommit {
		c := &pb.LeaseCommit{Key: keyP1.proto(), Ballot: ballot.proto(), Epoch: 7, ManifestVersion: 1}
		for _, id := range ids {
			c.Quorum = append(c.Quorum, &pb.LeaseAccepted{Key: keyP1.proto(), Ballot: ballot.proto(), Epoch: 7, ManifestVersion: 1,
				AcceptorId: id, AcceptorIncarnation: 1, Signature: []byte(id)})
		}
		return c
	}
	manifest := node.manifests["p1"]
	if err := node.verifyCommit(commit("a", "b", "d"), manifest); err == nil {
		t.Fatal("old-set majority alone accepted")
	}
	if err := node.verifyCommit(commit("c", "d", "e"), manifest); err == nil {
		t.Fatal("new-set majority alone accepted")
	}
	if err := node.verifyCommit(commit("a", "c", "d"), manifest); err != nil {
		t.Fatalf("majority of both sets rejected: %v", err)
	}
	forged := commit("a", "c", "d")
	forged.Quorum[1].Signature = []byte("x")
	if err := node.verifyCommit(forged, manifest); err == nil {
		t.Fatal("commit with a forged accept accepted")
	}
}

// A3: incarnation and promises survive a restart; every start abstains.
func TestRestartPersistsIncarnationAndAbstains(t *testing.T) {
	store := NewMemoryStore()
	clock := &manualClock{now: time.Minute}
	first, err := NewNode(Config{ID: "r1", Clock: clock, Store: store, Signer: fakeSigner{id: "r1"}, Verifier: fakeVerifier{}})
	if err != nil {
		t.Fatal(err)
	}
	first.mu.Lock()
	first.acceptorFor(keyP1).rec.Promised = Ballot{Round: 9, Incarnation: 1, Proposer: "d1"}
	first.markDirty(keyP1)
	first.commitLocked(clock.now)
	first.mu.Unlock()
	clock.now = 10 * time.Second // a new boot: the monotonic clock restarted
	second, err := NewNode(Config{ID: "r1", Clock: clock, Store: store, Signer: fakeSigner{id: "r1"}, Verifier: fakeVerifier{}})
	if err != nil {
		t.Fatal(err)
	}
	if second.Incarnation() != first.Incarnation()+1 {
		t.Fatalf("incarnation %d after %d", second.Incarnation(), first.Incarnation())
	}
	if got := second.acceptors[keyP1].rec.Promised; got.Round != 9 {
		t.Fatalf("promised ballot lost: %s", got)
	}
	floor, err := NewNode(Config{ID: "r1", Clock: clock, Store: NewMemoryStore(), Signer: fakeSigner{id: "r1"}, IncarnationFloor: 5000})
	if err != nil || floor.Incarnation() != 5000 {
		t.Fatalf("incarnation floor ignored: %v %d", err, floor.Incarnation())
	}
	if second.startedAt != clock.now || AbstainAfterStart != LeaseTerm*11/10 {
		t.Fatal("abstention must start at process start and last T x 1.1")
	}
}
