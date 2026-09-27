package availabilitylease

import (
	"sort"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

// round is one prepare/propose exchange. Every acquisition and every renewal
// uses a fresh ballot (A11); anchor is read before the prepare is sent (A1).
type round struct {
	ballot     Ballot
	anchor     time.Duration
	deadline   time.Duration
	config     *VoterConfig
	manifest   *Manifest
	purpose    Role
	proposing  bool
	proposeAt  time.Duration
	echoes     map[string]uint64
	promised   map[string]bool
	proposedTo map[string]bool
	accepts    map[string]*pb.LeaseAccepted
	refused    map[string]bool
	sawOther   bool
	higher     bool
}

func (n *Node) startRound(pk *proposerKey, manifest *Manifest, purpose Role, now time.Duration) {
	config := manifest.Voters
	if config == nil || len(config.sets) == 0 || pk.key.Slot >= manifest.Slots {
		return
	}
	next := pk.maxRound
	if pk.lastIssued.Round > next {
		next = pk.lastIssued.Round
	}
	ballot := Ballot{Round: next + 1, Incarnation: n.incarnation, Proposer: n.id}
	pk.lastIssued, pk.maxRound = ballot, ballot.Round
	pk.retry = false
	pk.round = &round{
		ballot: ballot, anchor: now, deadline: now + roundTimeout, config: config, manifest: manifest, purpose: purpose,
		echoes: map[string]uint64{}, promised: map[string]bool{}, proposedTo: map[string]bool{},
		accepts: map[string]*pb.LeaseAccepted{}, refused: map[string]bool{},
	}
	if purpose == RoleAcquiring || purpose == RoleBootstrapping {
		pk.role = purpose
	}
	prepare := &pb.LeasePrepare{Key: pk.key.proto(), Ballot: ballot.proto(), Epoch: config.Epoch, ManifestVersion: manifest.Version}
	for _, id := range config.memberIDs {
		n.forwardOnce(id, pk.key.PolicyID)
		n.queue(id, &pb.LeaseItem{Body: &pb.LeaseItem_Prepare{Prepare: prepare}})
	}
}

func (n *Node) currentRound(key Key, ballot *pb.LeaseBallot) (*proposerKey, *round) {
	pk := n.proposers[key]
	if pk == nil || pk.round == nil || pk.round.ballot != ballotFromProto(ballot) {
		return pk, nil
	}
	return pk, pk.round
}

func (n *Node) onPromise(from string, msg *pb.LeasePromise, now time.Duration) {
	key, ok := keyFromProto(msg.GetKey())
	if !ok {
		return
	}
	pk, r := n.currentRound(key, msg.GetBallot())
	if r == nil {
		return
	}
	if msg.GetEcho() != 0 {
		r.echoes[from] = msg.GetEcho()
	}
	if !msg.GetShadow() && r.config.isVoter(from) {
		r.promised[from] = true
	}
	if r.proposing {
		n.sendPropose(pk, r, from, now)
		return
	}
	if r.config.quorum(r.promised) {
		n.beginPropose(pk, r, now)
	}
}

func (n *Node) beginPropose(pk *proposerKey, r *round, now time.Duration) {
	r.proposing, r.proposeAt = true, now
	ids := make([]string, 0, len(r.echoes))
	for id := range r.echoes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		n.sendPropose(pk, r, id, now)
	}
}

func (n *Node) sendPropose(pk *proposerKey, r *round, to string, now time.Duration) {
	if r.proposedTo[to] {
		return
	}
	r.proposedTo[to] = true
	pk.lastProposeAt = now
	propose := &pb.LeasePropose{
		Key: pk.key.proto(), Ballot: r.ballot.proto(), Epoch: r.config.Epoch,
		ManifestVersion: r.manifest.Version, Echo: r.echoes[to],
	}
	n.queue(to, &pb.LeaseItem{Body: &pb.LeaseItem_Propose{Propose: propose}})
}

func (n *Node) onAccepted(from string, msg *pb.LeaseAccepted, now time.Duration) {
	key, ok := keyFromProto(msg.GetKey())
	if !ok || msg.GetAcceptorId() != from {
		return
	}
	pk, r := n.currentRound(key, msg.GetBallot())
	if r == nil || !r.config.isVoter(from) || msg.GetEpoch() != r.config.Epoch || msg.GetManifestVersion() != r.manifest.Version {
		return
	}
	publicKey, _ := r.config.publicKey(from)
	statement := acceptStatement(key, r.ballot, msg.GetEpoch(), msg.GetManifestVersion(), from, msg.GetAcceptorIncarnation())
	if !n.verifier.Verify(publicKey, statement, msg.GetSignature()) {
		return
	}
	r.accepts[from] = msg
	if r.config.quorum(acceptIDs(r)) {
		n.roundSucceeded(pk, r, true, now)
	}
}

func acceptIDs(r *round) map[string]bool {
	ids := make(map[string]bool, len(r.accepts))
	for id := range r.accepts {
		ids[id] = true
	}
	return ids
}

// tickRound handles round timeouts and the available-mode minority rule:
// after availableCollect every acceptor that answered was free and at least
// one voting relay accepted (D11).
func (n *Node) tickRound(pk *proposerKey, now time.Duration) {
	r := pk.round
	if r.manifest.Available && !r.sawOther && now >= r.anchor+availableCollect {
		if !r.proposing && len(r.promised) > 0 {
			n.beginPropose(pk, r, now)
		}
		if r.proposing && now >= r.proposeAt+availableCollect && n.relayAccepted(r) {
			n.roundSucceeded(pk, r, false, now)
			return
		}
	}
	if now >= r.deadline {
		n.finishRound(pk, now)
	}
}

func (n *Node) relayAccepted(r *round) bool {
	for id := range r.accepts {
		if r.config.isRelay(id) {
			return true
		}
	}
	return false
}

func (n *Node) roundSucceeded(pk *proposerKey, r *round, majority bool, now time.Duration) {
	pk.round = nil
	ids := make([]string, 0, len(r.accepts))
	for id := range r.accepts {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	commit := &pb.LeaseCommit{Key: pk.key.proto(), Ballot: r.ballot.proto(), Epoch: r.config.Epoch, ManifestVersion: r.manifest.Version}
	for _, id := range ids {
		commit.Quorum = append(commit.Quorum, r.accepts[id])
	}
	acquired := pk.role != RoleHolding
	pk.role = RoleHolding
	pk.ballot, pk.ownMajority, pk.anchor = r.ballot, majority, r.anchor
	pk.deadline, pk.softAt = r.anchor+FenceCompleteAfter, r.anchor+SoftFenceAfter
	if r.manifest.Available {
		pk.deadline, pk.softAt = now+FenceCompleteAfter, now+FenceCompleteAfter
	}
	pk.designated, pk.retry = false, false
	if r.purpose == RoleBootstrapping {
		pk.bootstrapDone = r.manifest.BootstrapID
	}
	pk.commit, pk.commitBallot = commit, r.ballot
	pk.freshCommitAt, pk.hasFreshCommit = now, true
	if acquired {
		n.emit(Event{Kind: EventAcquired, Key: pk.key, Ballot: r.ballot, At: now})
	}
	targets := map[string]bool{}
	for _, id := range r.config.memberIDs {
		targets[id] = true
	}
	for _, id := range r.manifest.Candidates {
		targets[id] = true
	}
	for _, id := range sortedKeys(targets) {
		n.forwardOnce(id, pk.key.PolicyID)
		n.queue(id, &pb.LeaseItem{Body: &pb.LeaseItem_Commit{Commit: commit}})
	}
}

// finishRound ends a round that did not reach a quorum.
func (n *Node) finishRound(pk *proposerKey, now time.Duration) {
	r := pk.round
	if r == nil {
		return
	}
	pk.round = nil
	switch pk.role {
	case RoleHolding, RoleRecovering:
		pk.retry = true
		pk.nextRoundAt = now + retryBackoff
		if r.higher {
			// A13: a higher ballot alone triggers a retry, not a fence.
			pk.nextRoundAt = now
		}
	case RoleAcquiring, RoleBootstrapping:
		pk.role = RoleCandidate
		pk.expiredSeen = false
		pk.nextRoundAt = now + retryBackoff
		if pk.designated {
			pk.nextRoundAt = now + successorRetry
		}
	}
}

func (n *Node) onNack(from string, msg *pb.LeaseNack, now time.Duration) {
	key, ok := keyFromProto(msg.GetKey())
	if !ok {
		return
	}
	if commit := msg.GetLatestCommit(); commit != nil {
		n.observeCommit(commit, false, now)
	}
	pk, r := n.currentRound(key, msg.GetBallot())
	if pk != nil {
		if promised := ballotFromProto(msg.GetPromised()); promised.Round > pk.maxRound {
			pk.maxRound = promised.Round
		}
	}
	if r == nil {
		return
	}
	switch msg.GetReason() {
	case pb.LeaseNackReason_LEASE_NACK_REASON_ACCEPTOR_BEHIND, pb.LeaseNackReason_LEASE_NACK_REASON_UNKNOWN_POLICY:
		// The acceptor lags: forward our blocks and ask again (A4).
		n.attachBlocks(from, key.PolicyID)
		if r.proposing {
			delete(r.proposedTo, from)
			n.sendPropose(pk, r, from, now)
		} else {
			prepare := &pb.LeasePrepare{Key: key.proto(), Ballot: r.ballot.proto(), Epoch: r.config.Epoch, ManifestVersion: r.manifest.Version}
			n.queue(from, &pb.LeaseItem{Body: &pb.LeaseItem_Prepare{Prepare: prepare}})
		}
		return
	case pb.LeaseNackReason_LEASE_NACK_REASON_BALLOT_TOO_LOW, pb.LeaseNackReason_LEASE_NACK_REASON_RELEASED,
		pb.LeaseNackReason_LEASE_NACK_REASON_STALE_EPOCH, pb.LeaseNackReason_LEASE_NACK_REASON_STALE_MANIFEST:
		r.higher = true
	case pb.LeaseNackReason_LEASE_NACK_REASON_HELD, pb.LeaseNackReason_LEASE_NACK_REASON_RESERVED:
		if msg.GetHolderId() != n.id {
			r.sawOther = true
		}
	}
	if r.config.isVoter(from) {
		r.refused[from] = true
	}
	if r.config.quorumImpossible(r.refused) || (r.manifest.Available && r.sawOther && pk.role != RoleHolding) {
		n.finishRound(pk, now)
	}
}
