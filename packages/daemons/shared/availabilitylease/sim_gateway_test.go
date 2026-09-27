package availabilitylease

import (
	"crypto/ed25519"
	"fmt"
	"math/rand"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// simGateway builds and signs voter configs and manifests with the policy
// key, delivers them over "CommandStream" (direct calls, possibly partial),
// rotates keys and drives planned handoffs. It may die at any time.
type simGateway struct {
	w     *simWorld
	alive bool

	keys       []simPolicyKey
	signIdx    int
	links      []*pb.LeasePolicyKeyRotation
	epoch      uint64
	sets       [][]string
	config     *pb.LeaseSignedBlock
	policies   map[string]*simPolicy
	deliverP   float64
	jointSince time.Duration
	joint      bool
	jointAcked time.Duration
}

type simPolicyKey struct {
	id   string
	priv ed25519.PrivateKey
	pub  ed25519.PublicKey
}

type simPolicy struct {
	id          string
	version     uint64
	available   bool
	slots       uint32
	candidates  []string
	closed      bool
	bootstrapID uint64
	bootstrap   map[uint32]string
	block       *pb.LeaseSignedBlock
}

func newSimGateway(w *simWorld) *simGateway {
	g := &simGateway{w: w, alive: true, policies: map[string]*simPolicy{}, deliverP: 1}
	g.keys = append(g.keys, g.newKey(1))
	return g
}

func (g *simGateway) newKey(n int) simPolicyKey {
	seed := make([]byte, ed25519.SeedSize)
	rand.New(rand.NewSource(g.w.seed*31 + int64(n))).Read(seed)
	priv := ed25519.NewKeyFromSeed(seed)
	return simPolicyKey{id: fmt.Sprintf("policy-key-%d", n), priv: priv, pub: priv.Public().(ed25519.PublicKey)}
}

// key is the signing key: a rotated key is used only after a majority of
// voters acked it (A14).
func (g *simGateway) key() simPolicyKey { return g.keys[g.signIdx] }

func (g *simGateway) publicKey(id string) []byte {
	if n := g.w.nodes[id]; n != nil && g.w.wire {
		return n.wirePublicKey()
	}
	return []byte("pk:" + id)
}

func (g *simGateway) buildConfig(sets [][]string) *pb.LeaseSignedBlock {
	g.epoch++
	g.sets = sets
	members := map[string]bool{}
	for _, id := range g.w.relays {
		members[id] = true
	}
	for _, set := range sets {
		for _, id := range set {
			members[id] = true
		}
	}
	value := &pb.LeaseVoterConfig{SchemaVersion: 1, Epoch: g.epoch}
	for _, id := range sortedKeys(members) {
		role := pb.LeaseMemberRole_LEASE_MEMBER_ROLE_DAEMON
		if g.w.nodes[id].relay {
			role = pb.LeaseMemberRole_LEASE_MEMBER_ROLE_RELAY
		}
		value.Members = append(value.Members, &pb.LeaseMember{Id: id, PublicKey: g.publicKey(id), Role: role})
	}
	for _, set := range sets {
		value.QuorumSets = append(value.QuorumSets, &pb.LeaseQuorumSet{VoterIds: set})
	}
	payload, _ := proto.Marshal(value)
	key := g.key()
	g.config = SignPolicyBlock(key.id, key.priv, pb.LeaseBlockKind_LEASE_BLOCK_KIND_VOTER_CONFIG, payload)
	return g.config
}

func (g *simGateway) buildManifest(p *simPolicy) *pb.LeaseSignedBlock {
	p.version++
	value := &pb.LeaseManifest{
		SchemaVersion: 1, PolicyId: p.id, ManifestVersion: p.version, Slots: p.slots, Epoch: g.epoch,
		Mode: pb.LeasePolicyMode_LEASE_POLICY_MODE_FAILOVER, PartitionMode: pb.LeasePartitionMode_LEASE_PARTITION_MODE_STRICT,
		Closed: p.closed, BootstrapId: p.bootstrapID, LeaseTermMs: 30000,
	}
	if p.slots > 1 {
		value.Mode = pb.LeasePolicyMode_LEASE_POLICY_MODE_REPLICATED
	}
	if p.available {
		value.PartitionMode = pb.LeasePartitionMode_LEASE_PARTITION_MODE_AVAILABLE
	}
	for _, id := range p.candidates {
		value.Candidates = append(value.Candidates, &pb.LeaseCandidate{Id: id, PublicKey: g.publicKey(id)})
	}
	for slot := uint32(0); slot < p.slots; slot++ {
		if holder := p.bootstrap[slot]; holder != "" {
			value.Bootstrap = append(value.Bootstrap, &pb.LeaseBootstrapSlot{Slot: slot, HolderId: holder})
		}
	}
	payload, _ := proto.Marshal(value)
	key := g.key()
	p.block = SignPolicyBlock(key.id, key.priv, pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, payload)
	return p.block
}

// deliver pushes a block to up nodes; each delivery succeeds with deliverP.
func (g *simGateway) deliver(block *pb.LeaseSignedBlock, p float64) {
	if !g.alive {
		return
	}
	for _, id := range g.w.ids {
		n := g.w.nodes[id]
		if !n.processUp() || n.frozen || g.w.rng.Float64() >= p {
			continue
		}
		g.adopt(n, block)
		n.after()
	}
}

func (g *simGateway) adopt(n *simNode, block *pb.LeaseSignedBlock) {
	g.sendChain(n)
	var err error
	if block.GetKind() == pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST {
		_, err = n.node.AdoptManifest(block)
	} else {
		_, err = n.node.AdoptVoterConfig(block)
	}
	if err != nil {
		g.w.fail("gateway delivery to %s: %v", n.id, err)
	}
}

// onNodeStart models enrollment trust plus, while the Gateway is up, the
// CommandStream / policy snapshot redelivery on reconnect.
func (g *simGateway) onNodeStart(n *simNode) {
	first := g.keys[0]
	if err := n.node.TrustPolicyKey(first.id, first.pub); err != nil {
		g.w.fail("trust: %v", err)
	}
	for _, id := range sortedKeys(g.policies) {
		n.node.SetCandidateReady(id, n.ready)
	}
	if !g.alive || g.w.rng.Float64() >= g.deliverP {
		return
	}
	g.sendChain(n)
	if g.config != nil {
		g.adopt(n, g.config)
	}
	for _, id := range sortedKeys(g.policies) {
		if block := g.policies[id].block; block != nil {
			g.adopt(n, block)
		}
	}
}

// sendChain delivers every rotation link in order over the authenticated
// channel.
func (g *simGateway) sendChain(n *simNode) {
	// CommandStream is authenticated: the Gateway hands over its signing key
	// directly (A4); links let the node forward the chain to lagging peers.
	if err := n.node.TrustPolicyKey(g.key().id, g.key().pub); err != nil {
		g.w.fail("trust %s: %v", n.id, err)
	}
	for _, link := range g.links {
		_ = n.node.AdoptKeyRotation(link)
	}
}

// resign re-signs the current config and manifests with the signing key
// after a rotation was acked, so peers that only trust the new key can
// verify blocks forwarded to them.
func (g *simGateway) resign() {
	key := g.key()
	if g.config != nil {
		g.config = SignPolicyBlock(key.id, key.priv, g.config.GetKind(), g.config.GetPayload())
		g.deliver(g.config, 1)
	}
	for _, id := range sortedKeys(g.policies) {
		if p := g.policies[id]; p.block != nil {
			p.block = SignPolicyBlock(key.id, key.priv, p.block.GetKind(), p.block.GetPayload())
			g.deliver(p.block, 1)
		}
	}
}

// rotateKey introduces a new policy key via a signed link. The Gateway only
// signs with it after a majority of voters trust it (A14); acked reports that.
func (g *simGateway) rotateKey(deliverP float64) {
	if !g.alive {
		return
	}
	previous := g.keys[len(g.keys)-1]
	next := g.newKey(len(g.keys) + 1)
	link := SignPolicyKeyRotation(previous.id, previous.priv, next.id, next.pub)
	g.links = append(g.links, link)
	g.keys = append(g.keys, next)
	for _, id := range g.w.ids {
		n := g.w.nodes[id]
		if n.processUp() && !n.frozen && g.w.rng.Float64() < deliverP {
			g.sendChain(n)
		}
	}
	g.w.tracef("gateway rotates policy key to %s", next.id)
	index := len(g.keys) - 1
	var poll func()
	poll = func() {
		if !g.alive || g.signIdx >= index {
			return
		}
		if g.keyAckedByMajority(next.id) {
			g.signIdx = index
			g.w.tracef("gateway signs with %s", next.id)
			g.resign()
			return
		}
		g.w.after(time.Second, poll)
	}
	g.w.after(time.Second, poll)
}

func (g *simGateway) keyAckedByMajority(keyID string) bool {
	acked := map[string]bool{}
	for _, id := range g.w.ids {
		if n := g.w.nodes[id]; n.processUp() && n.node.TrustsPolicyKey(keyID) {
			acked[id] = true
		}
	}
	for _, set := range g.sets {
		count := 0
		for _, id := range set {
			if acked[id] {
				count++
			}
		}
		if count*2 <= len(set) {
			return false
		}
	}
	return true
}

// adoptedBy reports whether a majority of set persisted epoch or later.
func (g *simGateway) adoptedBy(set []string, epoch uint64) bool {
	count := 0
	for _, id := range set {
		if n := g.w.nodes[id]; n.processUp() && n.node.Epoch() >= epoch {
			count++
		}
	}
	return count*2 > len(set)
}

// changeVoters starts a joint-consensus epoch (old, new) and settles it once
// a majority of both persisted it and T x 1.1 at the slowest clock passed.
func (g *simGateway) changeVoters(next []string, deliverP float64) {
	if !g.alive || g.joint {
		return
	}
	old := g.sets[0]
	jointEpoch := g.epoch + 1
	g.deliver(g.buildConfig([][]string{old, next}), deliverP)
	g.joint, g.jointAcked = true, 0
	g.w.tracef("gateway joint epoch %d old=%v new=%v", jointEpoch, old, next)
	var poll func()
	poll = func() {
		if !g.alive {
			return
		}
		if g.jointAcked == 0 {
			if g.adoptedBy(old, jointEpoch) && g.adoptedBy(next, jointEpoch) {
				g.jointAcked = g.w.now
			} else {
				g.deliver(g.config, 1)
			}
		}
		if g.jointAcked != 0 && g.w.now >= g.jointAcked+AcceptorHold*10/9+2*time.Second {
			g.deliver(g.buildConfig([][]string{next}), deliverP)
			g.joint = false
			g.w.tracef("gateway settles epoch %d voters=%v", g.epoch, next)
			return
		}
		g.w.after(time.Second, poll)
	}
	g.w.after(time.Second, poll)
}

func (g *simGateway) republish(policyID string, deliverP float64) {
	if !g.alive {
		return
	}
	g.deliver(g.buildManifest(g.policies[policyID]), deliverP)
}
