package availabilitylease

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// Transport hands sealed frames to the relay streams. It must not call back
// into the Node synchronously.
type Transport interface {
	Send(frame *pb.CoordinationFrame)
}

type Config struct {
	// ID is this node's identity: the voter/candidate id in manifests.
	ID        string
	Clock     Clock
	Store     Store
	Transport Transport
	Signer    Signer
	// Verifier defaults to ECDSA P-256.
	Verifier Verifier
	// Logf receives diagnostic messages; optional.
	Logf func(format string, args ...any)
	// IncarnationFloor keeps incarnations increasing when the store was lost
	// (relay.db renamed, state directory wiped): pass the wall clock in
	// milliseconds. Peers drop frames from an incarnation lower than one they
	// saw (A9), and ballots must stay unique (A3).
	IncarnationFloor uint64
}

// Node runs the acceptor and proposer roles of one process. Every method is
// safe for concurrent use; outgoing frames are sent after the lock is released.
type Node struct {
	mu        sync.Mutex
	id        string
	clock     Clock
	store     Store
	transport Transport
	signer    Signer
	verifier  Verifier
	logf      func(format string, args ...any)

	incarnation uint64
	startedAt   time.Duration
	chain       *keyChain
	// history keeps each policy's recent voter configs, oldest first, to
	// verify commits formed under an earlier voter epoch.
	history   map[string][]*VoterConfig
	manifests map[string]*Manifest

	acceptors map[Key]*acceptorKey
	proposers map[Key]*proposerKey
	ready     map[string]bool
	renewAt   time.Duration

	outbox     map[string][]*pb.LeaseItem
	attach     map[string]map[string]bool
	loopback   []*pb.LeaseItem
	dirty      map[Key]bool
	dirtyOther map[string][]byte
	deletes    []string
	seen       map[string]struct{}
	seenOrder  []string
	peers      map[string]uint64
	forwarded  map[string]forwardMark
	messageSeq uint64
	echoSeq    uint64
	events     []Event

	// rawSend bypasses sealing; the simulator uses it for speed.
	rawSend func(to string, batch *pb.LeaseBatch)
}

type outgoing struct {
	to    string
	batch *pb.LeaseBatch
}

const dedupCapacity = 8192

// NewNode loads persisted state, bumps and persists the incarnation (A3) and
// starts the acceptor abstention window.
func NewNode(cfg Config) (*Node, error) {
	if cfg.ID == "" || cfg.Clock == nil || cfg.Store == nil || cfg.Signer == nil {
		return nil, errors.New("availability lease node needs id, clock, store and signer")
	}
	n := &Node{
		id: cfg.ID, clock: cfg.Clock, store: cfg.Store, transport: cfg.Transport, signer: cfg.Signer,
		verifier: cfg.Verifier, logf: cfg.Logf, chain: newKeyChain(), manifests: map[string]*Manifest{},
		history: map[string][]*VoterConfig{}, acceptors: map[Key]*acceptorKey{}, proposers: map[Key]*proposerKey{}, ready: map[string]bool{},
		outbox: map[string][]*pb.LeaseItem{}, attach: map[string]map[string]bool{}, dirty: map[Key]bool{},
		dirtyOther: map[string][]byte{}, seen: map[string]struct{}{}, peers: map[string]uint64{},
		forwarded: map[string]forwardMark{},
	}
	if n.verifier == nil {
		n.verifier = &ECDSAVerifier{}
	}
	if n.logf == nil {
		n.logf = func(string, ...any) {}
	}
	records, err := cfg.Store.Load()
	if err != nil {
		return nil, fmt.Errorf("load availability lease state: %w", err)
	}
	if err := n.restore(records); err != nil {
		return nil, err
	}
	n.incarnation++
	if cfg.IncarnationFloor > n.incarnation {
		n.incarnation = cfg.IncarnationFloor
	}
	if err := cfg.Store.Apply(map[string][]byte{recordIncarnation: encodeUint64(n.incarnation)}, nil); err != nil {
		return nil, fmt.Errorf("persist availability lease incarnation: %w", err)
	}
	n.startedAt = cfg.Clock.Now()
	n.renewAt = n.startedAt
	return n, nil
}

func (n *Node) restore(records map[string][]byte) error {
	if data, ok := records[recordIncarnation]; ok {
		value, err := decodeUint64(data)
		if err != nil {
			return err
		}
		n.incarnation = value
	}
	if data, ok := records[recordKeyChain]; ok {
		if err := n.chain.decode(data); err != nil {
			return fmt.Errorf("decode policy key chain: %w", err)
		}
	}
	for _, name := range sortedKeys(records) {
		data := records[name]
		switch {
		case strings.HasPrefix(name, prefixLink):
			link := &pb.LeasePolicyKeyRotation{}
			if proto.Unmarshal(data, link) == nil {
				n.chain.links[link.GetKeyId()] = link
			}
		case strings.HasPrefix(name, prefixVoters):
			block := &pb.LeaseSignedBlock{}
			if proto.Unmarshal(data, block) != nil {
				continue
			}
			if manifest, err := parseManifest(block); err == nil {
				n.rememberVoters(manifest.Voters)
			}
		case strings.HasPrefix(name, prefixManifest):
			block := &pb.LeaseSignedBlock{}
			if proto.Unmarshal(data, block) != nil {
				continue
			}
			if manifest, err := parseManifest(block); err == nil {
				n.manifests[manifest.PolicyID] = manifest
				n.rememberVoters(manifest.Voters)
			}
		case strings.HasPrefix(name, prefixKey):
			record, err := decodeKeyRecord(data)
			if err != nil {
				continue
			}
			rest := strings.TrimPrefix(name, prefixKey)
			cut := strings.LastIndex(rest, "/")
			var slot uint32
			if cut <= 0 {
				continue
			}
			if _, err := fmt.Sscanf(rest[cut+1:], "%d", &slot); err != nil {
				continue
			}
			key := Key{PolicyID: rest[:cut], Slot: slot}
			n.acceptors[key] = restoreAcceptorKey(record)
		}
	}
	return nil
}

// ID returns the node identity.
func (n *Node) ID() string { return n.id }

// Incarnation returns the persisted incarnation of this process.
func (n *Node) Incarnation() uint64 {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.incarnation
}

// run executes fn under the lock, persists dirty state, and sends the
// resulting frames after unlocking.
func (n *Node) run(fn func(now time.Duration)) {
	n.mu.Lock()
	now := n.clock.Now()
	fn(now)
	n.processLoopback(now)
	out := n.commitLocked(now)
	n.mu.Unlock()
	n.send(out)
}

// Tick drives timers. Call it at NextWakeup or at least every 250 ms.
func (n *Node) Tick() {
	n.run(func(now time.Duration) { n.tickProposers(now) })
}

// NextWakeup returns the local clock value at which Tick is next needed.
func (n *Node) NextWakeup() time.Duration {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.nextWakeup(n.clock.Now())
}

func (n *Node) receiveLocked(batch *pb.LeaseBatch, now time.Duration) {
	from := batch.GetSenderId()
	if id := batch.GetMessageId(); id != "" {
		if _, dup := n.seen[id]; dup {
			return
		}
		n.seen[id] = struct{}{}
		n.seenOrder = append(n.seenOrder, id)
		if len(n.seenOrder) > dedupCapacity {
			delete(n.seen, n.seenOrder[0])
			n.seenOrder = n.seenOrder[1:]
		}
	}
	// A9: a frame from an older incarnation of the sender is a replay.
	if incarnation := batch.GetSenderIncarnation(); incarnation < n.peers[from] {
		return
	} else if incarnation > n.peers[from] {
		// A restarted peer may have lost its blocks: forward them again.
		n.peers[from] = incarnation
		for name := range n.forwarded {
			if strings.HasPrefix(name, from+"\x00") {
				delete(n.forwarded, name)
			}
		}
	}
	for _, item := range batch.GetItems() {
		n.handleItem(from, item, now)
	}
}

func (n *Node) processLoopback(now time.Duration) {
	for guard := 0; len(n.loopback) > 0 && guard < 64; guard++ {
		items := n.loopback
		n.loopback = nil
		for _, item := range items {
			n.handleItem(n.id, item, now)
		}
	}
}

func (n *Node) handleItem(from string, item *pb.LeaseItem, now time.Duration) {
	switch body := item.GetBody().(type) {
	case *pb.LeaseItem_Prepare:
		n.onPrepare(from, body.Prepare, now)
	case *pb.LeaseItem_Promise:
		n.onPromise(from, body.Promise, now)
	case *pb.LeaseItem_Propose:
		n.onPropose(from, body.Propose, now)
	case *pb.LeaseItem_Accepted:
		n.onAccepted(from, body.Accepted, now)
	case *pb.LeaseItem_Nack:
		n.onNack(from, body.Nack, now)
	case *pb.LeaseItem_Commit:
		n.reportLag(from, body.Commit)
		n.storeCommit(body.Commit, now)
		n.observeCommit(body.Commit, true, now)
	case *pb.LeaseItem_Release:
		n.onRelease(from, body.Release, now)
	case *pb.LeaseItem_ReleaseAck:
		n.onReleaseAck(from, body.ReleaseAck, now)
	case *pb.LeaseItem_Query:
		n.onQuery(from, body.Query, now)
	case *pb.LeaseItem_Status:
		n.onStatus(from, body.Status, now)
	}
}

// queue adds an item for dest; items for this node loop back locally.
func (n *Node) queue(dest string, item *pb.LeaseItem) {
	if dest == n.id {
		n.loopback = append(n.loopback, item)
		return
	}
	n.outbox[dest] = append(n.outbox[dest], item)
}

// commitLocked persists dirty state and builds outgoing batches. If the
// write fails nothing is sent and the node abstains, which is always safe.
func (n *Node) commitLocked(now time.Duration) []outgoing {
	if len(n.dirty) > 0 || len(n.dirtyOther) > 0 || len(n.deletes) > 0 {
		puts := n.dirtyOther
		for key := range n.dirty {
			if ak := n.acceptors[key]; ak != nil {
				puts[keyRecordName(key)] = encodeKeyRecord(ak.rec)
			}
		}
		err := n.store.Apply(puts, n.deletes)
		n.dirty, n.dirtyOther, n.deletes = map[Key]bool{}, map[string][]byte{}, nil
		if err != nil {
			n.logf("availability lease state write failed, abstaining: %v", err)
			n.startedAt = now
			n.outbox, n.attach = map[string][]*pb.LeaseItem{}, map[string]map[string]bool{}
			return nil
		}
	}
	if len(n.outbox) == 0 && len(n.attach) == 0 {
		return nil
	}
	dests := map[string]bool{}
	for dest := range n.outbox {
		dests[dest] = true
	}
	for dest := range n.attach {
		dests[dest] = true
	}
	out := make([]outgoing, 0, len(dests))
	for _, dest := range sortedKeys(dests) {
		n.messageSeq++
		batch := &pb.LeaseBatch{
			MessageId: fmt.Sprintf("%s/%d/%d", n.id, n.incarnation, n.messageSeq),
			SenderId:  n.id, SenderIncarnation: n.incarnation, DestinationId: dest, Items: n.outbox[dest],
		}
		if policies := n.attach[dest]; len(policies) > 0 {
			for _, policyID := range sortedKeys(policies) {
				if manifest := n.manifests[policyID]; manifest != nil {
					batch.Blocks = append(batch.Blocks, manifest.block)
				}
			}
			batch.KeyRotations = n.chain.chainLinks()
		}
		out = append(out, outgoing{to: dest, batch: batch})
	}
	n.outbox, n.attach = map[string][]*pb.LeaseItem{}, map[string]map[string]bool{}
	return out
}

func (n *Node) send(out []outgoing) {
	for _, message := range out {
		if n.rawSend != nil {
			n.rawSend(message.to, message.batch)
			continue
		}
		if n.transport == nil {
			continue
		}
		frame, err := SealFrame(message.batch, n.signer)
		if err != nil {
			n.logf("seal availability lease frame: %v", err)
			continue
		}
		n.transport.Send(frame)
	}
}

func (n *Node) markDirty(key Key) { n.dirty[key] = true }

// policyConfig returns the current voter set of a policy (A18).
func (n *Node) policyConfig(policyID string) *VoterConfig {
	if manifest := n.manifests[policyID]; manifest != nil {
		return manifest.Voters
	}
	return nil
}

// configByEpoch returns a policy's voter config of an epoch, when known.
func (n *Node) configByEpoch(policyID string, epoch uint64) *VoterConfig {
	for _, config := range n.history[policyID] {
		if config.Epoch == epoch {
			return config
		}
	}
	return nil
}

// rememberVoters records a policy's voter config in its bounded history.
// It reports whether the epoch was new.
func (n *Node) rememberVoters(config *VoterConfig) bool {
	if config == nil || config.Epoch == 0 {
		return false
	}
	list := n.history[config.PolicyID]
	for i, known := range list {
		if known.Epoch == config.Epoch {
			list[i] = config
			return false
		}
	}
	list = append(list, config)
	sort.Slice(list, func(i, j int) bool { return list[i].Epoch < list[j].Epoch })
	for len(list) > configHistory {
		n.deletes = append(n.deletes, votersRecordName(config.PolicyID, list[0].Epoch))
		list = list[1:]
	}
	n.history[config.PolicyID] = list
	return true
}

func votersRecordName(policyID string, epoch uint64) string {
	return fmt.Sprintf("%s%s/%020d", prefixVoters, policyID, epoch)
}

// identityKey resolves a frame sender among every policy's members and
// candidates. Being known to one policy does not make a node a voter of
// another: votes are always checked against the key's own policy.
func (n *Node) identityKey(id string) ([]byte, bool) {
	for _, policyID := range sortedKeys(n.manifests) {
		manifest := n.manifests[policyID]
		if key, ok := manifest.keys[id]; ok {
			return key, true
		}
		if key, ok := manifest.Voters.publicKey(id); ok {
			return key, true
		}
	}
	for _, policyID := range sortedKeys(n.history) {
		for _, config := range n.history[policyID] {
			if key, ok := config.publicKey(id); ok {
				return key, true
			}
		}
	}
	return nil, false
}

func (n *Node) emit(event Event) { n.events = append(n.events, event) }

// DrainEvents returns lease transitions since the last call, for lease
// reports and audit events.
func (n *Node) DrainEvents() []Event {
	n.mu.Lock()
	defer n.mu.Unlock()
	events := n.events
	n.events = nil
	return events
}
