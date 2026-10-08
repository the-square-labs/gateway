package relayresume

import (
	"bytes"
	"errors"
	"testing"
	"time"
)

// corePair is a source and a target joined by direct paths (no relay), for
// focused tests.
type corePair struct {
	t        *testing.T
	now      time.Time
	key      []byte
	src, tgt *Core
	// links maps each side's path to the peer's path.
	links    map[*Path]*Path
	authErr  error
	srcGot   []byte
	tgtGot   []byte
	srcFin   bool
	tgtFin   bool
	rejected []byte
}

func newCorePair(t testing.TB) *corePair {
	key := bytes.Repeat([]byte{7}, KeyLen)
	pair := &corePair{now: time.Unix(1_700_000_000, 0), key: key, links: map[*Path]*Path{}}
	if tt, ok := t.(*testing.T); ok {
		pair.t = tt
	}
	srcPath := NewPath(nil, "relay-a", MaxFrameBytes)
	pair.src = NewSource(Config{RouteID: "route-1", KeyID: "v1", Key: key, SessionID: [16]byte{1, 2, 3}}, srcPath, pair.now)
	out := pair.src.TakeOutputs()
	hello, rest, err := ParseRecord(out[0].Frame)
	if err != nil || !VerifyHello(&hello, "route-1", "relay-a", key) {
		t.Fatalf("hello: %v", err)
	}
	tgtPath := NewPath(nil, "relay-a", MaxFrameBytes)
	pair.tgt = NewTarget(Config{RouteID: "route-1", Keys: pair.keys, TargetNonce: [16]byte{9}, Authorize: func() error { return pair.authErr }},
		tgtPath, &hello, hello.KeyID, key, rest, pair.now)
	pair.links[srcPath], pair.links[tgtPath] = tgtPath, srcPath
	pair.deliverOutputs(pair.tgt, out[1:], pair.src)
	pair.flush()
	return pair
}

func (p *corePair) keys(keyID string) []byte {
	if keyID == "v1" {
		return p.key
	}
	return nil
}

func (p *corePair) deliverOutputs(from *Core, outputs []Output, to *Core) {
	for _, out := range outputs {
		peer := p.links[out.Path]
		if out.Close {
			if peer != nil && !peer.Closed() {
				to.PathFailed(peer, false, nil, p.now)
			}
			continue
		}
		if peer == nil {
			if out.Frame[0] == TypeResumeRej {
				p.rejected = out.Frame
			}
			continue
		}
		to.PathFrame(peer, out.Frame, p.now)
	}
}

// flush exchanges frames until both sides are quiet, reading everything.
func (p *corePair) flush() {
	for i := 0; i < 1000; i++ {
		for {
			data, fin, ok := p.src.Read(p.now)
			if !ok {
				break
			}
			p.srcGot, p.srcFin = append(p.srcGot, data...), p.srcFin || fin
		}
		for {
			data, fin, ok := p.tgt.Read(p.now)
			if !ok {
				break
			}
			p.tgtGot, p.tgtFin = append(p.tgtGot, data...), p.tgtFin || fin
		}
		a, b := p.src.TakeOutputs(), p.tgt.TakeOutputs()
		if len(a) == 0 && len(b) == 0 {
			return
		}
		p.deliverOutputs(p.src, a, p.tgt)
		p.deliverOutputs(p.tgt, b, p.src)
	}
}

func (p *corePair) advance(d time.Duration) {
	p.now = p.now.Add(d)
	p.src.Tick(p.now)
	p.tgt.Tick(p.now)
	p.flush()
}

// resumeFrame makes the source start a resume on a fresh path and returns
// the RESUME record the target would read first.
func (p *corePair) resumeFrame(relay string) (*Path, *Path, Record) {
	srcPath := NewPath(nil, relay, MaxFrameBytes)
	if !p.src.BeginResume(srcPath, p.now) {
		p.t.Fatal("BeginResume refused")
	}
	var resume Record
	for _, out := range p.src.TakeOutputs() {
		if out.Path == srcPath {
			resume, _, _ = ParseRecord(out.Frame)
		}
	}
	tgtPath := NewPath(nil, relay, MaxFrameBytes)
	p.links[srcPath], p.links[tgtPath] = tgtPath, srcPath
	return srcPath, tgtPath, resume
}

func TestCoreExchangeAndClose(t *testing.T) {
	pair := newCorePair(t)
	if pair.src.State() != StateOpen {
		t.Fatalf("source %s", pair.src.State())
	}
	pair.src.Write([]byte("ping"), pair.now)
	pair.tgt.Write([]byte("pong"), pair.now)
	pair.flush()
	pair.src.CloseWrite(pair.now)
	pair.tgt.CloseWrite(pair.now)
	pair.flush()
	pair.advance(DelayedAck)
	if string(pair.srcGot) != "pong" || string(pair.tgtGot) != "ping" || !pair.srcFin || !pair.tgtFin {
		t.Fatalf("got %q %q fin %v %v", pair.srcGot, pair.tgtGot, pair.srcFin, pair.tgtFin)
	}
	if pair.src.State() != StateFinished || pair.tgt.State() != StateFinished {
		t.Fatalf("states %s %s", pair.src.State(), pair.tgt.State())
	}
}

func TestCorePlannedResumeMovesData(t *testing.T) {
	pair := newCorePair(t)
	pair.src.Write([]byte("abc"), pair.now)
	pair.flush()
	srcPath, tgtPath, resume := pair.resumeFrame("relay-b")
	// Data written during the migration waits for the new path.
	pair.src.Write([]byte("def"), pair.now)
	verdict := pair.tgt.AcceptResume(tgtPath, &resume, pair.now)
	if !verdict.Accepted {
		t.Fatalf("resume refused: %d", verdict.Reject)
	}
	pair.flush()
	if pair.src.Current() != srcPath || pair.src.State() != StateOpen {
		t.Fatalf("source did not move: %s", pair.src.State())
	}
	pair.tgt.Write([]byte("xyz"), pair.now)
	pair.flush()
	if string(pair.tgtGot) != "abcdef" || string(pair.srcGot) != "xyz" {
		t.Fatalf("got %q %q", pair.tgtGot, pair.srcGot)
	}
}

func TestCoreResumeSecurity(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(pair *corePair, record *Record, tgtPath **Path)
		reject byte
		reset  bool
	}{
		{"wrong key id", func(_ *corePair, r *Record, _ **Path) { r.KeyID = "v9" }, RejectUnauthorized, false},
		{"forged mac", func(_ *corePair, r *Record, _ **Path) { r.MAC[0] ^= 1 }, RejectUnauthorized, false},
		{"other relay", func(_ *corePair, _ *Record, p **Path) { *p = NewPath(nil, "relay-c", MaxFrameBytes) }, RejectUnauthorized, false},
		{"other session", func(_ *corePair, r *Record, _ **Path) { r.SessionID[0] ^= 1 }, RejectUnauthorized, false},
		{"revoked", func(pair *corePair, _ *Record, _ **Path) { pair.authErr = errors.New("gone") }, RejectUnauthorized, true},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			pair := newCorePair(t)
			_, tgtPath, resume := pair.resumeFrame("relay-b")
			item.mutate(pair, &resume, &tgtPath)
			verdict := pair.tgt.AcceptResume(tgtPath, &resume, pair.now)
			if verdict.Accepted || verdict.Reject != item.reject {
				t.Fatalf("verdict %+v", verdict)
			}
			if (pair.tgt.State() == StateReset) != item.reset {
				t.Fatalf("target state %s", pair.tgt.State())
			}
		})
	}
}

func TestCoreReplayedResumeIsStale(t *testing.T) {
	pair := newCorePair(t)
	_, tgtPath, resume := pair.resumeFrame("relay-b")
	if !pair.tgt.AcceptResume(tgtPath, &resume, pair.now).Accepted {
		t.Fatal("first resume refused")
	}
	pair.flush()
	replay := NewPath(nil, "relay-b", MaxFrameBytes)
	if verdict := pair.tgt.AcceptResume(replay, &resume, pair.now); verdict.Reject != RejectStaleEpoch {
		t.Fatalf("replay verdict %+v", verdict)
	}
	if pair.tgt.State() != StateOpen {
		t.Fatalf("a replay disturbed the session: %s", pair.tgt.State())
	}
}

func TestCoreRestartedTargetNonce(t *testing.T) {
	pair := newCorePair(t)
	_, tgtPath, resume := pair.resumeFrame("relay-b")
	// A restarted target has another nonce: the MAC does not verify.
	other := *pair.tgt
	other.nonce = [16]byte{1}
	other.out = nil
	if verdict := other.AcceptResume(tgtPath, &resume, pair.now); verdict.Reject != RejectUnauthorized {
		t.Fatalf("verdict %+v", verdict)
	}
}

func TestCoreLegacyTargetDetected(t *testing.T) {
	srcPath := NewPath(nil, "relay-a", MaxFrameBytes)
	now := time.Unix(1, 0)
	src := NewSource(Config{RouteID: "r", KeyID: "v1", Key: make([]byte, KeyLen)}, srcPath, now)
	src.TakeOutputs()
	src.PathFrame(srcPath, []byte("HTTP/1.1 400 Bad Request\r\n"), now)
	if src.State() != StateReset || !errors.Is(src.Err(), ErrLegacyPeer) {
		t.Fatalf("state %s err %v", src.State(), src.Err())
	}
}

func TestCorePathFailureBeforeHelloAckIsNotResumable(t *testing.T) {
	srcPath := NewPath(nil, "relay-a", MaxFrameBytes)
	now := time.Unix(1, 0)
	src := NewSource(Config{RouteID: "r", KeyID: "v1", Key: make([]byte, KeyLen)}, srcPath, now)
	src.PathFailed(srcPath, false, nil, now)
	if !errors.Is(src.Err(), ErrNotResumable) {
		t.Fatalf("err %v", src.Err())
	}
}

func TestCoreTerminalPathEndsStream(t *testing.T) {
	pair := newCorePair(t)
	pair.src.PathFailed(pair.src.Current(), true, errors.New("idle"), pair.now)
	if pair.src.State() != StateReset {
		t.Fatalf("state %s", pair.src.State())
	}
}

func TestCoreSuspendTimeouts(t *testing.T) {
	pair := newCorePair(t)
	pair.src.PathFailed(pair.src.Current(), false, nil, pair.now)
	pair.tgt.PathFailed(pair.tgt.Current(), false, nil, pair.now)
	if !pair.src.NeedsPath() || pair.tgt.State() != StateSuspended {
		t.Fatalf("states %s %s", pair.src.State(), pair.tgt.State())
	}
	pair.advance(UnplannedBudget)
	if !errors.Is(pair.src.Err(), ErrSuspendTimeout) || pair.tgt.State() != StateSuspended {
		t.Fatalf("after 55 s: %v %s", pair.src.Err(), pair.tgt.State())
	}
	pair.advance(TargetSuspendTimeout - UnplannedBudget)
	if !errors.Is(pair.tgt.Err(), ErrSuspendTimeout) {
		t.Fatalf("after 60 s: %v", pair.tgt.Err())
	}
}

func TestCoreWindowBlocksAndGrows(t *testing.T) {
	budget := NewWindowBudget(0)
	pair := newCorePair(t)
	pair.src.cfg.Budget = budget
	chunk := make([]byte, 32*1024)
	fill := func() {
		for pair.src.CanWrite(len(chunk)) {
			if ok, _ := pair.src.Write(chunk, pair.now); !ok {
				t.Fatal("refused after CanWrite")
			}
			if pair.src.Unacked() > pair.src.Window() {
				t.Fatalf("unacked %d over window %d", pair.src.Unacked(), pair.src.Window())
			}
		}
	}
	// A pipe with a round trip: the sender refills the window after every
	// ack, so it stays window-blocked while acks keep coming.
	for round := 0; round < 200; round++ {
		fill()
		pair.deliverOutputs(pair.src, pair.src.TakeOutputs(), pair.tgt)
		for {
			if _, _, ok := pair.tgt.Read(pair.now); !ok {
				break
			}
		}
		for _, ack := range pair.tgt.TakeOutputs() {
			pair.deliverOutputs(pair.tgt, []Output{ack}, pair.src)
			fill()
		}
	}
	if pair.src.Window() <= InitialWindow {
		t.Fatalf("window did not grow: %d", pair.src.Window())
	}
	if pair.src.Window() > MaxExtendedWindow || budget.Used() != int64(pair.src.Window()-InitialWindow) {
		t.Fatalf("window %d, budget used %d", pair.src.Window(), budget.Used())
	}
	if !pair.src.PeerExtended() || pair.src.Window() <= MaxWindow {
		t.Fatalf("between two sessions with the window extension the window stays at %d", pair.src.Window())
	}
}

// windowPipe runs a window-blocked bulk upload over a pair for rounds round
// trips of rtt each; a peer that hides the window extension announces even
// windows, as every release before it did.
func windowPipe(t *testing.T, pair *corePair, rounds int, rtt time.Duration, legacyPeer bool) {
	t.Helper()
	chunk := make([]byte, 32*1024)
	fill := func() {
		for pair.src.CanWrite(len(chunk)) {
			if ok, _ := pair.src.Write(chunk, pair.now); !ok {
				t.Fatal("refused after CanWrite")
			}
		}
	}
	legacy := func(outputs []Output) []Output {
		if !legacyPeer {
			return outputs
		}
		for i, out := range outputs {
			if record, rest, err := ParseRecord(out.Frame); err == nil && record.Type == TypeAck && len(rest) == 0 {
				outputs[i].Frame = AppendAck(nil, record.Ack, record.Wnd&^WindowExtension)
			}
		}
		return outputs
	}
	for round := 0; round < rounds; round++ {
		fill()
		pair.now = pair.now.Add(rtt / 2)
		pair.deliverOutputs(pair.src, pair.src.TakeOutputs(), pair.tgt)
		for {
			if _, _, ok := pair.tgt.Read(pair.now); !ok {
				break
			}
		}
		pair.now = pair.now.Add(rtt / 2)
		for _, ack := range legacy(pair.tgt.TakeOutputs()) {
			pair.deliverOutputs(pair.tgt, []Output{ack}, pair.src)
			fill()
		}
		if pair.src.Unacked() > pair.src.EffectiveWindow()+uint64(len(chunk)) {
			t.Fatalf("unacked %d over the window %d", pair.src.Unacked(), pair.src.EffectiveWindow())
		}
	}
}

// A peer before the window extension (even windows) never gets more than
// MaxWindow: it resets a stream that queues more than 2*(MaxWindow+MaxFrameBytes).
func TestCoreWindowStaysWithinMaxWindowForALegacyPeer(t *testing.T) {
	pair := newCorePair(t)
	// The legacy peer's HELLO_ACK: even.
	pair.src.peerExtended = false
	windowPipe(t, pair, 300, 40*time.Millisecond, true)
	if pair.src.PeerExtended() || pair.src.Window() != MaxWindow || pair.src.EffectiveWindow() != MaxWindow {
		t.Fatalf("window %d (effective %d, extended peer %v)", pair.src.Window(), pair.src.EffectiveWindow(), pair.src.PeerExtended())
	}
}

// The window grows past MaxWindow on a long round trip up to
// MaxExtendedWindow, and not while the round trip says the bytes only queue
// (the bandwidth-delay product stays below the window).
func TestCoreWindowGrowsOnlyWhileTheRoundTripHolds(t *testing.T) {
	pair := newCorePair(t)
	windowPipe(t, pair, 120, 300*time.Millisecond, false)
	if pair.src.Window() != MaxExtendedWindow {
		t.Fatalf("on a 300 ms round trip the window reached %d", pair.src.Window())
	}
	queued := newCorePair(t)
	windowPipe(t, queued, 40, 20*time.Millisecond, false)
	before := queued.src.Window()
	// From now on every round trip is 10x the shortest one.
	windowPipe(t, queued, 60, 200*time.Millisecond, false)
	if queued.src.Window() > max(before, MaxWindow) {
		t.Fatalf("the window grew from %d to %d while the round trip said it queues", before, queued.src.Window())
	}
}
