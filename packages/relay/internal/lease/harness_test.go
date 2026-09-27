package lease

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"io"
	"log/slog"
	"sort"
	"sync"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/policy"
	"google.golang.org/protobuf/proto"
)

const (
	relayID   = "relay-1"
	policyID  = "policy-1"
	policyKey = "policy-key-1"
)

var testKey = availabilitylease.Key{PolicyID: policyID}

type fakeClock struct {
	mu  sync.Mutex
	now time.Duration
}

func (c *fakeClock) Now() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	c.now += d
	c.mu.Unlock()
}

// harness wires one relay Coordinator with T1 daemon nodes over the relay's
// routing (daemon -> relay -> daemon), deterministically on a fake clock.
type harness struct {
	t         *testing.T
	clock     *fakeClock
	wallBase  time.Time
	wallSkew  time.Duration
	policyPub ed25519.PublicKey
	policyKey ed25519.PrivateKey
	keys      map[string]*ecdsa.PrivateKey
	dir       string
	store     *policy.Store
	relay     *Coordinator
	daemons   map[string]*availabilitylease.Node
	streams   map[string]*memberStream
	down      map[string]bool
	voters    []string
	relayVote bool
	fresh     bool
	manifest  *relayv1.LeaseSignedBlock
	config    *relayv1.LeaseSignedBlock
	version   uint64

	mu  sync.Mutex
	out []*relayv1.CoordinationFrame
	// relayFrames records every frame the relay itself sent, by destination.
	relayFrames map[string][]*relayv1.CoordinationFrame
}

type harnessTransport struct {
	h  *harness
	id string
}

func (t harnessTransport) Send(frame *relayv1.CoordinationFrame) {
	t.h.mu.Lock()
	defer t.h.mu.Unlock()
	t.h.out = append(t.h.out, frame)
}

// newHarness starts a relay and daemons v1, v2 (acceptors) and d1, d2
// (candidates of policy-1). relayVotes puts the relay in the quorum set with
// v1 and v2; otherwise the quorum set is v1, v2, v3 and the relay only
// shadow-accepts (the local relay when the voter count is even).
func newHarness(t *testing.T, relayVotes bool) *harness {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	h := &harness{
		t: t, clock: &fakeClock{}, wallBase: time.Unix(1_800_000_000, 0), policyPub: pub, policyKey: priv,
		keys: map[string]*ecdsa.PrivateKey{}, dir: t.TempDir(), daemons: map[string]*availabilitylease.Node{},
		streams: map[string]*memberStream{}, down: map[string]bool{}, relayVote: relayVotes,
		relayFrames: map[string][]*relayv1.CoordinationFrame{},
	}
	h.voters = []string{relayID, "v1", "v2"}
	daemons := []string{"v1", "v2", "d1", "d2"}
	if !relayVotes {
		h.voters = []string{"v1", "v2", "v3"}
		daemons = append(daemons, "v3")
	}
	for _, id := range append([]string{relayID}, daemons...) {
		key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		if err != nil {
			t.Fatal(err)
		}
		h.keys[id] = key
	}
	h.config = h.signConfig(1, h.voters)
	h.manifest = h.signManifest([]string{"d1", "d2"}, false)
	h.openRelay()
	for _, id := range daemons {
		node, err := availabilitylease.NewNode(availabilitylease.Config{
			ID: id, Clock: h.clock, Store: availabilitylease.NewMemoryStore(), Transport: harnessTransport{h: h, id: id},
			Signer: availabilitylease.ECDSASigner{Key: h.keys[id]},
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := node.TrustPolicyKey(policyKey, pub); err != nil {
			t.Fatal(err)
		}
		if _, err := node.AdoptVoterConfig(h.config); err != nil {
			t.Fatal(err)
		}
		if _, err := node.AdoptManifest(h.manifest); err != nil {
			t.Fatal(err)
		}
		h.daemons[id] = node
		h.connect(id)
	}
	return h
}

func (h *harness) wall() time.Time { return h.wallBase.Add(h.clock.Now() + h.wallSkew) }

// openRelay (re)starts the relay coordinator on relay.db in h.dir.
func (h *harness) openRelay() {
	h.t.Helper()
	store, err := policy.Open(h.dir)
	if err != nil {
		h.t.Fatal(err)
	}
	state, fresh, err := store.LeaseState()
	if err != nil {
		h.t.Fatal(err)
	}
	coordinator, err := New(Config{
		ID: relayID, Store: state, Signer: recordingSigner{h: h}, PublicKey: func() []byte { return h.publicKey(relayID) },
		TrustedKeys: func() []policy.TrustedPolicyKey {
			return []policy.TrustedPolicyKey{{KeyID: policyKey, PublicKey: h.policyPub}}
		},
		Clock: h.clock, Wall: h.wall, Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		h.t.Fatal(err)
	}
	h.store, h.relay, h.fresh = store, coordinator, fresh
	h.relay.ApplyPolicy(&policy.Snapshot{LeaseBlocks: []*relayv1.LeaseSignedBlock{h.config, h.manifest}})
	h.streams = map[string]*memberStream{}
	for id := range h.daemons {
		h.connect(id)
	}
	h.t.Cleanup(func() { _ = store.Close() })
}

// restartRelay closes relay.db and opens it again; wipe renames it first,
// like the documented relay.db recovery.
func (h *harness) restartRelay(wipe bool) {
	h.t.Helper()
	if err := h.store.Close(); err != nil {
		h.t.Fatal(err)
	}
	if wipe {
		h.dir = h.t.TempDir()
	}
	h.openRelay()
}

type recordingSigner struct{ h *harness }

func (s recordingSigner) Sign(message []byte) ([]byte, error) {
	return availabilitylease.ECDSASigner{Key: s.h.keys[relayID]}.Sign(message)
}

func (h *harness) connect(id string) {
	stream := &memberStream{id: id, out: make(chan *relayv1.CoordinationFrame, streamBuffer), revoked: make(chan struct{})}
	h.relay.register(stream)
	h.streams[id] = stream
}

func (h *harness) publicKey(id string) []byte {
	encoded, err := x509.MarshalPKIXPublicKey(&h.keys[id].PublicKey)
	if err != nil {
		h.t.Fatal(err)
	}
	return encoded
}

func (h *harness) signConfig(epoch uint64, voters []string) *relayv1.LeaseSignedBlock {
	members := map[string]bool{relayID: true}
	for _, id := range voters {
		members[id] = true
	}
	ids := make([]string, 0, len(members))
	for id := range members {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	value := &relayv1.LeaseVoterConfig{SchemaVersion: 1, Epoch: epoch, QuorumSets: []*relayv1.LeaseQuorumSet{{VoterIds: voters}}}
	for _, id := range ids {
		role := relayv1.LeaseMemberRole_LEASE_MEMBER_ROLE_DAEMON
		if id == relayID {
			role = relayv1.LeaseMemberRole_LEASE_MEMBER_ROLE_RELAY
		}
		value.Members = append(value.Members, &relayv1.LeaseMember{Id: id, PublicKey: h.publicKey(id), Role: role})
	}
	payload, _ := proto.Marshal(value)
	return availabilitylease.SignPolicyBlock(policyKey, h.policyKey, relayv1.LeaseBlockKind_LEASE_BLOCK_KIND_VOTER_CONFIG, payload)
}

func (h *harness) signManifest(candidates []string, closed bool) *relayv1.LeaseSignedBlock {
	h.version++
	value := &relayv1.LeaseManifest{
		SchemaVersion: 1, PolicyId: policyID, ManifestVersion: h.version, Slots: 1, Epoch: 1, Closed: closed,
		Mode: relayv1.LeasePolicyMode_LEASE_POLICY_MODE_FAILOVER, PartitionMode: relayv1.LeasePartitionMode_LEASE_PARTITION_MODE_STRICT,
		LeaseTermMs: 30000,
	}
	for _, id := range candidates {
		if h.keys[id] == nil {
			key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
			h.keys[id] = key
		}
		value.Candidates = append(value.Candidates, &relayv1.LeaseCandidate{Id: id, PublicKey: h.publicKey(id)})
	}
	payload, _ := proto.Marshal(value)
	return availabilitylease.SignPolicyBlock(policyKey, h.policyKey, relayv1.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, payload)
}

func (h *harness) ready(ids ...string) {
	for _, id := range ids {
		h.daemons[id].SetCandidateReady(policyID, true)
	}
}

// pump delivers queued frames until the network is quiet: daemon frames go
// through the relay's ingest and routing, relay stream frames to daemons.
func (h *harness) pump() {
	for round := 0; round < 1000; round++ {
		h.mu.Lock()
		out := h.out
		h.out = nil
		h.mu.Unlock()
		progressed := len(out) > 0
		for _, frame := range out {
			if h.down[frame.GetSenderId()] {
				continue
			}
			h.relay.ingestFrame(frame)
			if !h.relay.view.authorized(frame.GetSenderId()) {
				h.t.Fatalf("daemon %s is not authorized by the relay view", frame.GetSenderId())
			}
			h.relay.deliver(frame)
		}
		for _, id := range sortedIDs(h.streams) {
			stream := h.streams[id]
			for drained := false; !drained; {
				select {
				case frame := <-stream.out:
					progressed = true
					if frame.GetSenderId() == relayID {
						h.relayFrames[id] = append(h.relayFrames[id], frame)
					}
					if !h.down[id] {
						_ = h.daemons[id].ReceiveFrame(frame)
					}
				default:
					drained = true
				}
			}
		}
		if !progressed {
			return
		}
	}
	h.t.Fatal("network did not settle")
}

// step advances time in 100 ms increments, ticking every live node.
func (h *harness) step(total time.Duration) {
	for elapsed := time.Duration(0); elapsed < total; elapsed += 100 * time.Millisecond {
		h.clock.advance(100 * time.Millisecond)
		for _, id := range sortedIDs(h.daemons) {
			if !h.down[id] {
				h.daemons[id].Tick()
			}
		}
		h.relay.node.Tick()
		h.pump()
	}
}

// stepUntil steps until cond holds or the timeout passes.
func (h *harness) stepUntil(timeout time.Duration, cond func() bool) bool {
	for elapsed := time.Duration(0); elapsed < timeout; elapsed += 100 * time.Millisecond {
		if cond() {
			return true
		}
		h.step(100 * time.Millisecond)
	}
	return cond()
}

func (h *harness) holding(id string) bool { return h.daemons[id].HolderStatus(testKey).Holding }

func sortedIDs[V any](values map[string]V) []string {
	ids := make([]string, 0, len(values))
	for id := range values {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}
