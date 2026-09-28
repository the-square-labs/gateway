// Package lease runs the relay side of the Docker Availability data-plane
// lease (availabilitylease): the Coordinate stream router, the relay's own
// acceptor, and the data-path gate the tunnel broker consults.
package lease

import (
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/policy"
	"google.golang.org/protobuf/proto"
)

// tickCeiling bounds how long the loop sleeps between protocol ticks, suspend
// checks and gate enforcement.
const tickCeiling = 250 * time.Millisecond

type Config struct {
	// ID is this relay's lease member id: its relay instance id.
	ID    string
	Store availabilitylease.Store
	// Keys yields the relay identity keys that sign frames and accepts.
	Keys IdentityKeys
	// TrustedKeys returns the policy signing keys the relay pins, oldest first.
	TrustedKeys func() []policy.TrustedPolicyKey
	Clock       availabilitylease.Clock
	Wall        func() time.Time
	Logger      *slog.Logger
}

// Coordinator owns the relay's availability lease node.
type Coordinator struct {
	id          string
	node        *availabilitylease.Node
	clock       availabilitylease.Clock
	wall        func() time.Time
	keys        IdentityKeys
	trustedKeys func() []policy.TrustedPolicyKey
	logger      *slog.Logger
	view        *memberView
	suspend     *suspendDetector
	startedAt   time.Duration

	seedOnce   sync.Once
	seedLinks  []*relayv1.LeasePolicyKeyRotation
	seedBlocks []*relayv1.LeaseSignedBlock

	mu      sync.Mutex
	streams map[string][]*memberStream
	// suspendAt is the lease clock when the last suspend was detected; gates
	// stay closed until a promise anchored after it (A17).
	suspended       bool
	suspendAt       time.Duration
	lastSuspendWall time.Time
	lastSuspend     time.Duration
	enforce         func() time.Duration
	// holderEndpoint reports whether a holder's endpoint takes traffic through
	// this relay (the broker's registrations), for gate views (D6).
	holderEndpoint func(policyID, holderID string) relayv1.LeaseHolderEndpoint
	// identityKey is the PKIX DER key the node signs with (the current one).
	identityKey []byte

	notify chan struct{}
	stop   chan struct{}
	done   chan struct{}
}

// New loads the acceptor state, bumps and persists the incarnation and starts
// the restart abstention window (A3).
func New(cfg Config) (*Coordinator, error) {
	if cfg.ID == "" || cfg.Store == nil || cfg.Keys == nil || cfg.TrustedKeys == nil {
		return nil, errors.New("availability lease coordinator needs an id, a store, identity keys and trusted keys")
	}
	if cfg.Clock == nil {
		cfg.Clock = availabilitylease.SystemClock()
	}
	if cfg.Wall == nil {
		cfg.Wall = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	c := &Coordinator{
		id: cfg.ID, clock: cfg.Clock, wall: cfg.Wall, keys: cfg.Keys, trustedKeys: cfg.TrustedKeys,
		logger: cfg.Logger.With("component", "availability_lease"), view: newMemberView(),
		streams: map[string][]*memberStream{}, notify: make(chan struct{}, 1), stop: make(chan struct{}), done: make(chan struct{}),
	}
	start, rotateTo := initialSigner(cfg.Keys, cfg.Wall())
	if start == nil {
		return nil, errors.New("relay identity key cannot sign")
	}
	if err := c.loadSeeds(cfg.Store); err != nil {
		return nil, err
	}
	node, err := availabilitylease.NewNode(availabilitylease.Config{
		ID: cfg.ID, Clock: cfg.Clock, Store: cfg.Store, Transport: c, Signer: availabilitylease.ECDSASigner{Key: start},
		Logf: func(format string, args ...any) { c.logger.Debug(fmt.Sprintf(format, args...)) },
		// Keeps incarnations increasing when relay.db was renamed (A3, A16).
		IncarnationFloor: uint64(cfg.Wall().UnixMilli()),
	})
	if err != nil {
		return nil, err
	}
	c.node = node
	c.identityKey = publicKeyDER(start)
	if rotateTo != nil {
		// Restarted within the overlap of a key renewal: keep dual-signing.
		c.checkIdentityKey()
	}
	c.startedAt = cfg.Clock.Now()
	c.suspend = newSuspendDetector(cfg.Wall, cfg.Clock.Now)
	return c, nil
}

// loadSeeds keeps the signed blocks and rotation links the node persisted, so
// the member view knows peers named only by blocks that arrived in frames
// before a restart. The view verifies them like any forwarded block.
func (c *Coordinator) loadSeeds(store availabilitylease.Store) error {
	records, err := store.Load()
	if err != nil {
		return fmt.Errorf("load availability lease state: %w", err)
	}
	names := make([]string, 0, len(records))
	for name := range records {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		value := records[name]
		block := &relayv1.LeaseSignedBlock{}
		if proto.Unmarshal(value, block) == nil && len(block.GetPayload()) > 0 && len(block.GetSignature()) > 0 &&
			block.GetKind() == relayv1.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST {
			c.seedBlocks = append(c.seedBlocks, block)
			continue
		}
		link := &relayv1.LeasePolicyKeyRotation{}
		if proto.Unmarshal(value, link) == nil && link.GetKeyId() != "" && len(link.GetSignature()) > 0 {
			c.seedLinks = append(c.seedLinks, link)
		}
	}
	return nil
}

// ID returns the relay's lease member id.
func (c *Coordinator) ID() string { return c.id }

// Start runs the protocol loop. enforce re-checks broker registrations and
// tunnels and returns how long until the earliest open gate closes.
func (c *Coordinator) Start(enforce func() time.Duration) {
	c.mu.Lock()
	c.enforce = enforce
	c.mu.Unlock()
	go c.loop()
}

// SetHolderEndpoints installs the broker's view of holder endpoint readiness
// for the gate views nginx daemons watch (D6). It must not call back into the
// coordinator.
func (c *Coordinator) SetHolderEndpoints(holderEndpoint func(policyID, holderID string) relayv1.LeaseHolderEndpoint) {
	c.mu.Lock()
	c.holderEndpoint = holderEndpoint
	c.mu.Unlock()
}

// Stop ends the protocol loop. Streams end with the gRPC server.
func (c *Coordinator) Stop() {
	select {
	case <-c.stop:
	default:
		close(c.stop)
	}
	<-c.done
}

func (c *Coordinator) kick() {
	select {
	case c.notify <- struct{}{}:
	default:
	}
}

func (c *Coordinator) loop() {
	defer close(c.done)
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-timer.C:
		case <-c.notify:
		}
		c.observeSuspend()
		c.checkIdentityKey()
		c.node.Tick()
		c.node.DrainEvents()
		wait := tickCeiling
		if next := c.node.NextWakeup() - c.clock.Now(); next < wait {
			wait = max(next, 5*time.Millisecond)
		}
		c.mu.Lock()
		enforce := c.enforce
		c.mu.Unlock()
		if enforce != nil {
			if remaining := enforce(); remaining > 0 && remaining < wait {
				wait = remaining
			}
		}
		timer.Reset(wait)
	}
}

// observeSuspend closes every gate until a fresh promise after a detected
// suspend, then ages the node's gate anchors by the missed time (A17).
func (c *Coordinator) observeSuspend() {
	missed := c.suspend.check()
	if missed <= 0 {
		return
	}
	c.mu.Lock()
	c.suspended, c.suspendAt = true, c.clock.Now()
	c.lastSuspendWall, c.lastSuspend = c.wall(), missed
	c.mu.Unlock()
	c.node.ObserveSuspend(missed)
	c.logger.Warn("host suspend detected; availability lease gates closed until fresh promises", "missed", missed.String())
	c.kick()
}

// ApplyPolicy trusts the relay's pinned policy keys and adopts the lease
// blocks of a verified policy snapshot (A4, A14).
func (c *Coordinator) ApplyPolicy(snapshot *policy.Snapshot) {
	for _, key := range c.trustedKeys() {
		if err := c.node.TrustPolicyKey(key.KeyID, key.PublicKey); err != nil {
			c.logger.Warn("availability lease refused a pinned policy key", "key_id", key.KeyID, "error", err)
		}
		c.view.trust(key.KeyID, key.PublicKey)
	}
	changed := false
	c.seedOnce.Do(func() { changed = c.ingest(c.seedLinks, c.seedBlocks) })
	if snapshot != nil && c.ingest(snapshot.LeaseKeyRotations, snapshot.LeaseBlocks) {
		changed = true
	}
	if changed {
		c.revalidateStreams()
	}
	c.kick()
}

// ingest adopts rotation links and policy manifests (which carry each
// policy's voters, A18) into the node and the member view.
// Anyone may forward them: both verify the policy-key signatures (A4, A14).
func (c *Coordinator) ingest(links []*relayv1.LeasePolicyKeyRotation, blocks []*relayv1.LeaseSignedBlock) bool {
	pending := links
	for len(pending) > 0 {
		var retry []*relayv1.LeasePolicyKeyRotation
		for _, link := range pending {
			if err := c.node.AdoptKeyRotation(link); err != nil {
				retry = append(retry, link)
			}
		}
		if len(retry) == len(pending) {
			break
		}
		pending = retry
	}
	c.view.adoptLinks(links)
	changed := false
	for _, block := range blocks {
		if block.GetKind() != relayv1.LeaseBlockKind_LEASE_BLOCK_KIND_MANIFEST {
			continue
		}
		if _, err := c.node.AdoptManifest(block); err != nil {
			c.logger.Debug("availability lease manifest rejected", "error", err)
		}
		if c.view.adoptBlock(block) {
			changed = true
		}
	}
	return changed
}
