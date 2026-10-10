package relayresume

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// generationDialer dials like the harness and labels each path with the
// generation current at the time; it answers ErrStay when the best relay
// (the first live one, or the one prefer names) under the current
// generation is the path the stream is on.
type generationDialer struct {
	h          *harness
	generation atomic.Uint64
	mu         sync.Mutex
	prefer     string
	requests   []DialRequest
}

func (d *generationDialer) dial(ctx context.Context, request DialRequest) (OpenedPath, error) {
	d.mu.Lock()
	d.requests = append(d.requests, request)
	prefer := d.prefer
	d.mu.Unlock()
	best := ""
	for _, relay := range d.h.relays {
		if relay.down.Load() || (request.Avoid != "" && relay.id == request.Avoid && len(d.h.relays) > 1) {
			continue
		}
		if best == "" || relay.id == prefer {
			best = relay.id
		}
	}
	generation := d.generation.Load()
	if !request.NewPath && request.Avoid == "" && best == request.FromRelay && generation == request.FromGeneration {
		return OpenedPath{}, ErrStay
	}
	// The harness dial takes the first live relay other than the one it avoids.
	other := ""
	for _, relay := range d.h.relays {
		if relay.id != best && other == "" {
			other = relay.id
		}
	}
	op, err := d.h.dial(ctx, other)
	op.Generation = generation
	return op, err
}

func (d *generationDialer) setPrefer(relay string) {
	d.mu.Lock()
	d.prefer = relay
	d.mu.Unlock()
}

func newGenerationStream(t *testing.T, h *harness) (*generationDialer, *Session) {
	t.Helper()
	dialer := &generationDialer{h: h}
	dialer.generation.Store(1)
	first, err := dialer.dial(context.Background(), DialRequest{})
	if err != nil {
		t.Fatal(err)
	}
	session, err := h.mgr.NewSource(SourceConfig{RouteID: "route-1", Dial: dialer.dial,
		Key: func() (string, []byte, bool) { return "v1", h.key, true }}, first)
	if err != nil {
		t.Fatal(err)
	}
	waitOpen(t, session)
	return dialer, session
}

func waitPath(t *testing.T, s *Session, relay string, generation uint64) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if current, gen, ok := s.CurrentPath(); ok && current == relay && gen == generation {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	current, gen, _ := s.CurrentPath()
	t.Fatalf("stream on %s generation %d, want %s generation %d", current, gen, relay, generation)
}

// A new assignment generation re-paths the stream onto the same relay under
// the new grant: the relay is not avoided, and the old tunnel ends.
func TestRepathKeepsTheStreamOnItsRelayUnderTheNewGrant(t *testing.T) {
	h := newHarness(t, "relay-a", "relay-b")
	dialer, session := newGenerationStream(t, h)
	waitPath(t, session, "relay-a", 1)
	dialer.generation.Store(2)
	h.mgr.Repath(session, TriggerRegrant, time.Now())
	waitPath(t, session, "relay-a", 2)
	deadline := time.Now().Add(5 * time.Second)
	for h.relay("relay-a").live() != 1 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if live := h.relay("relay-a").live(); live != 1 || h.relay("relay-b").live() != 0 {
		t.Fatalf("tunnels: relay-a %d, relay-b %d; want only the new one on relay-a", live, h.relay("relay-b").live())
	}
	dialer.mu.Lock()
	last := dialer.requests[len(dialer.requests)-1]
	dialer.mu.Unlock()
	if last.Avoid != "" || last.FromRelay != "relay-a" || last.FromGeneration != 1 {
		t.Fatalf("re-path request %+v", last)
	}
	if stats := h.mgr.Stats(); stats.MigrationsOK != 1 || stats.MigrationsFailed != 0 {
		t.Fatalf("stats %+v", stats)
	}
	session.Abort(RstAborted, "done")
}

// A move off a replaced lane connection opens a new path on the same relay
// under the same grant (the dialer gets NewPath) and is housekeeping: a lane
// move, not a migration.
func TestMoveOffLaneOpensANewPathOnTheSameRelay(t *testing.T) {
	h := newHarness(t, "relay-a", "relay-b")
	dialer, session := newGenerationStream(t, h)
	waitPath(t, session, "relay-a", 1)
	h.mgr.MoveOffLane(session)
	deadline := time.Now().Add(5 * time.Second)
	for h.mgr.Stats().LaneMoves != 1 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	waitPath(t, session, "relay-a", 1)
	dialer.mu.Lock()
	last := dialer.requests[len(dialer.requests)-1]
	dialer.mu.Unlock()
	if !last.NewPath || last.Avoid != "" || last.FromRelay != "relay-a" {
		t.Fatalf("move request %+v", last)
	}
	for h.relay("relay-a").live() != 1 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if live := h.relay("relay-a").live(); live != 1 {
		t.Fatalf("relay-a carries %d tunnels, want only the new path", live)
	}
	if stats := h.mgr.Stats(); stats.LaneMoves != 1 || stats.MigrationsOK != 0 || stats.MigrationsFailed != 0 {
		t.Fatalf("stats %+v", stats)
	}
	session.Abort(RstAborted, "done")
}

// A re-path whose best path is the current one ends without a move or a
// failure.
func TestRepathToTheCurrentPathStays(t *testing.T) {
	h := newHarness(t, "relay-a", "relay-b")
	_, session := newGenerationStream(t, h)
	h.mgr.Repath(session, TriggerReturn, time.Now())
	deadline := time.Now().Add(2 * time.Second)
	for session.Moving() && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(50 * time.Millisecond)
	if relay, generation, _ := session.CurrentPath(); relay != "relay-a" || generation != 1 {
		t.Fatalf("stream on %s generation %d", relay, generation)
	}
	if stats := h.mgr.Stats(); stats.MigrationsOK != 0 || stats.MigrationsFailed != 0 {
		t.Fatalf("stats %+v", stats)
	}
	if h.relay("relay-a").live() != 1 || h.relay("relay-b").live() != 0 {
		t.Fatal("a tunnel was opened for a stream that stays")
	}
	session.Abort(RstAborted, "done")
}

// A target's drain hint no longer pushes the stream off its relay: the source
// moves to the best path of its own assignment, which keeps a relay that stays.
func TestTargetDrainHintMovesToTheBestPath(t *testing.T) {
	h := newHarness(t, "relay-a", "relay-b")
	dialer, session := newGenerationStream(t, h)
	dialer.generation.Store(2)
	h.table.RequestMigrate("relay-a", MigrateDrain)
	waitPath(t, session, "relay-a", 2)
	// A GOAWAY hint still leaves the relay.
	h.table.RequestMigrate("relay-a", MigrateGoAway)
	waitPath(t, session, "relay-b", 2)
	session.Abort(RstAborted, "done")
}

// The returner moves a bounded number of streams per pass, each at a random
// time within the pass, skips streams that moved lately, and moves them back
// to the relay the daemon judges nearer.
func TestReturnerMovesABoundedNumberOfStreamsBack(t *testing.T) {
	h := newHarness(t, "relay-a", "relay-b")
	dialer := &generationDialer{h: h}
	dialer.generation.Store(1)
	dialer.setPrefer("relay-b")
	var sessions []*Session
	for range 5 {
		first, err := dialer.dial(context.Background(), DialRequest{})
		if err != nil {
			t.Fatal(err)
		}
		session, err := h.mgr.NewSource(SourceConfig{RouteID: "route-1", Dial: dialer.dial,
			Key: func() (string, []byte, bool) { return "v1", h.key, true }}, first)
		if err != nil {
			t.Fatal(err)
		}
		waitOpen(t, session)
		sessions = append(sessions, session)
	}
	for _, session := range sessions {
		if session.RelayID() != "relay-b" {
			t.Fatalf("stream opened on %s", session.RelayID())
		}
	}
	// relay-a is the nearer relay now.
	dialer.setPrefer("relay-a")
	now := time.Now()
	var delays []time.Duration
	returner := &Returner{Manager: h.mgr, Interval: time.Second, Batch: 2, Cooldown: time.Minute,
		Nearer: func(_ *Session, relayID string) bool { return relayID == "relay-b" },
		now:    func() time.Time { return now },
		jitter: func(spread time.Duration) time.Duration {
			delay := time.Duration(len(delays)) * spread / 4
			delays = append(delays, delay)
			return delay
		},
	}
	if moved := returner.Pass(); moved != 2 {
		t.Fatalf("first pass moved %d streams, want the batch of 2", moved)
	}
	if delays[0] == delays[1] {
		t.Fatalf("moves of one pass start together: %v", delays)
	}
	countOn := func(relay string) int {
		count := 0
		for _, session := range sessions {
			if session.RelayID() == relay {
				count++
			}
		}
		return count
	}
	deadline := time.Now().Add(10 * time.Second)
	for countOn("relay-a") != 2 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if countOn("relay-a") != 2 {
		t.Fatalf("%d streams returned, want 2", countOn("relay-a"))
	}
	// The streams that just moved sit out their cooldown; the others go.
	for countOn("relay-a") < 5 && time.Now().Before(deadline) {
		returner.Pass()
		time.Sleep(20 * time.Millisecond)
	}
	if countOn("relay-a") != 5 {
		t.Fatalf("%d streams returned, want all 5", countOn("relay-a"))
	}
	if moved := returner.Pass(); moved != 0 {
		t.Fatalf("a pass moved %d streams already on the nearer relay", moved)
	}
	for _, session := range sessions {
		session.Abort(RstAborted, "done")
	}
}

// The rc.3 stand (O-a): regrants paced over up to 5 s reported the pacing as their stall (p50 2.4 s, up to 9.9 s)
// while the applications saw at most 0.38 s. A planned move's stall runs from when the move stops the stream on
// its path, not from when it was requested.
func TestPlannedMoveStallLeavesOutItsPacedStart(t *testing.T) {
	h := newHarness(t, "relay-a", "relay-b")
	dialer, session := newGenerationStream(t, h)
	events := make(chan MigrationEvent, 1)
	h.mgr.OnMigration = func(event MigrationEvent) { events <- event }
	dialer.generation.Store(2)
	const pace = 500 * time.Millisecond
	h.mgr.Repath(session, TriggerRegrant, time.Now().Add(pace))
	select {
	case event := <-events:
		if !event.OK || event.Stall >= pace/2 {
			t.Fatalf("move %+v: the stall includes the paced start", event)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the stream did not move")
	}
	if stats := h.mgr.Stats(); stats.MigrationsOK != 1 || stats.StallP50 >= pace/2 {
		t.Fatalf("stats %+v", stats)
	}
	session.Abort(RstAborted, "done")
}

// Stand rc.7 (F-3): after a local relay outage a node had 30-40 streams on a
// farther relay, and with 8 moves a pass and a minute's cooldown they came
// back over 60-100 s. With the defaults, streams that moved there in the
// outage come back within two passes once their relay is stable again.
func TestReturnerBringsANodesStreamsBackWithinTwoPasses(t *testing.T) {
	h := newHarness(t, "relay-a", "relay-b")
	dialer := &generationDialer{h: h}
	dialer.generation.Store(1)
	dialer.setPrefer("relay-a")
	var sessions []*Session
	for range 40 {
		first, err := dialer.dial(context.Background(), DialRequest{})
		if err != nil {
			t.Fatal(err)
		}
		session, err := h.mgr.NewSource(SourceConfig{RouteID: "route-1", Dial: dialer.dial,
			Key: func() (string, []byte, bool) { return "v1", h.key, true }}, first)
		if err != nil {
			t.Fatal(err)
		}
		waitOpen(t, session)
		sessions = append(sessions, session)
	}
	countOn := func(relay string) int {
		count := 0
		for _, session := range sessions {
			if session.RelayID() == relay && !session.Moving() {
				count++
			}
		}
		return count
	}
	waitOn := func(relay string, want int) {
		t.Helper()
		deadline := time.Now().Add(20 * time.Second)
		for countOn(relay) != want && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		if got := countOn(relay); got != want {
			t.Fatalf("%d streams on %s, want %d", got, relay, want)
		}
	}
	// The outage: every stream moves to relay-b.
	dialer.setPrefer("relay-b")
	for _, session := range sessions {
		h.mgr.Repath(session, TriggerReturn, time.Now())
	}
	waitOn("relay-b", 40)
	// relay-a serves again and has been stable for ReturnStableFor; the moves
	// were 30 s ago on the returner's clock. The moves it asks for start at
	// once on the real one.
	dialer.setPrefer("relay-a")
	const ago = 30 * time.Second
	now := time.Now().Add(ago)
	returner := &Returner{Manager: h.mgr,
		Nearer: func(_ *Session, relayID string) bool { return relayID == "relay-b" },
		now:    func() time.Time { return now },
		jitter: func(time.Duration) time.Duration { return -ago },
	}
	if moved := returner.Pass(); moved != 32 {
		t.Fatalf("first pass moved %d streams, want 32", moved)
	}
	waitOn("relay-a", 32)
	if moved := returner.Pass(); moved != 8 {
		t.Fatalf("second pass moved %d streams, want the remaining 8", moved)
	}
	waitOn("relay-a", 40)
	for _, session := range sessions {
		session.Abort(RstAborted, "done")
	}
}
