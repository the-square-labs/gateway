package relayresume

import (
	"bytes"
	"crypto/sha256"
	"errors"
	"flag"
	"fmt"
	"math/rand/v2"
	"os"
	"strconv"
	"testing"
	"time"
)

// The deterministic simulator: two cores, a virtual clock and relay paths
// that are reliable and ordered each, cut at random points (frames in flight
// lost or delivered late), with planned and unplanned migrations, migrations
// during migrations, MIGRATE_REQ, replayed RESUMEs through the same and other
// relays, FIN in either direction, RST, slow readers, revocation racing a
// resume and a restarted target. Invariants are checked at every step; at the
// end both sides must have the peer's exact bytes or have ended for an
// injected reason.

var simSeeds = flag.Int("sim-seeds", 0, "simulator seeds (default RELAYRESUME_SIM_SEEDS or 1000)")
var simSeedStart = flag.Uint64("sim-seed-start", 1, "first simulator seed")

func simSeedCount() int {
	if *simSeeds > 0 {
		return *simSeeds
	}
	if value, err := strconv.Atoi(os.Getenv("RELAYRESUME_SIM_SEEDS")); err == nil && value > 0 {
		return value
	}
	if testing.Short() {
		return 200
	}
	return 1000
}

type simFrame struct {
	at       time.Time
	data     []byte
	fail     bool // the path ends here for the receiver
	terminal bool
}

type simPath struct {
	id       int
	relay    string
	latency  time.Duration
	jitter   time.Duration
	maxFrame int
	toT, toS []simFrame
	src, tgt *Path  // each side's view; tgt nil until the target saw the first frame
	dead     bool   // no new frames move
	rogue    bool   // opened by a replaying relay, not by the source
	origin   string // rogue: the relay the replayed RESUME was sent through
	sink     bool   // T -> S frames go nowhere (rogue)
	idleKill time.Time
}

type simSide struct {
	name      string
	core      *Core
	data      []byte // what this side writes
	written   int
	closeAt   int // close write after this many bytes (-1: never)
	closed    bool
	got       []byte // what it received
	gotFin    int
	slowUntil time.Time
	maxChunk  int
}

type simWorld struct {
	t         *testing.T
	seed      uint64
	rng       *rand.Rand
	now       time.Time
	start     time.Time
	paths     []*simPath
	src, tgt  simSide
	routeKeys map[string][]byte
	keyID     string
	budget    *WindowBudget
	nonce     [NonceLen]byte

	// Target table: the target's sessions by id (finished or reset ones stay
	// as tombstones), keyed by nonce epoch: a restarted target forgets them.
	targets map[[SessionIDLen]byte]*Core

	authorized    bool
	revokedAt     time.Time
	targetRestart bool

	attemptAt    time.Time // source: next unplanned attempt
	backoff      time.Duration
	openings     []simOpening
	outageUntil  time.Time
	lastResume   []byte // last RESUME frame the source sent (for replays)
	lastResumeID string

	// Injected faults that may end the stream legitimately.
	fatal  []string
	events []string
	steps  int
}

type simOpening struct {
	at      time.Time
	planned bool
	relay   string
}

func newSimWorld(t *testing.T, seed uint64) *simWorld {
	rng := rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15))
	start := time.Unix(1_700_000_000, 0)
	w := &simWorld{t: t, seed: seed, rng: rng, now: start, start: start, authorized: true, targets: map[[SessionIDLen]byte]*Core{}}
	w.budget = NewWindowBudget(int64(MinWindow + rng.IntN(6*MaxWindow)))
	key := make([]byte, KeyLen)
	for i := range key {
		key[i] = byte(rng.Uint32())
	}
	w.keyID = "v1"
	w.routeKeys = map[string][]byte{"v1": key}
	for i := range w.nonce {
		w.nonce[i] = byte(rng.Uint32())
	}
	sizes := []int{0, 1, 100, 4096, 70_000, 300_000, 1_500_000, 6_000_000}
	pick := func() int {
		size := sizes[rng.IntN(len(sizes))]
		if size > 1 {
			size = size/2 + rng.IntN(size)
		}
		return size
	}
	w.src = simSide{name: "source", data: randomBytes(rng, pick())}
	w.tgt = simSide{name: "target", data: randomBytes(rng, pick())}
	for _, side := range []*simSide{&w.src, &w.tgt} {
		side.closeAt = len(side.data)
		side.maxChunk = []int{1, 512, 32 * 1024, 300 * 1024, MaxFrameBytes}[rng.IntN(5)]
		if limit := side.maxChunk * 2000; len(side.data) > limit {
			side.data = side.data[:limit]
			side.closeAt = limit
		}
	}
	return w
}

func randomBytes(rng *rand.Rand, n int) []byte {
	out := make([]byte, n)
	for i := 0; i+8 <= n; i += 8 {
		v := rng.Uint64()
		for j := 0; j < 8; j++ {
			out[i+j] = byte(v >> (8 * j))
		}
	}
	for i := n - n%8; i < n; i++ {
		out[i] = byte(rng.Uint32())
	}
	return out
}

func (w *simWorld) logf(format string, args ...any) {
	if len(w.events) >= 300 {
		w.events = append(w.events[:0], w.events[len(w.events)-150:]...)
	}
	w.events = append(w.events, fmt.Sprintf("%8.3fs ", w.now.Sub(w.start).Seconds())+fmt.Sprintf(format, args...))
}

func (w *simWorld) fail(format string, args ...any) {
	w.t.Helper()
	msg := fmt.Sprintf(format, args...)
	var trace bytes.Buffer
	for _, line := range w.events {
		trace.WriteString(line + "\n")
	}
	w.t.Fatalf("seed %d step %d at %.3fs: %s\nfatal injections: %v\ntrace:\n%s", w.seed, w.steps, w.now.Sub(w.start).Seconds(), msg, w.fatal, trace.String())
}

func (w *simWorld) relayName() string {
	return []string{"relay-a", "relay-b", "relay-c"}[w.rng.IntN(3)]
}

func (w *simWorld) newPath(relay string) *simPath {
	maxFrame := MinPathFrameBytes << w.rng.IntN(13)
	if maxFrame > MaxFrameBytes {
		maxFrame = MaxFrameBytes
	}
	if w.rng.IntN(4) == 0 {
		maxFrame = MinPathFrameBytes + w.rng.IntN(MaxFrameBytes-MinPathFrameBytes)
	}
	p := &simPath{id: len(w.paths), relay: relay, latency: time.Duration(w.rng.IntN(30_000)) * time.Microsecond,
		jitter: time.Duration(w.rng.IntN(5_000)) * time.Microsecond, maxFrame: maxFrame}
	w.paths = append(w.paths, p)
	return p
}

func (w *simWorld) arrival(p *simPath, queue []simFrame) time.Time {
	at := w.now.Add(p.latency + time.Duration(w.rng.Int64N(int64(p.jitter)+1)))
	if n := len(queue); n > 0 && queue[n-1].at.After(at) {
		at = queue[n-1].at // per path order
	}
	return at
}

// flush moves a core's outputs onto the paths.
func (w *simWorld) flush(side *simSide) {
	for _, out := range side.core.TakeOutputs() {
		p := w.findPath(out.Path)
		if p == nil {
			w.fail("%s output on an unknown path", side.name)
		}
		if out.Close {
			w.logf("%s closes path %d", side.name, p.id)
			w.cut(p, side == &w.src, side == &w.tgt, false)
			continue
		}
		if p.dead {
			continue // a send into a broken stream: the fail marker reaches the sender
		}
		if len(out.Frame) == 0 || len(out.Frame) > p.maxFrame || len(out.Frame) > MaxFrameBytes {
			w.fail("%s sent a frame of %d bytes on a path allowing %d", side.name, len(out.Frame), p.maxFrame)
		}
		frame := simFrame{data: out.Frame}
		if side == &w.src {
			if out.Frame[0] == TypeResume {
				w.lastResume, w.lastResumeID = append([]byte(nil), out.Frame...), p.relay
			}
			frame.at = w.arrival(p, p.toT)
			p.toT = append(p.toT, frame)
		} else {
			if p.sink {
				continue
			}
			frame.at = w.arrival(p, p.toS)
			p.toS = append(p.toS, frame)
		}
	}
}

func (w *simWorld) findPath(path *Path) *simPath {
	for _, p := range w.paths {
		if p.src == path || p.tgt == path {
			return p
		}
	}
	return nil
}

// cut breaks a path: each direction keeps a random prefix of its frames in
// flight, then the receiver learns the stream ended. byS / byT: that side
// closed it (it needs no notice).
func (w *simWorld) cut(p *simPath, byS, byT, terminal bool) {
	if p.dead {
		return
	}
	p.dead = true
	keep := func(queue []simFrame, notify bool) []simFrame {
		n := 0
		if len(queue) > 0 {
			n = w.rng.IntN(len(queue) + 1)
		}
		queue = queue[:n]
		if notify {
			at := w.now.Add(time.Duration(w.rng.IntN(50_000)) * time.Microsecond)
			if len(queue) > 0 && queue[len(queue)-1].at.After(at) {
				at = queue[len(queue)-1].at
			}
			queue = append(queue, simFrame{at: at, fail: true, terminal: terminal})
		}
		return queue
	}
	p.toT = keep(p.toT, !byT)
	p.toS = keep(p.toS, !byS)
}

func (w *simWorld) run() {
	// The first path and HELLO.
	first := w.newPath(w.relayName())
	first.src = NewPath(first, first.relay, first.maxFrame)
	var sid [SessionIDLen]byte
	for i := range sid {
		sid[i] = byte(w.rng.Uint32())
	}
	halfClose := time.Duration(0)
	if w.rng.IntN(4) == 0 {
		halfClose = ProxyHalfCloseTimeout
	}
	w.src.core = NewSource(Config{RouteID: "route-1", KeyID: w.keyID, Key: w.routeKeys[w.keyID], SessionID: sid, Budget: w.budget,
		HalfCloseTimeout: halfClose, Window: []int{0, MinWindow, MaxWindow}[w.rng.IntN(3)]}, first.src, w.now)
	w.flush(&w.src)

	// Fault plan.
	cutRate := []float64{0, 0.0005, 0.003, 0.02}[w.rng.IntN(4)]
	plannedRate := []float64{0, 0.001, 0.01}[w.rng.IntN(3)]
	replayRate := []float64{0, 0.002}[w.rng.IntN(2)]
	if w.rng.IntN(20) == 0 {
		w.revokedAt = w.now.Add(time.Duration(w.rng.IntN(3000)) * time.Millisecond)
	}
	if w.rng.IntN(25) == 0 {
		w.targetRestart = true
	}
	if w.rng.IntN(10) == 0 {
		w.outageUntil = w.now.Add(time.Duration(w.rng.IntN(70_000)) * time.Millisecond)
		if w.outageUntil.Sub(w.now) > UnplannedBudget-5*time.Second {
			w.fatal = append(w.fatal, "long outage")
		}
	}
	abortAt := time.Time{}
	if w.rng.IntN(30) == 0 {
		abortAt = w.now.Add(time.Duration(w.rng.IntN(2000)) * time.Millisecond)
	}
	idleKillRate := 0.0
	if w.rng.IntN(40) == 0 {
		idleKillRate = 0.001
	}
	limit := w.now.Add(15 * time.Minute)

	for w.steps = 0; ; w.steps++ {
		if w.now.After(limit) {
			w.fail("no progress: source %s, target %v\n%s", w.src.core.State(), w.tgtState(), w.dump())
		}
		if w.src.core.State().Terminal() && (w.tgt.core == nil || w.tgt.core.State().Terminal()) && w.quiet() {
			break
		}
		w.now = w.now.Add(time.Duration(w.rng.IntN(3000)) * time.Microsecond)

		// Faults.
		if !w.revokedAt.IsZero() && !w.now.Before(w.revokedAt) && w.authorized {
			w.authorized = false
			w.fatal = append(w.fatal, "revoked")
			w.logf("route revoked")
			if w.tgt.core != nil && w.rng.IntN(2) == 0 {
				// The daemon's bundle check ends the session too.
				w.tgt.core.Abort(RstRevoked, "revoked", ErrRevoked)
				w.flush(&w.tgt)
			}
		}
		if !abortAt.IsZero() && !w.now.Before(abortAt) {
			abortAt = time.Time{}
			side := &w.src
			if w.tgt.core != nil && w.rng.IntN(2) == 0 {
				side = &w.tgt
			}
			w.fatal = append(w.fatal, side.name+" aborted")
			w.logf("%s aborts", side.name)
			side.core.Abort(RstLocal, "local socket failed", nil)
			w.flush(side)
		}
		for _, p := range w.paths {
			if p.dead {
				continue
			}
			if w.rng.Float64() < cutRate {
				w.logf("cut path %d (%s)", p.id, p.relay)
				w.cut(p, false, false, false)
			} else if w.rng.Float64() < idleKillRate {
				w.logf("relay idle timeout on path %d", p.id)
				w.fatal = append(w.fatal, "idle timeout")
				w.cut(p, false, false, true)
			}
		}
		if w.targetRestart && w.tgt.core != nil && w.rng.Float64() < 0.002 {
			// A restarted target forgets its sessions and its nonce; its
			// paths die with it.
			w.targetRestart = false
			w.fatal = append(w.fatal, "target restart")
			w.logf("target restarts")
			for _, p := range w.paths {
				w.cut(p, false, true, false)
			}
			w.tgt.core.Abort(RstAborted, "restart", nil)
			w.tgt.core.TakeOutputs()
			w.targets = map[[SessionIDLen]byte]*Core{}
			for i := range w.nonce {
				w.nonce[i] = byte(w.rng.Uint32())
			}
		}
		if replayRate > 0 && w.lastResume != nil && w.rng.Float64() < replayRate {
			relay := w.lastResumeID
			if w.rng.IntN(2) == 0 {
				relay = w.relayName()
			}
			p := w.newPath(relay)
			p.rogue, p.sink, p.origin = true, true, w.lastResumeID
			p.toT = append(p.toT, simFrame{at: w.now.Add(p.latency), data: append([]byte(nil), w.lastResume...)})
			p.idleKill = w.now.Add(time.Duration(w.rng.IntN(5000)) * time.Millisecond)
			w.logf("relay %s replays RESUME on path %d", relay, p.id)
		}
		for _, p := range w.paths {
			if p.rogue && !p.dead && !p.idleKill.IsZero() && w.now.After(p.idleKill) {
				w.cut(p, true, false, false)
			}
		}

		// Migration controller (source).
		s := w.src.core
		if reason, ok := s.TakeMigrateRequest(); ok {
			w.logf("source got MIGRATE_REQ %d", reason)
			w.plan(true)
		}
		if plannedRate > 0 && w.rng.Float64() < plannedRate {
			w.plan(true)
		}
		if w.tgt.core != nil && w.rng.Float64() < plannedRate/4 {
			w.tgt.core.RequestMigrate(MigrateDrain)
			w.flush(&w.tgt)
		}
		if s.NeedsPath() && len(w.openings) == 0 {
			if w.attemptAt.IsZero() {
				w.attemptAt, w.backoff = w.now, UnplannedBackoffMin
			}
			if !w.now.Before(w.attemptAt) {
				if w.now.Before(w.outageUntil) || w.rng.IntN(5) == 0 {
					w.logf("source: no relay (backoff %s)", w.backoff)
					w.attemptAt = w.now.Add(w.backoff)
					w.backoff = min(w.backoff*2, UnplannedBackoffMax)
				} else {
					w.plan(false)
					w.attemptAt = time.Time{}
				}
			}
		} else if !s.NeedsPath() && s.Pending() == nil {
			w.attemptAt = time.Time{}
		}
		w.openPaths()

		// Deliver frames due.
		w.deliver()

		// Applications.
		for _, side := range []*simSide{&w.src, &w.tgt} {
			if side.core == nil {
				continue
			}
			w.app(side)
		}

		// Timers.
		for _, side := range []*simSide{&w.src, &w.tgt} {
			if side.core == nil {
				continue
			}
			if next := side.core.NextDeadline(); !next.IsZero() && !w.now.Before(next) {
				side.core.Tick(w.now)
				w.flush(side)
			}
		}
		w.check()
		w.skipIdle()
	}
	w.finalCheck()
}

func (w *simWorld) dump() string {
	var out bytes.Buffer
	for _, side := range []*simSide{&w.src, &w.tgt} {
		c := side.core
		if c == nil {
			continue
		}
		una, nxt, rcv, del := c.Offsets()
		cur := "-"
		if c.Current() != nil {
			p := w.findPath(c.Current())
			cur = fmt.Sprintf("path %d dead=%v cursor=%d/%d", p.id, p.dead, c.Current().sendCursor, c.Current().recvCursor)
		}
		fmt.Fprintf(&out, "%s: state %s una %d nxt %d rcv %d delivered %d acksent %d wnd %d peerwnd %d fin %v/%v written %d/%d closed %v got %d gotfin %d queued %d ackDue %v next %v cur %s pending %v\n",
			side.name, c.State(), una, nxt, rcv, del, c.ackSent, c.wnd, c.peerWnd, c.finQueued, c.peerFin, side.written, len(side.data), side.closed,
			len(side.got), side.gotFin, c.Queued(), c.ackDue, c.NextDeadline(), cur, c.Pending() != nil)
	}
	for _, p := range w.paths {
		if len(p.toT)+len(p.toS) > 0 {
			fmt.Fprintf(&out, "path %d inflight toT %d toS %d dead %v\n", p.id, len(p.toT), len(p.toS), p.dead)
		}
	}
	return out.String()
}

func (w *simWorld) tgtState() string {
	if w.tgt.core == nil {
		return "none"
	}
	return w.tgt.core.State().String()
}

// quiet reports no frame in flight on any path.
func (w *simWorld) quiet() bool {
	for _, p := range w.paths {
		if len(p.toT) > 0 || len(p.toS) > 0 {
			return false
		}
	}
	return len(w.openings) == 0
}

// skipIdle jumps the clock to the next event when nothing happens before it.
func (w *simWorld) skipIdle() {
	next := time.Time{}
	consider := func(t time.Time) {
		if !t.IsZero() && (next.IsZero() || t.Before(next)) {
			next = t
		}
	}
	for _, p := range w.paths {
		if len(p.toT) > 0 {
			consider(p.toT[0].at)
		}
		if len(p.toS) > 0 {
			consider(p.toS[0].at)
		}
	}
	for _, o := range w.openings {
		consider(o.at)
	}
	consider(w.src.core.NextDeadline())
	if w.tgt.core != nil {
		consider(w.tgt.core.NextDeadline())
	}
	consider(w.attemptAt)
	consider(w.revokedAt)
	busy := w.src.core.NeedsPath() && w.attemptAt.IsZero() && len(w.openings) == 0
	for _, side := range []*simSide{&w.src, &w.tgt} {
		if side.core != nil && !side.core.State().Terminal() && (side.core.Readable() || (!side.closed && side.closeAt >= 0)) {
			busy = true
		}
	}
	if !busy && !next.IsZero() && next.After(w.now) {
		w.now = next
	}
}

func (w *simWorld) plan(planned bool) {
	s := w.src.core
	if !s.CanResume() || len(w.openings) > 0 {
		return
	}
	if planned && s.Current() == nil {
		return
	}
	relay := w.relayName()
	at := w.now.Add(time.Duration(w.rng.IntN(20_000)) * time.Microsecond)
	w.openings = append(w.openings, simOpening{at: at, planned: planned, relay: relay})
}

func (w *simWorld) openPaths() {
	kept := w.openings[:0]
	for _, o := range w.openings {
		if w.now.Before(o.at) {
			kept = append(kept, o)
			continue
		}
		s := w.src.core
		if !s.CanResume() || (o.planned && s.Current() == nil) {
			continue
		}
		p := w.newPath(o.relay)
		p.src = NewPath(p, p.relay, p.maxFrame)
		if w.rng.IntN(3) == 0 {
			// Key rotation reached the source.
			s.SetKey(w.keyID, w.routeKeys[w.keyID])
		}
		w.logf("source resumes on path %d (%s), planned=%v, epoch %d", p.id, p.relay, o.planned, s.Epoch()+1)
		if !s.BeginResume(p.src, w.now) {
			w.fail("BeginResume refused after CanResume")
		}
		w.flush(&w.src)
	}
	w.openings = kept
}

func (w *simWorld) deliver() {
	for _, p := range w.paths {
		for len(p.toT) > 0 && !w.now.Before(p.toT[0].at) {
			frame := p.toT[0]
			p.toT = p.toT[1:]
			w.toTarget(p, frame)
		}
		for len(p.toS) > 0 && !w.now.Before(p.toS[0].at) {
			frame := p.toS[0]
			p.toS = p.toS[1:]
			if frame.fail {
				if p.src != nil {
					w.logf("source learns path %d ended (state %s)", p.id, w.src.core.State())
					w.src.core.PathFailed(p.src, frame.terminal, nil, w.now)
					w.flush(&w.src)
				}
				continue
			}
			if p.src != nil {
				w.src.core.PathFrame(p.src, frame.data, w.now)
				w.flush(&w.src)
			}
		}
	}
}

func (w *simWorld) keys(keyID string) []byte { return w.routeKeys[keyID] }

func (w *simWorld) authorize() error {
	if !w.authorized {
		return errors.New("revoked")
	}
	return nil
}

func (w *simWorld) toTarget(p *simPath, frame simFrame) {
	if frame.fail {
		if p.tgt != nil && w.tgt.core != nil {
			w.logf("target learns path %d ended (state %s)", p.id, w.tgt.core.State())
			w.tgt.core.PathFailed(p.tgt, frame.terminal, nil, w.now)
			w.flush(&w.tgt)
		}
		return
	}
	if p.tgt != nil {
		if w.tgt.core != nil {
			w.tgt.core.PathFrame(p.tgt, frame.data, w.now)
			w.flush(&w.tgt)
		}
		return
	}
	// First frame of an incoming tunnel: the target's first-record rule.
	p.tgt = NewPath(p, p.relay, p.maxFrame)
	record, rest, err := ParseRecord(frame.data)
	if err != nil {
		w.fail("first frame does not parse: %v", err)
	}
	switch record.Type {
	case TypeHello:
		key := w.keys(record.KeyID)
		if key == nil || !VerifyHello(&record, "route-1", p.relay, key) {
			w.fail("source HELLO does not verify")
		}
		if w.tgt.core != nil {
			w.fail("second HELLO")
		}
		w.tgt.core = NewTarget(Config{RouteID: "route-1", Keys: w.keys, TargetNonce: w.nonce, Authorize: w.authorize, Budget: w.budget,
			Window: []int{0, MinWindow, MaxWindow}[w.rng.IntN(3)]}, p.tgt, &record, record.KeyID, key, rest, w.now)
		w.targets[record.SessionID] = w.tgt.core
		w.logf("target accepts HELLO on path %d", p.id)
		w.flush(&w.tgt)
	case TypeResume:
		if len(rest) != 0 {
			w.fail("RESUME frame carries more records")
		}
		session := w.targets[record.SessionID]
		if session == nil {
			w.logf("target: RESUME for an unknown session on path %d", p.id)
			reject := mustRecord(&Record{Type: TypeResumeRej, SessionID: record.SessionID, Code: RejectUnknown})
			if !p.sink && !p.dead {
				p.toS = append(p.toS, simFrame{at: w.arrival(p, p.toS), data: reject})
			}
			w.cut(p, false, true, false)
			return
		}
		verdict := session.AcceptResume(p.tgt, &record, w.now)
		if verdict.Accepted && !w.authorized {
			w.fail("target accepted a RESUME after the route was revoked")
		}
		if verdict.Accepted && p.rogue && p.relay != p.origin {
			w.fail("target accepted a RESUME replayed through another relay")
		}
		w.logf("target: RESUME epoch %d on path %d (%s rogue=%v): accepted=%v reject=%d", record.Epoch, p.id, p.relay, p.rogue, verdict.Accepted, verdict.Reject)
		if session == w.tgt.core {
			w.flush(&w.tgt)
		}
	default:
		w.fail("unexpected first record 0x%02x", record.Type)
	}
}

func (w *simWorld) app(side *simSide) {
	c := side.core
	if c.State() == StateReset {
		return
	}
	// Write.
	for writes := w.rng.IntN(32); writes > 0 && !side.closed && side.written < len(side.data) && !c.State().Terminal(); writes-- {
		n := 1 + w.rng.IntN(side.maxChunk)
		n = min(n, len(side.data)-side.written)
		if !c.CanWrite(n) {
			break
		}
		ok, err := c.Write(side.data[side.written:side.written+n], w.now)
		if err != nil {
			if !c.State().Terminal() {
				w.fail("%s write failed: %v", side.name, err)
			}
			break
		}
		if !ok {
			w.fail("%s Write refused although CanWrite", side.name)
		}
		side.written += n
	}
	if !side.closed && side.written == side.closeAt && side.closeAt >= 0 && w.rng.IntN(2) == 0 && !c.State().Terminal() {
		side.closed = true
		if err := c.CloseWrite(w.now); err != nil {
			w.fail("%s close write: %v", side.name, err)
		}
	}
	// Read (sometimes slowly: backpressure).
	if w.now.Before(side.slowUntil) && w.rng.IntN(20) != 0 {
		w.flush(side)
		return
	}
	if w.rng.IntN(200) == 0 {
		side.slowUntil = w.now.Add(time.Duration(w.rng.IntN(2000)) * time.Millisecond)
	}
	peer := &w.tgt
	if side == &w.tgt {
		peer = &w.src
	}
	for reads := 1 + w.rng.IntN(64); reads > 0; reads-- {
		data, fin, ok := c.Read(w.now)
		if !ok {
			break
		}
		if side.gotFin > 0 {
			w.fail("%s got data or FIN after FIN", side.name)
		}
		if fin {
			if len(side.got) != len(peer.data) || !peer.closed {
				w.fail("%s got FIN at %d of %d bytes", side.name, len(side.got), len(peer.data))
			}
			side.gotFin++
			continue
		}
		off := len(side.got)
		if off+len(data) > len(peer.data) || !bytes.Equal(data, peer.data[off:off+len(data)]) {
			w.fail("%s received bytes that differ from what the peer wrote at offset %d (+%d)", side.name, off, len(data))
		}
		side.got = append(side.got, data...)
	}
	w.flush(side)
}

func (w *simWorld) check() {
	for _, side := range []*simSide{&w.src, &w.tgt} {
		c := side.core
		if c == nil || c.State().Terminal() {
			continue
		}
		if unacked := c.Unacked(); unacked > max(c.Window(), uint64(side.maxChunk))+1 {
			w.fail("%s holds %d unacked bytes with a window of %d", side.name, unacked, c.Window())
		}
	}
	if w.budget.Used() > w.budget.Limit() || w.budget.Used() < 0 {
		w.fail("window budget %d of %d", w.budget.Used(), w.budget.Limit())
	}
}

func (w *simWorld) finalCheck() {
	if w.budget.Used() != 0 {
		w.fail("window budget not released: %d", w.budget.Used())
	}
	s, t := w.src.core, w.tgt.core
	success := s.State() == StateFinished && t != nil && t.State() == StateFinished
	if success {
		for _, side := range []*simSide{&w.src, &w.tgt} {
			peer := &w.tgt
			if side == &w.tgt {
				peer = &w.src
			}
			if side.gotFin != 1 || sha256.Sum256(side.got) != sha256.Sum256(peer.data) {
				w.fail("%s finished without the peer's exact bytes (%d of %d, fin %d)", side.name, len(side.got), len(peer.data), side.gotFin)
			}
		}
		return
	}
	if len(w.fatal) > 0 {
		return
	}
	// Without a fatal injection, only an unresumable early cut or running out
	// of resume time may end a stream.
	allowed := func(c *Core) bool {
		return c != nil && (errors.Is(c.Err(), ErrNotResumable) || errors.Is(c.Err(), ErrSuspendTimeout))
	}
	if t == nil || allowed(s) || allowed(t) && s.State() != StateReset {
		return
	}
	var reset *ResetError
	if errors.As(s.Err(), &reset) && reset.Remote && allowed(t) {
		return
	}
	w.fail("stream ended without a fatal injection: source %s (%v), target %s (%v)\n%s", s.State(), s.Err(), t.State(), t.Err(), w.dump())
}

func TestSimulator(t *testing.T) {
	seeds := simSeedCount()
	start := *simSeedStart
	outcomes := map[string]int{}
	examples := map[string][]uint64{}
	for i := 0; i < seeds; i++ {
		w := newSimWorld(t, start+uint64(i))
		w.run()
		key := w.src.core.State().String()
		if len(w.fatal) > 0 {
			key += "+fatal"
		} else if err := w.src.core.Err(); err != nil {
			key += ": " + errors.Unwrap(err).Error()
		}
		outcomes[key]++
		if len(examples[key]) < 3 {
			examples[key] = append(examples[key], start+uint64(i))
		}
	}
	t.Logf("simulator: %d seeds from %d pass: %v (example seeds %v)", seeds, start, outcomes, examples)
}
