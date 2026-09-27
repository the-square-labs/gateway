package daemon

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"google.golang.org/protobuf/proto"
)

// availabilityLeaseCapability is advertised once this node can participate in
// availability-lease coordination: an observer always, an acceptor when the
// voter set names it (T5; D8, A8 for the Secure Link sockets it drives).
const availabilityLeaseCapability = "availability_lease_v1"

// availabilityLeaseTickInterval drives the Node's timers and the Secure Link
// socket sweep at least as often as doc.go requires (every 250 ms).
const availabilityLeaseTickInterval = 250 * time.Millisecond

// availabilityLeaseReconnectDelay paces Coordinate/WatchLeaseGates retries.
const availabilityLeaseReconnectDelay = time.Second

// availabilityLeaseCoordinator wires the daemon-shared availabilitylease.Node
// into the nginx daemon's own relay transports and Secure Link sockets:
//   - it runs the Node as an observer on every relay Coordinate stream it
//     holds, and as an acceptor once the voter set names this node (A3, A16);
//   - it derives Secure Link socket state from relay gate views (D8, A8).
type availabilityLeaseCoordinator struct {
	stateDir string
	logger   *slog.Logger
	sockets  *sourceLinkManager

	transport *availabilityLeaseTransport
	gates     *leaseGateTracker

	mu                sync.Mutex
	node              *availabilitylease.Node
	clock             availabilitylease.Clock
	startedAt         time.Duration
	identityPublicKey []byte
	revision          uint64
	knownKeyIDs       map[string]struct{}
	knownPolicyIDs    map[string]struct{}
	leading           map[string]bool

	stopOnce sync.Once
	stop     chan struct{}
}

func newAvailabilityLeaseCoordinator(stateDir string, sockets *sourceLinkManager, logger *slog.Logger) *availabilityLeaseCoordinator {
	return &availabilityLeaseCoordinator{
		stateDir:       stateDir,
		logger:         logger,
		sockets:        sockets,
		transport:      newAvailabilityLeaseTransport(),
		gates:          newLeaseGateTracker(),
		knownKeyIDs:    map[string]struct{}{},
		knownPolicyIDs: map[string]struct{}{},
		leading:        map[string]bool{},
		stop:           make(chan struct{}),
	}
}

// start runs the Secure Link socket sweep for the life of the process. It is
// independent of the Node's own lifecycle: gate views can arrive, and stale
// ones must be acted on, whether or not this node has an identity yet.
func (c *availabilityLeaseCoordinator) start() {
	go c.runSocketSweep()
}

func (c *availabilityLeaseCoordinator) close() {
	c.stopOnce.Do(func() { close(c.stop) })
}

// ready reports whether the Node was constructed: a durable store and an
// identity signer are in place, so this daemon can advertise the capability.
func (c *availabilityLeaseCoordinator) ready() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.node != nil
}

// ensureNode builds the durable Node the first time a stable node id is
// known. It is idempotent: every session start may call it, but only the
// first successful call constructs the Node (A3, A16).
func (c *availabilityLeaseCoordinator) ensureNode(nodeID, certPath, keyPath string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.node != nil {
		return nil
	}
	if nodeID == "" {
		return errors.New("availability lease node id is not known yet")
	}
	identityKey, publicKey, err := loadAvailabilityLeaseIdentity(certPath, keyPath)
	if err != nil {
		return fmt.Errorf("load availability lease identity: %w", err)
	}
	clock := availabilitylease.SystemClock()
	store := newAvailabilityLeaseFileStore(c.stateDir)
	node, err := availabilitylease.NewNode(availabilitylease.Config{
		ID:               nodeID,
		Clock:            clock,
		Store:            store,
		Transport:        c.transport,
		Signer:           availabilitylease.ECDSASigner{Key: identityKey},
		IncarnationFloor: uint64(time.Now().UnixMilli()),
		Logf:             c.logf,
	})
	if err != nil {
		return fmt.Errorf("create availability lease node: %w", err)
	}
	c.node = node
	c.clock = clock
	c.startedAt = clock.Now()
	c.identityPublicKey = publicKey
	go c.runNodeTicker()
	return nil
}

func (c *availabilityLeaseCoordinator) logf(format string, args ...any) {
	if c.logger != nil {
		c.logger.Debug(fmt.Sprintf(format, args...))
	}
}

func (c *availabilityLeaseCoordinator) currentNode() *availabilitylease.Node {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.node
}

// runNodeTicker drives the Node's timers at least every 250 ms, as doc.go
// requires (Tick at NextWakeup or at least every 250 ms). A fixed interval is
// simpler than tracking NextWakeup and is well inside that bound.
func (c *availabilityLeaseCoordinator) runNodeTicker() {
	ticker := time.NewTicker(availabilityLeaseTickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-ticker.C:
			if node := c.currentNode(); node != nil {
				node.Tick()
			}
		}
	}
}

// runSocketSweep closes Secure Link sockets whose backing gate view has gone
// stale, without waiting for a relay to broadcast that it is gone (D8, A8).
func (c *availabilityLeaseCoordinator) runSocketSweep() {
	ticker := time.NewTicker(availabilityLeaseTickInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.stop:
			return
		case <-ticker.C:
			c.reconcileSockets()
		}
	}
}

// reconcileSockets opens or closes every availability member's Secure Link
// socket according to the relay gate views currently held (D8, A8).
func (c *availabilityLeaseCoordinator) reconcileSockets() {
	if c.sockets == nil {
		return
	}
	now := time.Now()
	for _, binding := range c.sockets.leaseGatedBindings() {
		open := c.gates.openFor(binding.PolicyID, binding.CandidateID, now)
		if err := c.sockets.setLeaseOpen(binding.LinkID, open); err != nil {
			c.logf("availability lease socket %s: %v", binding.LinkID, err)
		}
	}
}

// apply adopts a SyncAvailabilityLeaseCommand: policy keys, key rotations,
// the voter config and every policy manifest (T3's contract for T4/T5).
func (c *availabilityLeaseCoordinator) apply(command *pb.SyncAvailabilityLeaseCommand) (string, error) {
	if command == nil {
		return "", errors.New("availability lease sync command is required")
	}
	node := c.currentNode()
	if node == nil {
		return "", errors.New("availability lease node is not initialized")
	}
	for _, key := range command.GetPolicyKeys() {
		if key.GetKeyId() == "" {
			continue
		}
		if err := node.TrustPolicyKey(key.GetKeyId(), key.GetPublicKey()); err != nil {
			return "", fmt.Errorf("trust policy key %s: %w", key.GetKeyId(), err)
		}
		c.rememberKeyID(key.GetKeyId())
	}
	for _, raw := range command.GetKeyRotations() {
		link := &relayv1.LeasePolicyKeyRotation{}
		if err := proto.Unmarshal(raw, link); err != nil {
			return "", fmt.Errorf("decode policy key rotation: %w", err)
		}
		if err := node.AdoptKeyRotation(link); err != nil {
			return "", fmt.Errorf("adopt policy key rotation: %w", err)
		}
		c.rememberKeyID(link.GetKeyId())
	}
	if len(command.GetVoterConfig()) > 0 {
		block := &relayv1.LeaseSignedBlock{}
		if err := proto.Unmarshal(command.GetVoterConfig(), block); err != nil {
			return "", fmt.Errorf("decode voter config: %w", err)
		}
		if _, err := node.AdoptVoterConfig(block); err != nil {
			return "", fmt.Errorf("adopt voter config: %w", err)
		}
	}
	for _, raw := range command.GetManifests() {
		block := &relayv1.LeaseSignedBlock{}
		if err := proto.Unmarshal(raw, block); err != nil {
			return "", fmt.Errorf("decode lease manifest: %w", err)
		}
		if _, err := node.AdoptManifest(block); err != nil {
			return "", fmt.Errorf("adopt lease manifest: %w", err)
		}
		c.rememberManifestPolicy(block.GetPayload())
	}
	c.mu.Lock()
	if command.GetRevision() > c.revision {
		c.revision = command.GetRevision()
	}
	c.mu.Unlock()
	c.reconcileSockets()
	detail, _ := json.Marshal(map[string]any{"revision": command.GetRevision()})
	return string(detail), nil
}

func (c *availabilityLeaseCoordinator) rememberKeyID(id string) {
	if id == "" {
		return
	}
	c.mu.Lock()
	c.knownKeyIDs[id] = struct{}{}
	c.mu.Unlock()
}

func (c *availabilityLeaseCoordinator) rememberManifestPolicy(payload []byte) {
	manifest := &relayv1.LeaseManifest{}
	if proto.Unmarshal(payload, manifest) != nil || manifest.GetPolicyId() == "" {
		return
	}
	c.mu.Lock()
	c.knownPolicyIDs[manifest.GetPolicyId()] = struct{}{}
	c.mu.Unlock()
}

// buildReport is this node's availability-lease heartbeat (T3's contract):
// identity, the persisted acceptor state, and the last applied revision.
// nginx never proposes, so Held, Events and WatchdogReady stay empty.
func (c *availabilityLeaseCoordinator) buildReport() *pb.AvailabilityLeaseReport {
	c.mu.Lock()
	node, clock, startedAt := c.node, c.clock, c.startedAt
	identityPublicKey, revision := c.identityPublicKey, c.revision
	keyIDs := sortedSetKeys(c.knownKeyIDs)
	policyIDs := sortedSetKeys(c.knownPolicyIDs)
	c.mu.Unlock()
	if node == nil {
		return nil
	}
	report := &pb.AvailabilityLeaseReport{
		MemberId:           node.ID(),
		IdentityPublicKey:  identityPublicKey,
		Incarnation:        node.Incarnation(),
		Epoch:              node.Epoch(),
		AcceptorAbstaining: clock.Now() < startedAt+availabilitylease.AbstainAfterStart,
		LeaseRevision:      revision,
	}
	for _, id := range keyIDs {
		if node.TrustsPolicyKey(id) {
			report.TrustedPolicyKeyIds = append(report.TrustedPolicyKeyIds, id)
		}
	}
	for _, policyID := range policyIDs {
		if version := node.ManifestVersion(policyID); version > 0 {
			report.Manifests = append(report.Manifests, &pb.AvailabilityLeaseManifestAck{
				PolicyId: policyID, ManifestVersion: version, Closed: !node.LeaseMode(policyID),
			})
		}
	}
	for _, view := range node.AcceptorView() {
		entry := &pb.AvailabilityLeaseKeyView{
			PolicyId:        view.Key.PolicyID,
			Slot:            view.Key.Slot,
			State:           leaseKeyStateName(view.State),
			HolderId:        view.Holder,
			ReservedFor:     view.ReservedFor,
			Epoch:           report.Epoch,
			ManifestVersion: node.ManifestVersion(view.Key.PolicyID),
		}
		if !view.Promised.IsZero() {
			entry.Promised = leaseBallotProto(view.Promised)
		}
		if !view.CommitBallot.IsZero() {
			entry.Committed = leaseBallotProto(view.CommitBallot)
		}
		report.Acceptor = append(report.Acceptor, entry)
	}
	return report
}

func leaseBallotProto(ballot availabilitylease.Ballot) *pb.AvailabilityLeaseBallot {
	return &pb.AvailabilityLeaseBallot{Round: ballot.Round, Incarnation: ballot.Incarnation, ProposerId: ballot.Proposer}
}

func leaseKeyStateName(state relayv1.LeaseKeyState) string {
	return strings.ToLower(strings.TrimPrefix(state.String(), "LEASE_KEY_STATE_"))
}

func sortedSetKeys(set map[string]struct{}) []string {
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// loadAvailabilityLeaseIdentity reads the daemon's mTLS client identity (the
// same key used for Secure Link and its Coordinate stream, CN = node id) as
// an ECDSA P-256 signer for lease frames (A1, D3).
func loadAvailabilityLeaseIdentity(certPath, keyPath string) (*ecdsa.PrivateKey, []byte, error) {
	cert, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, nil, err
	}
	key, ok := cert.PrivateKey.(*ecdsa.PrivateKey)
	if !ok {
		return nil, nil, errors.New("mTLS identity key is not ECDSA")
	}
	if key.Curve != elliptic.P256() {
		return nil, nil, errors.New("mTLS identity key is not P-256")
	}
	publicKey, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return nil, nil, err
	}
	return key, publicKey, nil
}
