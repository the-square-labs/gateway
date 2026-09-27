// Package availabilitylease is the data-plane lease protocol for Docker
// Availability failover: a PaxosLease variant in which relays and a bounded
// set of daemons are acceptors and candidate docker daemons are proposers.
// The Gateway only publishes signed manifests; it never decides failover.
//
// The package is pure protocol logic. It performs no I/O of its own: time
// comes from a Clock, durability from a Store, frames leave through a
// Transport, and identity signatures come from a Signer. Everything is
// deterministic given those inputs, which is what the seeded simulator in
// the tests relies on.
//
// # Keys, ballots, roles
//
// A lease key is (policyId, slot): failover policies use slot 0, replicated
// policies slots 0..desiredReplicaCount-1 (D1). A ballot is (round,
// incarnation, proposer id), ordered in that order; the incarnation is
// persisted and bumped on every start (A3). Every acquisition and every
// renewal is a fresh prepare/propose round with a new ballot (A11).
//
// One Node per process plays every role it is configured for:
//   - acceptor, when the node is a member of the voter config. Members in a
//     quorum set vote; other members (non-voting relays) and voters inside
//     their restart abstention only record shadow promises and accepts;
//   - proposer, for every policy whose manifest lists the node as a
//     candidate and that the daemon marked ready;
//   - relay gate evaluator (Gate), on relays.
//
// # Timing (D5, A1, A3, A11)
//
//	LeaseTerm          T = 30 s
//	AcceptorHold       T x 1.1 = 33 s: an acceptor refuses other proposers
//	                   until 33 s after its last accept of the holder
//	AbstainAfterStart  33 s: no votes after process start or fresh state
//	RenewInterval      5 s, one schedule per node so renewals of all keys
//	                   share frames
//	SoftFenceAfter     15 s after the send time of the last successful round
//	FenceCompleteAfter 24 s: the container must be dead (watchdog deadline)
//	RankStep           2 s per manifest rank before a takeover
//	SuccessorWindow    10 s during which only the designated successor may
//	                   acquire after a release
//	GateWindow         24 s: a relay admits the holder for at most this long
//	                   after its own promise of the committed ballot
//
// A 10% slow holder is dead 26.7 real seconds after the send time of its
// last successful round; a 10% fast acceptor refuses others for 30 real
// seconds after an accept that happened after that send. A 10% slow relay
// closes its gate 26.7 s after its promise, which precedes the propose and
// therefore every accept of the ballot (see Gate below).
//
// # Wiring
//
//	node, err := availabilitylease.NewNode(availabilitylease.Config{
//		ID:        identityID,               // voter/candidate id in manifests
//		Clock:     availabilitylease.SystemClock(), // CLOCK_BOOTTIME on Linux
//		Store:     store,                    // durable, fsync before return
//		Transport: transport,                // sends *relayv1.CoordinationFrame
//		Signer:    availabilitylease.ECDSASigner{Key: tlsIdentityKey},
//		IncarnationFloor: uint64(time.Now().UnixMilli()),
//	})
//
// Store.Apply must be atomic and durable: promised ballots are written
// through it before any reply leaves (A3). A failed write drops the replies
// and restarts the abstention window. The relay backs Store with a relay.db
// bucket; daemons with a file in their state directory. Pass the wall clock
// as IncarnationFloor so incarnations keep increasing when the store is lost
// (relay.db renamed): peers drop frames from lower incarnations (A9).
//
// Trust and blocks. Call TrustPolicyKey with the Gateway policy signing key
// received over an authenticated channel (daemon CommandStream; relay
// verified policy envelope), AdoptKeyRotation for rotation links, and
// AdoptVoterConfig / AdoptManifest for signed blocks. They return true once
// the block is durably adopted: that is the "persisted ack" the Gateway
// waits for (A4). Nodes also adopt newer blocks and rotation links that
// arrive inside frames, and forward theirs to lagging peers on first
// contact, on NACKs and on lag reports, so failover never waits for the
// Gateway (A4, A14).
//
// Driving. Hand every frame addressed to this node to ReceiveFrame; it
// verifies the ECDSA signature against the sender's key from the voter
// config or the manifest candidates. ErrUnknownSender means the node lacks
// the blocks that name the sender; it answers with a lag report. Call Tick
// at NextWakeup (a local clock value) or at least every 250 ms.
//
// # Docker daemon (T4)
//
//   - SetCandidateReady(policy, ready): ready only while the standby is
//     prepared and the watchdog heartbeat is fresh (A12.4). A node acquires
//     keys by rank on its own; one slot per node in replicated mode.
//   - HolderStatus(key) is the whole contract for the container:
//     MayStart: start or restart the container only while true (A2.1, A5);
//     Deadline: write the watchdog record (container id, cgroup, Deadline)
//     after create and before every start, and on every change (A12.1);
//     FenceNow/SoftFenceAt: stop the container now (docker stop with
//     min(stop timeout, 10 s), then kill); the watchdog kills the cgroup at
//     Deadline regardless.
//   - FenceComplete(key) once the cgroup is confirmed empty. After a timer
//     or recovery fence the node then releases the key for its successors.
//   - Release(key, successor) for a planned handoff or a health release
//     (D6, D9), only after the cgroup is empty and the endpoint is
//     deregistered (A6). The node relinquishes every relay gate first and
//     releases the acceptors only when all relays acked or RelinquishWait
//     passed. If the stop does not complete, call Abandon(key) instead: the
//     node stops renewing and the watchdog fences.
//   - Recover(key, deadline) on daemon start for every lease-mode container
//     found running, with the watchdog record's deadline (A2.3). The node
//     renews if it still can, else FenceNow turns true.
//   - LeaseMode(policy): while true refuse every backend start or serve
//     command for the policy's placements unless HolderStatus.MayStart (A5).
//   - ObserveSuspend(d) when the host resumes from a suspend or RAM snapshot
//     that the monotonic clock did not see (wall clock jumped by d). It moves
//     deadlines and gate anchors back by d so the resumed holder fences at
//     once instead of running on its frozen budget.
//   - DrainEvents: acquired, fence, released and handoff transitions for
//     lease reports in the heartbeat and audit events (D9). Holders lists
//     current holder statuses.
//
// # Relay (T2)
//
// A relay routes CoordinationFrame by destination_id to the stream of that
// identity; frames addressed to the relay itself go to ReceiveFrame. The
// relay's Node is an acceptor (voting or shadow) and evaluates Gate(key) for
// Secure Link endpoint registrations, tunnels and managed-DB tunnels
// (A2.4, A8, A11):
//
//   - LeaseMode false: no lease manifest for the policy, or it is lease
//     closed. Apply the legacy admission rules.
//   - Open with Holder and Ballot: admit that holder's placement only; cut
//     every other registration or tunnel for the key immediately.
//   - Closed with a reason: admit nobody for the key.
//
// The gate opens only for the holder of the highest valid commit whose
// ballot this relay itself accepted (or shadow-accepted) with an echo of its
// own promise, while nothing supersedes it, and for at most GateWindow of
// local time after that promise. Re-evaluate on every registration and
// tunnel and at least every second; Until says when it closes. AcceptorView
// feeds GetHealth. Only relays of operator-owned pools may be voters (A9);
// that is enforced by the Gateway when it builds the voter config.
//
// # nginx daemon (T5)
//
// An nginx daemon runs a Node like any other member. When the voter config
// lists it in a quorum set it votes; otherwise it only observes. Socket state
// comes from the relay gate views it learns, each with a TTL of at most T.
//
// # Gateway obligations (T3, T6)
//
//   - Sign manifests and voter configs with the relay policy key (Ed25519)
//     over "gateway-availability-lease/manifest/v1" 0x00 || payload and
//     "gateway-availability-lease/voter-config/v1" 0x00 || payload. The
//     domain prefix keeps these signatures apart from policy envelopes,
//     which the same key signs over raw bytes.
//   - Voter config: every relay is a member (role RELAY); relays and daemons
//     in a quorum set vote. An epoch change publishes a joint config (epoch
//     E+1 with quorum sets old and new), then a settled config (epoch E+2,
//     new set only) once a majority of both sets acked E+1, every active
//     lease renewed under E+1, and at least T x 1.1 / 0.9 (37 s) passed
//     since those acks, so no lease that only a majority of the old set
//     holds can remain (D2, A4).
//   - Manifest: candidates in rank order with their identity keys, mode,
//     partition mode, slots, the epoch it was built for, lease_term_ms 0 or
//     30000. Bump manifest_version on every change.
//   - Bootstrap (A5): name the serving placement per slot with a new
//     bootstrap_id and keep the entry in every version until that holder
//     reported acquiring. Also the way to switch available to strict (A7):
//     strict counts as active only once every other copy stopped and
//     GateWindow passed.
//   - Lease closed (A5): publish closed=true; stay non-reactive until the
//     holder acks the close, or a majority of acceptors acked it and
//     T x 1.1 plus the fence margin passed.
//   - Key rotation (A14): publish the link signed by the previous key, sign
//     with the new key only after a majority of voters trust it
//     (TrustsPolicyKey), then re-sign the current config and manifests with
//     the new key (same payload) so peers that only trust the new key can
//     verify forwarded blocks.
//
// # Frames and proto mapping (proto/relay/v1)
//
// CoordinationFrame{destination_id, sender_id, payload, signature} carries
// one LeaseBatch per destination. signature is ECDSA P-256 (ASN.1) by the
// sender's identity key over SHA-256("gateway-availability-lease/frame/v1"
// 0x00 || payload). LeaseBatch repeats sender, incarnation and destination
// inside the signed payload, has a message id for deduplication, and may
// carry LeaseSignedBlock and LeasePolicyKeyRotation entries. Items:
//
//	prepare      proposer -> every member      phase 1, (epoch, manifest version)
//	promise      acceptor -> proposer          echo nonce; shadow when not voting
//	propose      proposer -> each promiser     phase 2, echoes that promise
//	accepted     acceptor -> proposer          signed accept statement
//	nack         acceptor -> proposer          reason, promised ballot,
//	                                           holder, latest commit (A13)
//	commit       holder   -> members and       QC: accepts of a majority of
//	                         candidates        every quorum set (A11)
//	release      holder   -> relays (RELINQUISH), then members and
//	                         successor (FINAL), bound to the ballot (A6, D9)
//	release_ack  member   -> holder
//	query        candidate -> members          status probe
//	status       member   -> candidate         FREE/HELD/RESERVED/ABSTAINING/
//	                                           CLOSED, latest commit; an
//	                                           empty status reports lag
//
// The accept statement signed by acceptors is
//
//	"gateway-availability-lease/accept/v1" 0x00
//	str(policy_id) u64(slot) u64(round) u64(incarnation) str(proposer_id)
//	u64(epoch) u64(manifest_version) str(acceptor_id) u64(acceptor_incarnation)
//
// with str = 4-byte big-endian length then bytes and u64 = 8-byte big
// endian. A rotation link is signed by the previous key over
// "gateway-availability-lease/key-rotation/v1" 0x00 || str(key_id) ||
// public_key.
//
// # Invariants and residuals
//
// The simulator checks at every simulated event: I1, strict mode never runs
// two live containers for a key; I2, all relay gates together admit at most
// one holder; I3, a successor commits within 45 s of a holder's death when a
// voter majority is reachable; I4, available mode converges to one copy
// after a partition heals. Residual (A2.5): a VM whose clock froze may run
// its container after resuming until its first renewal round trip, or until
// its frozen budget ends when it reaches no acceptor; relays refuse its
// traffic throughout. ObserveSuspend shrinks this further when the daemon
// can detect the suspend.
package availabilitylease
