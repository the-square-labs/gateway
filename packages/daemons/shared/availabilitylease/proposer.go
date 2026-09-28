package availabilitylease

import (
	"sort"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

type observation struct {
	state       pb.LeaseKeyState
	holder      string
	reservedFor string
	at          time.Duration
}

// proposerKey is the candidate/holder state of one key on this node.
type proposerKey struct {
	key   Key
	role  Role
	round *round
	// settled is the last round that reached its quorum; members whose
	// promise arrives before its deadline still get the propose.
	settled *round

	ballot        Ballot // last committed ballot of this node
	ownMajority   bool
	lastIssued    Ballot
	maxRound      uint64
	anchor        time.Duration
	deadline      time.Duration
	softAt        time.Duration
	lastProposeAt time.Duration
	retry         bool
	nextRoundAt   time.Duration
	fenceReason   FenceReason

	// commit is the highest valid commit seen for the key, any holder.
	commit          *pb.LeaseCommit
	commitBallot    Ballot
	freshCommitAt   time.Duration
	hasFreshCommit  bool
	obs             map[string]observation
	expiredSeen     bool
	expiredSince    time.Duration
	nextQueryAt     time.Duration
	designatedUntil time.Duration
	designated      bool
	bootstrapDone   uint64
	recoverUntil    time.Duration

	release releaseState
}

func (n *Node) proposerFor(key Key) *proposerKey {
	pk := n.proposers[key]
	if pk == nil {
		pk = &proposerKey{key: key, obs: map[string]observation{}}
		n.proposers[key] = pk
	}
	return pk
}

func (pk *proposerKey) holdsLease() bool {
	return pk.role == RoleHolding || pk.role == RoleRecovering
}

// tickProposers advances every candidate key. Renewals of all held keys start
// on one node-wide schedule so they share frames (per-holder batching).
func (n *Node) tickProposers(now time.Duration) {
	renewDue := now >= n.renewAt
	if renewDue {
		n.renewAt = now + RenewInterval
	}
	keys := make(map[Key]bool, len(n.proposers))
	for key := range n.proposers {
		keys[key] = true
	}
	for _, policyID := range sortedKeys(n.manifests) {
		manifest := n.manifests[policyID]
		if !manifest.isCandidate(n.id) {
			continue
		}
		for slot := uint32(0); slot < manifest.Slots; slot++ {
			keys[Key{PolicyID: policyID, Slot: slot}] = true
		}
	}
	for _, key := range sortKeys(keys) {
		n.tickKey(n.proposerFor(key), now, renewDue)
	}
}

func sortKeys(set map[Key]bool) []Key {
	keys := make([]Key, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].PolicyID != keys[j].PolicyID {
			return keys[i].PolicyID < keys[j].PolicyID
		}
		return keys[i].Slot < keys[j].Slot
	})
	return keys
}

func (n *Node) tickKey(pk *proposerKey, now time.Duration, renewDue bool) {
	manifest := n.manifests[pk.key.PolicyID]
	slotGone := manifest == nil || pk.key.Slot >= manifest.Slots
	if slotGone && pk.round != nil {
		// The adopted manifest removed the slot: originate nothing more for
		// it. A holder's release is driven by the daemon (A6); without it the
		// timer fence still applies.
		pk.round = nil
		if pk.role == RoleAcquiring || pk.role == RoleBootstrapping {
			pk.role = RoleNone
		}
	}
	if pk.round != nil {
		n.tickRound(pk, now)
	}
	switch pk.role {
	case RoleHolding:
		if manifest != nil && manifest.Available {
			pk.deadline, pk.softAt = now+FenceCompleteAfter, now+FenceCompleteAfter
		} else if now >= pk.softAt {
			n.fence(pk, FenceTimer, now)
			return
		}
	case RoleRecovering:
		if manifest != nil && manifest.Available {
			pk.deadline = now + FenceCompleteAfter
		}
		if now >= pk.softAt {
			n.fence(pk, FenceRecovery, now)
			return
		}
		if now < pk.recoverUntil {
			return
		}
		if pk.commit != nil && pk.commitBallot.Proposer != n.id && pk.ballot.Less(pk.commitBallot) {
			n.fence(pk, FenceOtherHolder, now)
			return
		}
	case RoleReleasing:
		n.tickRelease(pk, now)
		return
	case RoleFencing, RoleAbandoned:
		return
	case RoleNone, RoleCandidate:
		n.tickCandidate(pk, manifest, now)
		return
	}
	retryDue := (pk.retry || pk.role == RoleRecovering) && now >= pk.nextRoundAt
	if pk.holdsLease() && pk.round == nil && !slotGone && (renewDue || retryDue) {
		if !manifest.isCandidate(n.id) {
			n.fence(pk, FenceRemoved, now)
			return
		}
		n.startRound(pk, manifest, pk.role, now)
	}
}

func (n *Node) tickCandidate(pk *proposerKey, manifest *Manifest, now time.Duration) {
	if manifest == nil || manifest.Closed || !manifest.isCandidate(n.id) || !n.ready[manifest.PolicyID] || pk.key.Slot >= manifest.Slots {
		pk.role = RoleNone
		return
	}
	pk.role = RoleCandidate
	if pk.round != nil || now < pk.nextRoundAt {
		return
	}
	reserved := false
	if holder, ok := manifest.Bootstrap[pk.key.Slot]; ok && pk.bootstrapDone != manifest.BootstrapID &&
		!(pk.commit != nil && pk.commitBallot.Proposer == holder) {
		if holder == n.id {
			n.startRound(pk, manifest, RoleBootstrapping, now)
			return
		}
		// The named holder may have missed the manifest while the Gateway
		// is gone; hand it over so it can acquire (A5). Keep observing to
		// learn its commit, which lifts the reservation.
		n.forwardOnce(holder, manifest.PolicyID)
		reserved = true
	}
	if pk.designated && now < pk.designatedUntil && !reserved {
		n.startRound(pk, manifest, RoleAcquiring, now)
		return
	}
	pk.designated = false
	if n.holdsOtherSlot(pk.key) {
		return
	}
	if pk.hasFreshCommit && pk.commitBallot.Proposer != n.id && now-pk.freshCommitAt < commitQuietPeriod {
		pk.expiredSeen = false
		return
	}
	if now >= pk.nextQueryAt {
		n.sendQuery(pk.key)
		pk.nextQueryAt = now + queryInterval
	}
	if reserved || !n.expiredOnQuorum(pk, manifest, now) {
		pk.expiredSeen = false
		return
	}
	if !pk.expiredSeen {
		pk.expiredSeen, pk.expiredSince = true, now
	}
	if now >= pk.expiredSince+time.Duration(n.rank(pk, manifest))*RankStep {
		n.startRound(pk, manifest, RoleAcquiring, now)
	}
}

func (n *Node) sendQuery(key Key) {
	config := n.policyConfig(key.PolicyID)
	if config == nil {
		return
	}
	for _, id := range config.memberIDs {
		n.forwardOnce(id, key.PolicyID)
		n.queue(id, &pb.LeaseItem{Body: &pb.LeaseItem_Query{Query: &pb.LeaseQuery{Keys: []*pb.LeaseKey{key.proto()}}}})
	}
}

// holdsOtherSlot keeps one replica per node: it is true while this node
// holds, acquires or fences another slot of the policy, or is the named
// bootstrap holder of another slot (its legacy copy runs there).
func (n *Node) holdsOtherSlot(key Key) bool {
	if manifest := n.manifests[key.PolicyID]; manifest != nil {
		for slot, holder := range manifest.Bootstrap {
			if slot != key.Slot && holder == n.id {
				if pk := n.proposers[Key{PolicyID: key.PolicyID, Slot: slot}]; pk == nil || pk.bootstrapDone != manifest.BootstrapID {
					return true
				}
			}
		}
	}
	for other, pk := range n.proposers {
		if other.PolicyID == key.PolicyID && other.Slot != key.Slot {
			switch pk.role {
			case RoleCandidate, RoleNone:
			default:
				return true
			}
		}
	}
	return false
}

// expiredOnQuorum decides whether the key looks free: a fresh FREE (or
// reserved-for-us) observation from a majority of every quorum set; in
// available mode every fresh observation is free and a voting relay answered.
func (n *Node) expiredOnQuorum(pk *proposerKey, manifest *Manifest, now time.Duration) bool {
	config := manifest.Voters
	if config == nil {
		return false
	}
	free := map[string]bool{}
	fresh, relay := 0, false
	for _, id := range sortedKeys(pk.obs) {
		obs := pk.obs[id]
		if now-obs.at > observationMaxAge || !config.isVoter(id) {
			continue
		}
		fresh++
		// Our own leftover lease counts as free for us: acceptors accept
		// the same proposer again.
		ok := obs.state == pb.LeaseKeyState_LEASE_KEY_STATE_FREE ||
			(obs.state == pb.LeaseKeyState_LEASE_KEY_STATE_RESERVED && obs.reservedFor == n.id) ||
			(obs.state == pb.LeaseKeyState_LEASE_KEY_STATE_HELD && obs.holder == n.id)
		if ok {
			free[id] = true
			relay = relay || config.isRelay(id)
		}
	}
	if config.quorum(free) {
		return true
	}
	return manifest.Available && relay && len(free) == fresh
}

// rank is the manifest rank among candidates (D5), skipping holders of the
// policy's other slots, which never compete for this one.
func (n *Node) rank(pk *proposerKey, manifest *Manifest) int {
	skip := map[string]bool{}
	for key, other := range n.proposers {
		if key.PolicyID == pk.key.PolicyID && key.Slot != pk.key.Slot && other.commit != nil && other.hasFreshCommit {
			skip[other.commitBallot.Proposer] = true
		}
	}
	rank := 0
	for _, id := range manifest.Candidates {
		if id == n.id {
			break
		}
		if !skip[id] {
			rank++
		}
	}
	return rank
}

func (n *Node) onStatus(from string, msg *pb.LeaseStatus, now time.Duration) {
	key, ok := keyFromProto(msg.GetKey())
	pk := n.proposers[key]
	if !ok || pk == nil {
		return
	}
	if manifest := n.manifests[key.PolicyID]; manifest != nil &&
		(msg.GetEpoch() < manifest.Epoch || msg.GetManifestVersion() < manifest.Version) {
		n.attachBlocks(from, key.PolicyID)
	}
	if msg.GetState() == pb.LeaseKeyState_LEASE_KEY_STATE_UNSPECIFIED {
		return
	}
	if msg.GetLatestCommit() != nil {
		n.observeCommit(msg.GetLatestCommit(), false, now)
	}
	// Commits are self-certifying: hand a newer one to a lagging acceptor,
	// for example one that lost its state and re-reserved a bootstrap key
	// whose holder already acquired (A5, A13).
	if pk.commit != nil && ballotFromProto(msg.GetLatestCommit().GetBallot()).Less(pk.commitBallot) {
		n.queue(from, &pb.LeaseItem{Body: &pb.LeaseItem_Commit{Commit: pk.commit}})
	}
	if promised := ballotFromProto(msg.GetPromised()); promised.Round > pk.maxRound {
		pk.maxRound = promised.Round
	}
	pk.obs[from] = observation{state: msg.GetState(), holder: msg.GetHolderId(), reservedFor: msg.GetReservedFor(), at: now}
}

// observeCommit learns a verified commit. A holder fences immediately only on
// a commit for another holder that beats its own (A13), never on a bare
// higher ballot.
func (n *Node) observeCommit(commit *pb.LeaseCommit, direct bool, now time.Duration) {
	key, ok := keyFromProto(commit.GetKey())
	manifest := n.manifests[key.PolicyID]
	pk := n.proposers[key]
	if !ok || manifest == nil || pk == nil {
		return
	}
	ballot := ballotFromProto(commit.GetBallot())
	if ballot.Round > pk.maxRound {
		pk.maxRound = ballot.Round
	}
	if pk.commit != nil && !pk.commitBallot.Less(ballot) {
		return
	}
	majority, err := n.commitQuorum(commit, manifest)
	if err != nil {
		return
	}
	pk.commit, pk.commitBallot = commit, ballot
	if direct {
		pk.freshCommitAt, pk.hasFreshCommit = now, true
	}
	if ballot.Proposer == n.id {
		if pk.ballot.Less(ballot) && pk.role == RoleRecovering {
			pk.ballot, pk.ownMajority = ballot, majority
		}
		return
	}
	if bootstrapSatisfiedBy(manifest, key, commit) {
		pk.bootstrapDone = manifest.BootstrapID
	}
	switch pk.role {
	case RoleHolding:
		if n.beats(pk, manifest, ballot, majority) {
			n.fence(pk, FenceOtherHolder, now)
		}
	case RoleRecovering:
		if now >= pk.recoverUntil && pk.ballot.Less(ballot) {
			n.fence(pk, FenceOtherHolder, now)
		}
	case RoleAcquiring, RoleBootstrapping:
		if pk.round != nil && pk.round.ballot.Less(ballot) {
			n.finishRound(pk, now)
		}
	}
}

// beats reports whether another holder's commit wins over this holder's.
// Strict: any higher committed ballot (it can only exist if our lease is
// gone). Available: a majority certificate beats a minority one; between
// minority certificates the better manifest rank wins, so both sides of a
// healed partition agree on one survivor (A7, I4).
func (n *Node) beats(pk *proposerKey, manifest *Manifest, ballot Ballot, majority bool) bool {
	if !manifest.Available {
		return pk.ballot.Less(ballot)
	}
	if majority != pk.ownMajority {
		return majority
	}
	if majority {
		return pk.ballot.Less(ballot)
	}
	other, ok := manifest.rank[ballot.Proposer]
	return ok && other < manifest.rank[n.id]
}

func (n *Node) fence(pk *proposerKey, reason FenceReason, now time.Duration) {
	switch pk.role {
	case RoleHolding, RoleRecovering:
	default:
		return
	}
	pk.round = nil
	pk.role = RoleFencing
	pk.fenceReason = reason
	n.emit(Event{Kind: EventFence, Key: pk.key, Ballot: pk.ballot, Reason: reason, At: now})
}

// onManifestChanged fences on a lease-closed manifest (A5, A13). On a switch
// from available to strict a holder keeps only a strict lease: one backed
// by a majority certificate, timed from its send time (A7).
func (n *Node) onManifestChanged(previous, manifest *Manifest, now time.Duration) {
	toStrict := previous != nil && previous.Available && !manifest.Available
	for key, pk := range n.proposers {
		if key.PolicyID != manifest.PolicyID {
			continue
		}
		if manifest.Closed {
			n.fence(pk, FenceClosed, now)
			if pk.round != nil {
				pk.round = nil
				if pk.role == RoleAcquiring || pk.role == RoleBootstrapping {
					pk.role = RoleNone
				}
			}
			continue
		}
		if toStrict && pk.holdsLease() {
			if !pk.ownMajority {
				n.fence(pk, FenceTimer, now)
				continue
			}
			pk.deadline, pk.softAt = pk.anchor+FenceCompleteAfter, pk.anchor+SoftFenceAfter
		}
	}
}

func (n *Node) onDesignated(key Key, now time.Duration) {
	pk := n.proposers[key]
	if pk == nil {
		pk = n.proposerFor(key)
	}
	pk.designated, pk.designatedUntil = true, now+SuccessorWindow
	pk.nextRoundAt = now
}

func (n *Node) nextWakeup(now time.Duration) time.Duration {
	next := now + queryInterval
	consider := func(at time.Duration) {
		if at > now && at < next {
			next = at
		}
	}
	consider(n.renewAt)
	for _, pk := range n.proposers {
		if r := pk.round; r != nil {
			consider(r.deadline)
			consider(r.anchor + availableCollect)
			consider(r.proposeAt + availableCollect)
		}
		consider(pk.nextRoundAt)
		consider(pk.nextQueryAt)
		consider(pk.softAt)
		consider(pk.recoverUntil)
		consider(pk.release.nextAt)
		consider(pk.designatedUntil)
		if manifest := n.manifests[pk.key.PolicyID]; pk.expiredSeen && manifest != nil {
			consider(pk.expiredSince + time.Duration(n.rank(pk, manifest))*RankStep)
		}
	}
	if next <= now {
		next = now + time.Millisecond
	}
	return next
}
