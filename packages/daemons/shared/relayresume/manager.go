package relayresume

import (
	"context"
	crand "crypto/rand"
	"errors"
	"math/rand/v2"
	"slices"
	"sync"
	"sync/atomic"
	"time"
)

// Dialer opens a new tunnel for a source session's route: on the best
// active candidate other than avoidRelayID when one exists (the same relay
// is fine when it is the only one), each candidate within OpenTimeout.
type Dialer func(ctx context.Context, avoidRelayID string) (OpenedPath, error)

// SourceConfig configures a source session.
type SourceConfig struct {
	RouteID string
	// Key returns the route key of the latest bundle; every RESUME is signed
	// with it (rotation). ok=false: the route is no longer resumable.
	Key              func() (keyID string, key []byte, ok bool)
	HalfCloseTimeout time.Duration
	Dial             Dialer
	// Tag is the caller's (owner kind and id, for logs).
	Tag any
}

// Trigger names why a stream migrated.
type Trigger string

const (
	TriggerDrain       Trigger = "drain"
	TriggerGoAway      Trigger = "goaway"
	TriggerPathFailure Trigger = "path_failure"
	TriggerTargetHint  Trigger = "target_hint"
)

// MigrationEvent reports one finished migration attempt series (logs,
// metrics).
type MigrationEvent struct {
	Session *Session
	Trigger Trigger
	OK      bool
	From    string
	To      string
	Stall   time.Duration
	Err     error
}

// Manager is the process-wide source side: the registry of resumable
// streams, the migration workers (at most MaxMigrationsInFlight at a time),
// the legacy latch and the counters reported to Gateway.
type Manager struct {
	budget *WindowBudget
	slots  chan struct{}

	mu       sync.Mutex
	sessions map[*Session]struct{}
	legacy   map[string]legacyLatch
	routeKey map[string]string // last applied resume key id per route ("" absent)
	legacyBy map[string]int    // live legacy streams per relay
	stalls   []time.Duration
	stallPos int

	// OnMigration observes migrations (optional; called without locks held).
	OnMigration func(MigrationEvent)
	// OnEnd observes resumable streams that ended (optional).
	OnEnd func(s *Session, err error)
	// MigrateRequestDeadline paces a target's drain hint (MIGRATE_REQ drain):
	// the time the stream must leave relayID by (optional; called with the
	// session locked, so it must not call into the session).
	MigrateRequestDeadline func(relayID string, tag any) time.Time

	migrationsOK     atomic.Uint64
	migrationsFailed atomic.Uint64
	cut              atomic.Uint64
	retransmitted    atomic.Uint64
}

// NewManager creates the source side of a process.
func NewManager(budget *WindowBudget) *Manager {
	if budget == nil {
		budget = NewWindowBudget(0)
	}
	return &Manager{budget: budget, slots: make(chan struct{}, MaxMigrationsInFlight), sessions: map[*Session]struct{}{},
		legacy: map[string]legacyLatch{}, legacyBy: map[string]int{}, routeKey: map[string]string{}}
}

// Budget is the process window budget (shared with the target table).
func (m *Manager) Budget() *WindowBudget { return m.budget }

type sourceState struct {
	mgr       *Manager
	cfg       SourceConfig
	migrating bool
	trigger   Trigger
	stalled   time.Time // the stream stopped moving (suspend or planned stop)
	ended     bool
	// deferred is a planned move that arrived while the stream could not
	// start one (handshake, a migration running): it starts once it can,
	// unless the stream left that relay meanwhile.
	deferred *plannedMove
}

type plannedMove struct {
	trigger Trigger
	avoid   string
	at      time.Time
}

// requestLocked starts a planned move off avoid at at, or keeps it for
// later (mu held).
func (st *sourceState) requestLocked(s *Session, trigger Trigger, avoid string, at time.Time) {
	c := s.core
	if st.migrating || !c.CanResume() || c.Current() == nil {
		if avoid != "" && (st.deferred == nil || at.Before(st.deferred.at)) {
			st.deferred = &plannedMove{trigger: trigger, avoid: avoid, at: at}
		}
		return
	}
	if c.Current().RelayID() != avoid {
		return // already elsewhere
	}
	st.start(s, trigger, false, avoid, at)
}

// NewSource starts a resumable stream on first (HELLO, then data at once).
func (m *Manager) NewSource(cfg SourceConfig, first OpenedPath) (*Session, error) {
	keyID, key, ok := cfg.Key()
	if !ok || !validKeyID(keyID) || len(key) == 0 {
		return nil, errors.New("relayresume: route has no resume key")
	}
	var sid [SessionIDLen]byte
	if _, err := crand.Read(sid[:]); err != nil {
		return nil, err
	}
	path := NewPath(nil, first.RelayID, first.MaxFrame)
	core := NewSource(Config{RouteID: cfg.RouteID, KeyID: keyID, Key: key, SessionID: sid, HalfCloseTimeout: cfg.HalfCloseTimeout, Budget: m.budget}, path, time.Now())
	s := newSession(core, cfg.RouteID, first.MaxFrame)
	s.source = &sourceState{mgr: m, cfg: cfg}
	m.mu.Lock()
	m.sessions[s] = struct{}{}
	m.mu.Unlock()
	s.mu.Lock()
	s.attach(path, first)
	s.afterLocked(false)
	s.mu.Unlock()
	return s, nil
}

// Tag is the SourceConfig tag (source) or the Establish tag (target).
func (s *Session) Tag() any {
	if s.source == nil {
		return s.tag
	}
	return s.source.cfg.Tag
}

// RequestMigrate asks the source of a target session to move (MIGRATE_REQ).
func (s *Session) RequestMigrate(reason byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.core.RequestMigrate(reason)
	s.afterLocked(false)
}

// observeLocked runs after every session event (mu held): it starts the
// unplanned migration loop, answers MIGRATE_REQ and ends the bookkeeping.
func (st *sourceState) observeLocked(s *Session) {
	c := s.core
	if c.State().Terminal() {
		if !st.ended {
			st.ended = true
			go st.mgr.ended(s, c.Err(), c.Retransmitted)
		}
		return
	}
	if reason, ok := c.TakeMigrateRequest(); ok && c.Current() != nil {
		at := time.Now()
		if hook := st.mgr.MigrateRequestDeadline; hook != nil && reason == MigrateDrain {
			// A drain hint is paced like the source's own drain.
			at = pacedStart(hook(c.Current().RelayID(), st.cfg.Tag))
		}
		st.requestLocked(s, TriggerTargetHint, c.Current().RelayID(), at)
		return
	}
	if c.NeedsPath() && !st.migrating {
		st.start(s, TriggerPathFailure, true, "", time.Time{})
		return
	}
	if d := st.deferred; d != nil && !st.migrating && c.CanResume() && c.Current() != nil {
		st.deferred = nil
		st.requestLocked(s, d.trigger, d.avoid, d.at)
	}
}

// start hands the session to a migration worker (mu held).
func (st *sourceState) start(s *Session, trigger Trigger, unplanned bool, avoid string, at time.Time) {
	st.migrating = true
	st.trigger = trigger
	if st.stalled.IsZero() {
		st.stalled = time.Now()
	}
	go st.mgr.migrate(s, trigger, unplanned, avoid, at)
}

func (m *Manager) ended(s *Session, err error, retransmitted uint64) {
	m.mu.Lock()
	delete(m.sessions, s)
	m.mu.Unlock()
	m.retransmitted.Add(retransmitted)
	if err != nil && isCut(err) {
		m.cut.Add(1)
	}
	if errors.Is(err, ErrLegacyPeer) {
		s.mu.Lock()
		keyID := s.core.keyID
		s.mu.Unlock()
		m.MarkLegacyKey(s.routeID, keyID)
	}
	if m.OnEnd != nil {
		m.OnEnd(s, err)
	}
}

// isCut reports a resumable stream that ended because it could not move:
// not a local or peer socket decision.
func isCut(err error) bool {
	var reset *ResetError
	if !errors.As(err, &reset) || reset.Remote {
		return false
	}
	return reset.Reject != 0 || errors.Is(err, ErrSuspendTimeout) || errors.Is(err, ErrNotResumable) || errors.Is(err, ErrRevoked)
}

// migrate is one migration worker run for s.
func (m *Manager) migrate(s *Session, trigger Trigger, unplanned bool, avoid string, at time.Time) {
	if wait := time.Until(at); wait > 0 {
		timer := time.NewTimer(wait)
		select {
		case <-timer.C:
		case <-s.done:
			timer.Stop()
		}
	}
	select {
	case m.slots <- struct{}{}:
	case <-s.done:
	}
	defer func() {
		select {
		case <-m.slots:
		default:
		}
	}()
	from := s.RelayID()
	ok, to, err := m.attempts(s, unplanned, avoid)
	s.mu.Lock()
	st := s.source
	stall := time.Duration(0)
	if ok && !st.stalled.IsZero() {
		stall = time.Since(st.stalled)
	}
	if ok || s.core.State() == StateOpen {
		st.stalled = time.Time{}
	}
	st.migrating = false
	// A planned move that left the stream without a path: the unplanned
	// loop takes over.
	st.observeLocked(s)
	s.mu.Unlock()
	if ok {
		m.migrationsOK.Add(1)
		m.recordStall(stall)
	} else if err != nil {
		m.migrationsFailed.Add(1)
	}
	if m.OnMigration != nil && (ok || err != nil) {
		m.OnMigration(MigrationEvent{Session: s, Trigger: trigger, OK: ok, From: from, To: to, Stall: stall, Err: err})
	}
}

// attempts tries until the stream moved, the budget ran out or the stream
// ended. Planned: within PlannedBudget, staying on the old path on failure.
// Unplanned: until the core's suspend deadline (UnplannedBudget).
func (m *Manager) attempts(s *Session, unplanned bool, avoid string) (bool, string, error) {
	deadline := time.Now().Add(PlannedBudget)
	if unplanned {
		deadline = time.Now().Add(UnplannedBudget + time.Second)
	}
	backoff := UnplannedBackoffMin
	var lastErr error
	for time.Now().Before(deadline) {
		s.mu.Lock()
		state := s.core.State()
		canResume := s.core.CanResume()
		current := s.core.Current()
		lost := s.core.LostRelay()
		s.mu.Unlock()
		if state.Terminal() {
			return false, "", lastErr
		}
		if !canResume {
			return false, "", lastErr
		}
		if !unplanned && (current == nil || (avoid != "" && current.RelayID() != avoid)) {
			if current == nil {
				// The old path died meanwhile: carry on unplanned.
				unplanned = true
				deadline = time.Now().Add(UnplannedBudget + time.Second)
				continue
			}
			return false, "", nil // already moved
		}
		pathAvoid := avoid
		switch {
		case pathAvoid != "":
		case current != nil:
			pathAvoid = current.RelayID()
		default:
			// Unplanned: the relay that just failed goes last (the dialers
			// still try it when nothing else takes the stream).
			pathAvoid = lost
		}
		ok, to, err := m.attempt(s, unplanned, pathAvoid)
		if ok {
			return true, to, nil
		}
		lastErr = err
		timer := time.NewTimer(backoff + time.Duration(rand.Int64N(int64(backoff/4)+1)))
		select {
		case <-timer.C:
		case <-s.done:
			timer.Stop()
			return false, "", lastErr
		}
		backoff = min(backoff*2, UnplannedBackoffMax)
	}
	if lastErr == nil {
		lastErr = errors.New("relayresume: migration budget exhausted")
	}
	return false, "", lastErr
}

var errNotResumableNow = errors.New("relayresume: stream cannot resume now")

// attempt opens one path and runs one RESUME exchange on it.
func (m *Manager) attempt(s *Session, unplanned bool, avoid string) (bool, string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), OpenTimeout*3)
	defer cancel()
	go func() {
		select {
		case <-s.done:
			cancel()
		case <-ctx.Done():
		}
	}()
	op, err := s.source.cfg.Dial(ctx, avoid)
	if err != nil {
		return false, "", err
	}
	s.mu.Lock()
	if !s.core.CanResume() || (!unplanned && s.core.Current() == nil && s.core.State() == StateOpen) {
		s.mu.Unlock()
		if op.Cancel != nil {
			op.Cancel()
		}
		return false, "", errNotResumableNow
	}
	if keyID, key, ok := s.source.cfg.Key(); ok {
		s.core.SetKey(keyID, key)
	}
	path := NewPath(nil, op.RelayID, op.MaxFrame)
	s.attach(path, op)
	if !s.core.BeginResume(path, time.Now()) {
		s.core.DropPath(path)
		s.afterLocked(false)
		s.mu.Unlock()
		return false, "", errNotResumableNow
	}
	s.afterLocked(false)
	for s.core.Pending() == path && !s.core.State().Terminal() {
		s.stateCond.Wait()
	}
	ok := s.core.Current() == path
	err = nil
	if !ok {
		err = s.core.Err()
		if err == nil {
			err = errors.New("relayresume: resume attempt failed")
		}
	}
	s.mu.Unlock()
	return ok, op.RelayID, err
}

// pacedStart is when a paced move starts: uniformly before deadline, but
// within DefaultDrainSpreadTime. A long drain grace exists for raw streams
// that cannot move; a resumable stream leaves early, so a forced end of the
// drain finds none (zero deadline: within a second).
func pacedStart(deadline time.Time) time.Time {
	spread := min(time.Until(deadline), DefaultDrainSpreadTime)
	if spread <= 0 {
		spread = time.Second
	}
	return time.Now().Add(time.Duration(rand.Int64N(int64(spread))))
}

// Migrate moves s off its relay, paced: the attempt starts at a random time
// before deadline (zero deadline: within a second). Planned: the stream
// stays where it is if no other relay takes it.
func (m *Manager) Migrate(s *Session, trigger Trigger, deadline time.Time) {
	at := pacedStart(deadline)
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.source == nil || s.core.Current() == nil {
		return // suspended: the unplanned loop picks a relay anyway
	}
	s.source.requestLocked(s, trigger, s.core.Current().RelayID(), at)
}

// DrainRelay moves every resumable stream off relayID, spread until
// deadline.
func (m *Manager) DrainRelay(relayID string, deadline time.Time) {
	for _, s := range m.Sessions() {
		if s.RelayID() == relayID {
			m.Migrate(s, TriggerDrain, deadline)
		}
	}
}

// RelayLost moves every resumable stream off relayID at once (its lane got
// GOAWAY: the relay stops within seconds).
func (m *Manager) RelayLost(relayID string) {
	for _, s := range m.Sessions() {
		if s.RelayID() != relayID {
			continue
		}
		s.mu.Lock()
		if s.source != nil {
			s.source.requestLocked(s, TriggerGoAway, relayID, time.Now().Add(time.Duration(rand.Int64N(int64(100*time.Millisecond)))))
		}
		s.mu.Unlock()
	}
}

// Sessions is a snapshot of the live resumable source streams.
func (m *Manager) Sessions() []*Session {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]*Session, 0, len(m.sessions))
	for s := range m.sessions {
		out = append(out, s)
	}
	return out
}

// Legacy reports a route latched to raw streams (its target answered a
// HELLO with something else).
func (m *Manager) Legacy(routeID string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	latch, ok := m.legacy[routeID]
	if ok && time.Now().After(latch.until) {
		delete(m.legacy, routeID)
		return false
	}
	return ok
}

type legacyLatch struct {
	until time.Time
	keyID string // the key the refused HELLO carried ("" unknown)
}

// MarkLegacy latches routeID to raw streams for LegacyLatch.
func (m *Manager) MarkLegacy(routeID string) { m.MarkLegacyKey(routeID, "") }

// MarkLegacyKey latches routeID to raw streams for LegacyLatch, noting the
// key the refused HELLO carried: a bundle with another key clears it.
func (m *Manager) MarkLegacyKey(routeID, keyID string) {
	m.mu.Lock()
	m.legacy[routeID] = legacyLatch{until: time.Now().Add(LegacyLatch), keyID: keyID}
	m.mu.Unlock()
}

// NoteRouteKey records the resume key id an applied bundle gives routeID
// ("" when the route has none). A key id other than the one the latched
// HELLO carried, or other than the last one applied (absent → present
// included), clears the route's legacy latch: Gateway turned the route on
// again for a target that is resume-aware now.
func (m *Manager) NoteRouteKey(routeID, keyID string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	last, seen := m.routeKey[routeID]
	m.routeKey[routeID] = keyID
	if keyID == "" {
		return
	}
	latch, latched := m.legacy[routeID]
	if latched && ((latch.keyID != "" && latch.keyID != keyID) || (seen && last != keyID)) {
		delete(m.legacy, routeID)
	}
}

// ForgetRoutes drops the recorded keys of routes keep refuses (gone from
// the bundle).
func (m *Manager) ForgetRoutes(keep func(routeID string) bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for routeID := range m.routeKey {
		if !keep(routeID) {
			delete(m.routeKey, routeID)
		}
	}
}

// TrackLegacy counts a raw (not resumable) stream through relayID until the
// returned func is called.
func (m *Manager) TrackLegacy(relayID string) func() {
	m.mu.Lock()
	m.legacyBy[relayID]++
	m.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			m.mu.Lock()
			if m.legacyBy[relayID]--; m.legacyBy[relayID] <= 0 {
				delete(m.legacyBy, relayID)
			}
			m.mu.Unlock()
		})
	}
}

func (m *Manager) recordStall(stall time.Duration) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.stalls) < 256 {
		m.stalls = append(m.stalls, stall)
		return
	}
	m.stalls[m.stallPos] = stall
	m.stallPos = (m.stallPos + 1) % len(m.stalls)
}

// SourceStats are the source-side counters (each stream counted once, at
// the daemon that opened it).
type SourceStats struct {
	Resumable          uint64
	Legacy             uint64
	Suspended          uint64
	MigrationsOK       uint64
	MigrationsFailed   uint64
	Cut                uint64
	Retransmitted      uint64
	Unacked            uint64
	StallP50, StallP95 time.Duration
	ByRelay            map[string][2]uint64 // relay -> {resumable, legacy}
}

// Stats snapshots the counters.
func (m *Manager) Stats() SourceStats {
	stats := SourceStats{ByRelay: map[string][2]uint64{}, MigrationsOK: m.migrationsOK.Load(), MigrationsFailed: m.migrationsFailed.Load(),
		Cut: m.cut.Load(), Retransmitted: m.retransmitted.Load()}
	sessions := m.Sessions()
	for _, s := range sessions {
		s.mu.Lock()
		stats.Resumable++
		stats.Unacked += s.core.Unacked()
		stats.Retransmitted += s.core.Retransmitted
		state := s.core.State()
		relay := ""
		if p := s.core.Current(); p != nil {
			relay = p.RelayID()
		}
		s.mu.Unlock()
		if state == StateSuspended || state == StateResuming {
			stats.Suspended++
		}
		if relay != "" {
			entry := stats.ByRelay[relay]
			entry[0]++
			stats.ByRelay[relay] = entry
		}
	}
	m.mu.Lock()
	for relay, n := range m.legacyBy {
		stats.Legacy += uint64(n)
		entry := stats.ByRelay[relay]
		entry[1] += uint64(n)
		stats.ByRelay[relay] = entry
	}
	stalls := slices.Clone(m.stalls)
	m.mu.Unlock()
	if len(stalls) > 0 {
		slices.Sort(stalls)
		stats.StallP50 = stalls[len(stalls)/2]
		stats.StallP95 = stalls[min(len(stalls)-1, len(stalls)*95/100)]
	}
	return stats
}
