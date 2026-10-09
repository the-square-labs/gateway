package relayresume

import (
	"context"
	"math/rand/v2"
	"time"
)

// Returner moves resumable source streams back to the nearest relay of their
// route after they left it: a stream that moved to a standby or a farther
// relay when its relay failed, drained or restarted stays there until
// something moves it, and a far relay adds its round trip to every byte.
//
// Each pass asks Nearer, per stream that has not moved for Cooldown, whether
// a clearly nearer relay is available (the daemon's judgement: connected and
// stable for a while, a better role or beyond a hysteresis band), and moves
// at most Batch streams, each at a random time within the pass, through the
// planned move path: the stream stays where it is if the new path does not
// open, and nothing is cut.
type Returner struct {
	Manager  *Manager
	Interval time.Duration
	Batch    int
	Cooldown time.Duration
	// Nearer reports whether the stream on relayID has a clearly nearer relay
	// to return to.
	Nearer func(s *Session, relayID string) bool
	// Prepare runs before each pass (optional): the daemon samples its relay
	// transports there.
	Prepare func()
	// now and jitter are replaced in tests.
	now    func() time.Time
	jitter func(time.Duration) time.Duration
}

// A node carries tens of streams on one route set, and after a local relay
// outage every one of them sits on a farther relay: with 8 moves a pass and a
// minute's cooldown they came back 60-100 s after the relay served again
// (stand rc.7, F-3). A pass now moves up to 32, and a stream that moved 20 s
// ago may move again, which brings a node's streams back within a pass or two
// once the relay is stable (relaybridge.ReturnStableFor).
const (
	// DefaultReturnInterval spaces the passes.
	DefaultReturnInterval = 10 * time.Second
	// DefaultReturnBatch bounds the streams one pass moves per daemon.
	DefaultReturnBatch = 32
	// DefaultReturnCooldown keeps a stream that just moved where it is for a while.
	DefaultReturnCooldown = 20 * time.Second
)

// Run passes every Interval until ctx ends.
func (r *Returner) Run(ctx context.Context) {
	interval := r.Interval
	if interval <= 0 {
		interval = DefaultReturnInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.Pass()
		}
	}
}

// Pass runs one pass and returns how many streams it asked to move.
func (r *Returner) Pass() int {
	if r.Manager == nil || r.Nearer == nil {
		return 0
	}
	if r.Prepare != nil {
		r.Prepare()
	}
	now, jitter := time.Now, func(spread time.Duration) time.Duration { return time.Duration(rand.Int64N(int64(spread))) }
	if r.now != nil {
		now = r.now
	}
	if r.jitter != nil {
		jitter = r.jitter
	}
	interval, batch, cooldown := r.Interval, r.Batch, r.Cooldown
	if interval <= 0 {
		interval = DefaultReturnInterval
	}
	if batch <= 0 {
		batch = DefaultReturnBatch
	}
	if cooldown <= 0 {
		cooldown = DefaultReturnCooldown
	}
	sessions := r.Manager.Sessions()
	rand.Shuffle(len(sessions), func(i, j int) { sessions[i], sessions[j] = sessions[j], sessions[i] })
	at := now()
	moved := 0
	for _, s := range sessions {
		if moved >= batch {
			break
		}
		if s.Moving() || s.State() != StateOpen {
			continue
		}
		if last := s.LastMove(); !last.IsZero() && at.Sub(last) < cooldown {
			continue
		}
		relayID, _, ok := s.CurrentPath()
		if !ok || !r.Nearer(s, relayID) {
			continue
		}
		r.Manager.Repath(s, TriggerReturn, at.Add(jitter(interval)))
		moved++
	}
	return moved
}
