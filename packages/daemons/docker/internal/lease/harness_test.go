package lease

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	"github.com/wiolett-industries/gateway/daemon-shared/leasefence"
	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

const (
	testPolicy = "p1"
	worldTick  = 50 * time.Millisecond
)

type fakeClock struct{ now time.Duration }

func (c *fakeClock) Now() time.Duration { return c.now }

type relayHost struct {
	id   string
	key  *ecdsa.PrivateKey
	node *availabilitylease.Node
	down bool
}

type daemonHost struct {
	id        string
	key       *ecdsa.PrivateKey
	store     availabilitylease.Store
	engine    *fakeEngine
	fence     *fakeFence
	endpoints *fakeEndpoints
	runtime   *Runtime
	ops       []func()
	down      bool // the whole host is dead
	cut       bool // the host is partitioned from everyone
	// daemonOff: the docker daemon process is gone (or a pre-lease
	// version); the host, Docker and the watchdog keep running.
	daemonOff bool
}

// world is a lossless, deterministic cluster: relays and daemons run real
// availabilitylease nodes; Docker, the watchdog and endpoints are fakes.
type world struct {
	t          *testing.T
	clock      *fakeClock
	wallJump   time.Duration
	policyID   string
	policyPriv ed25519.PrivateKey
	relays     []*relayHost
	daemons    []*daemonHost
	byID       map[string]any
	queue      []*pb.CoordinationFrame
	seq        int
	log        []string
	violations []string
	config     *pb.LeaseSignedBlock
	manifest   *pb.LeaseSignedBlock
	manifestV  uint64
	candidates []string
	voters     []string
	bootstrap  string
	closed     bool
	available  bool
	watchdogOn bool
	logger     *slog.Logger
}

type worldSpec struct {
	relays     []string
	daemons    []string
	candidates []string
	// voters defaults to the relays.
	voters    []string
	bootstrap string
	available bool
}

func newWorld(t *testing.T, spec worldSpec) *world {
	t.Helper()
	_, priv, _ := ed25519.GenerateKey(rand.Reader)
	w := &world{
		t: t, clock: &fakeClock{now: time.Hour}, policyID: testPolicy, policyPriv: priv, byID: map[string]any{},
		candidates: spec.candidates, voters: spec.voters, bootstrap: spec.bootstrap, available: spec.available, watchdogOn: true,
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	if len(w.voters) == 0 {
		w.voters = spec.relays
	}
	for _, id := range spec.relays {
		key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		w.relays = append(w.relays, &relayHost{id: id, key: key})
	}
	for _, id := range spec.daemons {
		key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		h := &daemonHost{id: id, key: key, store: availabilitylease.NewMemoryStore()}
		h.engine = &fakeEngine{w: w, host: h, containers: map[string]*Container{}}
		h.fence = &fakeFence{w: w, records: map[string]leasefence.Record{}, heartbeat: true}
		h.endpoints = &fakeEndpoints{w: w, host: id, serving: map[string]bool{}}
		w.daemons = append(w.daemons, h)
	}
	w.buildBlocks()
	for _, relay := range w.relays {
		node, err := availabilitylease.NewNode(availabilitylease.Config{
			ID: relay.id, Clock: w.clock, Store: availabilitylease.NewMemoryStore(), Transport: w,
			Signer: availabilitylease.ECDSASigner{Key: relay.key}, IncarnationFloor: 1,
		})
		if err != nil {
			t.Fatal(err)
		}
		relay.node = node
		w.byID[relay.id] = relay
		if err := node.TrustPolicyKey("k1", priv.Public().(ed25519.PublicKey)); err != nil {
			t.Fatal(err)
		}
		if _, err := node.AdoptVoterConfig(w.config); err != nil {
			t.Fatal(err)
		}
		if _, err := node.AdoptManifest(w.manifest); err != nil {
			t.Fatal(err)
		}
	}
	for _, h := range w.daemons {
		w.byID[h.id] = h
		w.startDaemon(h)
		w.deliverBlocks(h)
	}
	return w
}

func publicKeyDER(key *ecdsa.PrivateKey) []byte {
	der, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	return der
}

func (w *world) keyOf(id string) *ecdsa.PrivateKey {
	switch host := w.byID[id].(type) {
	case *relayHost:
		return host.key
	case *daemonHost:
		return host.key
	}
	for _, relay := range w.relays {
		if relay.id == id {
			return relay.key
		}
	}
	for _, h := range w.daemons {
		if h.id == id {
			return h.key
		}
	}
	w.t.Fatalf("unknown id %s", id)
	return nil
}

func (w *world) buildBlocks() {
	config := &pb.LeaseVoterConfig{SchemaVersion: 1, Epoch: 1}
	members := map[string]bool{}
	for _, relay := range w.relays {
		members[relay.id] = true
		config.Members = append(config.Members, &pb.LeaseMember{Id: relay.id, PublicKey: publicKeyDER(relay.key), Role: pb.LeaseMemberRole_LEASE_MEMBER_ROLE_RELAY})
	}
	for _, id := range w.voters {
		if !members[id] {
			config.Members = append(config.Members, &pb.LeaseMember{Id: id, PublicKey: publicKeyDER(w.keyOf(id)), Role: pb.LeaseMemberRole_LEASE_MEMBER_ROLE_DAEMON})
		}
	}
	config.QuorumSets = []*pb.LeaseQuorumSet{{VoterIds: append([]string(nil), w.voters...)}}
	payload, _ := proto.Marshal(config)
	w.config = availabilitylease.SignPolicyBlock("k1", w.policyPriv, pb.LeaseBlockKind_LEASE_BLOCK_KIND_VOTER_CONFIG, payload)
	w.buildManifest()
}

func (w *world) buildManifest() {
	w.manifestV++
	manifest := &pb.LeaseManifest{
		SchemaVersion: 1, PolicyId: w.policyID, ManifestVersion: w.manifestV, Slots: 1, Epoch: 1, Closed: w.closed,
		Mode: pb.LeasePolicyMode_LEASE_POLICY_MODE_FAILOVER, PartitionMode: pb.LeasePartitionMode_LEASE_PARTITION_MODE_STRICT,
		LeaseTermMs: 30000,
	}
	for _, id := range w.candidates {
		manifest.Candidates = append(manifest.Candidates, &pb.LeaseCandidate{Id: id, PublicKey: publicKeyDER(w.keyOf(id))})
	}
	if w.available {
		manifest.PartitionMode = pb.LeasePartitionMode_LEASE_PARTITION_MODE_AVAILABLE
	}
	if w.bootstrap != "" {
		manifest.BootstrapId = 1
		manifest.Bootstrap = []*pb.LeaseBootstrapSlot{{Slot: 0, HolderId: w.bootstrap}}
	}
	payload, _ := proto.Marshal(manifest)
	w.manifest = availabilitylease.SignPolicyBlock("k1", w.policyPriv, pb.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST, payload)
}

// closeLease publishes a lease-closed manifest (A5) to every host.
func (w *world) closeLease() {
	w.closed = true
	w.buildManifest()
	for _, relay := range w.relays {
		_, _ = relay.node.AdoptManifest(w.manifest)
	}
	for _, h := range w.daemons {
		w.deliverBlocks(h)
	}
}

func (w *world) deliverBlocks(h *daemonHost) {
	err := h.runtime.ApplyLeaseBlocks(BlockUpdate{
		Revision: w.manifestV, MemberID: h.id, PolicyKeys: []PolicyKey{{ID: "k1", PublicKey: w.policyPriv.Public().(ed25519.PublicKey)}},
		VoterConfig: w.config, Manifests: []*pb.LeaseSignedBlock{w.manifest},
	})
	if err != nil {
		w.t.Fatalf("apply blocks on %s: %v", h.id, err)
	}
}

// startDaemon (re)starts a daemon process on the same host: same store,
// same Docker, same watchdog directory, fresh runtime.
func (w *world) startDaemon(h *daemonHost) {
	runtime, err := New(Options{
		NodeID: h.id, Clock: w.clock, Wall: w.wall, Signer: availabilitylease.ECDSASigner{Key: h.key},
		Engine: h.engine, Fence: h.fence, Endpoints: h.endpoints, Placements: fakePlacements{host: h.id},
		Logger: w.logger, Store: h.store, Transport: w,
		Async: func(fn func()) { h.ops = append(h.ops, fn) },
	})
	if err != nil {
		w.t.Fatal(err)
	}
	h.runtime, h.ops, h.down = runtime, nil, false
}

func (w *world) wall() time.Time {
	return time.Unix(1_800_000_000, 0).Add(w.clock.now + w.wallJump)
}

// Send is the network: frames are queued and delivered after each tick.
func (w *world) Send(frame *pb.CoordinationFrame) { w.queue = append(w.queue, frame) }

func (w *world) reachable(id string) bool {
	switch host := w.byID[id].(type) {
	case *relayHost:
		return !host.down
	case *daemonHost:
		return !host.down && !host.cut && !host.daemonOff
	}
	return false
}

func (w *world) deliver() {
	for guard := 0; len(w.queue) > 0 && guard < 100000; guard++ {
		frame := w.queue[0]
		w.queue = w.queue[1:]
		if !w.reachable(frame.GetSenderId()) || !w.reachable(frame.GetDestinationId()) {
			continue
		}
		switch host := w.byID[frame.GetDestinationId()].(type) {
		case *relayHost:
			_ = host.node.ReceiveFrame(frame)
		case *daemonHost:
			_ = host.runtime.Node().ReceiveFrame(frame)
		}
	}
}

func (w *world) logf(format string, args ...any) {
	w.seq++
	w.log = append(w.log, fmt.Sprintf("%06d %8.3fs ", w.seq, (w.clock.now-time.Hour).Seconds())+fmt.Sprintf(format, args...))
}

// run advances simulated time, stepping every live host each tick.
func (w *world) run(d time.Duration) {
	w.t.Helper()
	for end := w.clock.now + d; w.clock.now < end; {
		w.clock.now += worldTick
		for _, relay := range w.relays {
			if !relay.down {
				relay.node.Tick()
			}
		}
		for _, h := range w.daemons {
			if h.down || h.daemonOff {
				continue
			}
			h.runtime.Step()
			for guard := 0; len(h.ops) > 0 && guard < 16; guard++ {
				ops := h.ops
				h.ops = nil
				for _, op := range ops {
					op()
				}
			}
		}
		w.deliver()
		w.runWatchdogs()
		w.checkSingleCopy()
	}
}

// runWatchdogs emulates the independent watchdog: it kills a running
// container whose record is stale, with dockerd or without it.
func (w *world) runWatchdogs() {
	if !w.watchdogOn {
		return
	}
	for _, h := range w.daemons {
		for id, record := range h.fence.records {
			if c := h.engine.containers[id]; c != nil && c.Running && record.Stale(w.clock.now) && !h.down {
				c.Running = false
				w.logf("%s watchdog killed %s", h.id, shortID(id))
			}
		}
	}
}

func (w *world) checkSingleCopy() {
	if w.available {
		return
	}
	var running []string
	for _, h := range w.daemons {
		if h.down {
			continue
		}
		for _, c := range h.engine.containers {
			if c.Running && c.PolicyID == w.policyID {
				running = append(running, h.id)
			}
		}
	}
	if len(running) > 1 {
		w.violations = append(w.violations, fmt.Sprintf("t=%.3fs two copies running on %v", (w.clock.now-time.Hour).Seconds(), running))
	}
}

func (w *world) requireClean() {
	w.t.Helper()
	if len(w.violations) > 0 {
		w.t.Fatalf("invariant violated: %s\n%s", w.violations[0], w.dump())
	}
}

func (w *world) dump() string {
	start := 0
	if len(w.log) > 80 {
		start = len(w.log) - 80
	}
	return strings.Join(w.log[start:], "\n")
}

func (w *world) daemon(id string) *daemonHost {
	for _, h := range w.daemons {
		if h.id == id {
			return h
		}
	}
	w.t.Fatalf("unknown daemon %s", id)
	return nil
}

// runUntil advances until cond holds or the timeout passes.
func (w *world) runUntil(timeout time.Duration, cond func() bool) bool {
	for end := w.clock.now + timeout; w.clock.now < end; {
		if cond() {
			return true
		}
		w.run(worldTick)
	}
	return cond()
}

func (w *world) holderOf() string {
	for _, h := range w.daemons {
		if h.down {
			continue
		}
		status := h.runtime.Node().HolderStatus(availabilitylease.Key{PolicyID: w.policyID})
		if status.Role == availabilitylease.RoleHolding && status.MayStart {
			return h.id
		}
	}
	return ""
}

func (w *world) waitServing(id string, timeout time.Duration) {
	w.t.Helper()
	h := w.daemon(id)
	if !w.runUntil(timeout, func() bool { return h.engine.running() && h.endpoints.serving[w.policyID] }) {
		w.t.Fatalf("%s did not serve within %s (holder %q)\n%s", id, timeout, w.holderOf(), w.dump())
	}
}

func (w *world) indexOf(pattern string) int {
	for i, line := range w.log {
		if strings.Contains(line, pattern) {
			return i
		}
	}
	return -1
}

func (w *world) lastIndexOf(pattern string) int {
	for i := len(w.log) - 1; i >= 0; i-- {
		if strings.Contains(w.log[i], pattern) {
			return i
		}
	}
	return -1
}
