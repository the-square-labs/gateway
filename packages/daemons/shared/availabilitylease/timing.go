package availabilitylease

import "time"

// Timing constants decided in D5 and amended by A1, A3, A11 and D9. They are
// fixed: a manifest may only restate LeaseTerm (lease_term_ms = 30000).
const (
	// LeaseTerm is the acceptor lease T.
	LeaseTerm = 30 * time.Second
	// AcceptorHold is how long an acceptor refuses other proposers after its
	// last accept of the current holder (T × 1.1).
	AcceptorHold = LeaseTerm * 11 / 10
	// AbstainAfterStart is how long an acceptor's votes do not count after
	// its state was created fresh, came from another boot, or a write failed
	// (A3). A restart within the same boot keeps voting: the store proves it
	// (boot stamp) and the hold of every key's last counted accept, persisted
	// with its clock reading, is restored exactly (restoreHolds).
	AbstainAfterStart = AcceptorHold
	// RecoverStopReserve is how long before its recorded deadline a holder
	// recovering an unconfirmed container after a daemon restart gives up
	// renewing and kills it (A2.3): a restart that takes most of the budget
	// still keeps the slot when a round succeeds in time.
	RecoverStopReserve = 2 * time.Second
	// RenewInterval is the holder's renewal cadence, batched per holder node.
	RenewInterval = 5 * time.Second
	// SoftFenceAfter starts the holder's self-fence (graceful stop) when no
	// renewal sent in the last SoftFenceAfter reached a quorum.
	SoftFenceAfter = 15 * time.Second
	// FenceCompleteAfter is the local deadline, counted from the send time of
	// the last successful round, by which the container must be dead (A1).
	FenceCompleteAfter = 24 * time.Second
	// RankStep is the takeover delay per manifest rank (D5).
	RankStep = 2 * time.Second
	// SuccessorWindow is how long acceptors accept only the designated
	// successor after a release (D9).
	SuccessorWindow = 10 * time.Second
	// GateWindow bounds how long a relay admits a holder after its own promise
	// of the committed ballot. It must not exceed 0.9 × T so that a relay
	// running 10% slow closes its gate before an acceptor running 10% fast can
	// accept another holder; FenceCompleteAfter satisfies that with margin.
	GateWindow = FenceCompleteAfter
	// RelinquishWait is how long a releasing holder waits, after its last
	// propose, for relays that never acked the relinquish before it sends the
	// final release: GateWindow at a 10% slow relay measured by a 10% fast
	// holder is 29.3 s.
	RelinquishWait = LeaseTerm
	// MaxClockDrift is the clock rate error the timing budget tolerates.
	MaxClockDrift = 0.10
)

// Protocol pacing. These do not affect safety.
const (
	roundTimeout      = 3 * time.Second
	retryBackoff      = time.Second
	queryInterval     = time.Second
	observationMaxAge = 3 * time.Second
	commitQuietPeriod = 7 * time.Second
	availableCollect  = time.Second
	releaseRetry      = time.Second
	releaseAttempts   = 3
	successorRetry    = 300 * time.Millisecond
	recoveryQueryWait = time.Second
)
