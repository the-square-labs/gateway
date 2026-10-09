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

// slowPeerPipe runs a window-blocked bulk upload over a pair whose path has
// round trips of rtt, but whose peer socket takes at most perRound bytes per
// round trip: what the window sends beyond that only waits in the peer's
// queue, and the round trip the window measures grows with it.
func slowPeerPipe(t *testing.T, pair *corePair, rounds int, rtt time.Duration, perRound int) {
	t.Helper()
	chunk := make([]byte, 32*1024)
	fill := func() {
		for pair.src.CanWrite(len(chunk)) {
			if ok, _ := pair.src.Write(chunk, pair.now); !ok {
				t.Fatal("refused after CanWrite")
			}
		}
	}
	for round := 0; round < rounds; round++ {
		fill()
		pair.now = pair.now.Add(rtt / 2)
		pair.deliverOutputs(pair.src, pair.src.TakeOutputs(), pair.tgt)
		for read := 0; read < perRound; {
			data, _, ok := pair.tgt.Read(pair.now)
			if !ok {
				break
			}
			read += len(data)
		}
		pair.now = pair.now.Add(rtt / 2)
		pair.tgt.Tick(pair.now)
		for _, ack := range pair.tgt.TakeOutputs() {
			pair.deliverOutputs(pair.tgt, []Output{ack}, pair.src)
			fill()
		}
	}
}

// appPipe runs an upload whose writer sends at most perRound bytes per round
// trip of rtt (a LAN transfer: the path carries it faster than the window
// would limit).
func appPipe(t *testing.T, pair *corePair, rounds int, rtt time.Duration, perRound int) {
	t.Helper()
	chunk := make([]byte, 32*1024)
	for round := 0; round < rounds; round++ {
		for sent := 0; sent < perRound && pair.src.CanWrite(len(chunk)); sent += len(chunk) {
			if ok, _ := pair.src.Write(chunk, pair.now); !ok {
				t.Fatal("refused after CanWrite")
			}
		}
		pair.now = pair.now.Add(rtt / 2)
		pair.deliverOutputs(pair.src, pair.src.TakeOutputs(), pair.tgt)
		for {
			if _, _, ok := pair.tgt.Read(pair.now); !ok {
				break
			}
		}
		pair.now = pair.now.Add(rtt / 2)
		pair.tgt.Tick(pair.now)
		pair.deliverOutputs(pair.tgt, pair.tgt.TakeOutputs(), pair.src)
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
	// The peer's socket takes 256 KiB per 20 ms round trip: the round trip
	// grows only with what waits in its queue, and the window stays within
	// MaxWindow.
	queued := newCorePair(t)
	slowPeerPipe(t, queued, 400, 20*time.Millisecond, 256*1024)
	if queued.src.Window() > MaxWindow {
		t.Fatalf("the window grew to %d while the round trip said it queues", queued.src.Window())
	}
	if queued.tgt.Queued() == 0 {
		t.Fatal("the peer's queue is empty")
	}
}

// A stream whose path's round trip grows (a relay leg's route got longer)
// takes the window the longer path needs, as a stream opened there would:
// stand rc.7 F-5, the window grew only while it was below twice a
// bandwidth-delay product scaled to the LAN round trip of before.
func TestCoreWindowFollowsALongerPath(t *testing.T) {
	pair := newCorePair(t)
	// A LAN transfer: 512 KiB per 1 ms round trip, never window-blocked.
	appPipe(t, pair, 200, time.Millisecond, 512*1024)
	if pair.src.Window() > MaxWindow {
		t.Fatalf("a LAN transfer grew the window to %d", pair.src.Window())
	}
	windowPipe(t, pair, 120, 300*time.Millisecond, false)
	if pair.src.Window() != MaxExtendedWindow {
		t.Fatalf("after the round trip grew from 1 to 300 ms the window reached %d", pair.src.Window())
	}
}

// refusedMove brings a pair to a planned move the target refuses because it
// reset the stream meanwhile: the source sent a request and its FIN, the
// target answered and then reset (its local connection ended abruptly). The
// target's last records (ack, answer, RST) wait on the old path, which the
// refusal on the new path overtook. It returns them and the source's old path.
func refusedMove(t *testing.T) (*corePair, *Path, []Output) {
	pair := newCorePair(t)
	old := pair.src.Current()
	pair.src.Write([]byte("request"), pair.now)
	pair.src.CloseWrite(pair.now)
	pair.deliverOutputs(pair.src, pair.src.TakeOutputs(), pair.tgt)
	for {
		if _, fin, ok := pair.tgt.Read(pair.now); !ok || fin {
			break
		}
	}
	pair.tgt.Write([]byte("answer"), pair.now)
	pair.tgt.Abort(RstLocal, "backend connection reset", nil)
	held := pair.tgt.TakeOutputs()
	_, tgtPath, resume := pair.resumeFrame("relay-b")
	if verdict := pair.tgt.AcceptResume(tgtPath, &resume, pair.now); verdict.Accepted || verdict.Reject != RejectReset {
		t.Fatalf("verdict %+v", verdict)
	}
	pair.deliverOutputs(pair.tgt, pair.tgt.TakeOutputs(), pair.src)
	return pair, old, held
}

// A stream the target reset while it moved ends as the peer's reset, as it
// would have on its old path, not as a stream that could not move (stand rc.6
// O-3: short sessions that ended during a move counted as cuts).
func TestCoreRefusedMoveHearsOutTheOldPath(t *testing.T) {
	pair, old, held := refusedMove(t)
	if pair.src.State() != StateOpen || pair.src.Current() != old {
		t.Fatalf("source ended at the refusal: %s %v", pair.src.State(), pair.src.Err())
	}
	if pair.src.CanResume() {
		t.Fatal("a refused stream tries to move again")
	}
	pair.deliverOutputs(pair.tgt, held, pair.src)
	var reset *ResetError
	if pair.src.State() != StateReset || !errors.As(pair.src.Err(), &reset) || !reset.Remote || isCut(pair.src.Err()) {
		t.Fatalf("source %s err %v", pair.src.State(), pair.src.Err())
	}
}

// Without a word on the old path (it ends, or nothing arrives in time) the
// refusal stands: the stream could not move.
func TestCoreRefusedMoveWithoutWordIsCut(t *testing.T) {
	t.Run("old path ends", func(t *testing.T) {
		pair, old, _ := refusedMove(t)
		pair.src.PathFailed(old, false, nil, pair.now)
		var reset *ResetError
		if !errors.As(pair.src.Err(), &reset) || reset.Reject != RejectReset || !isCut(pair.src.Err()) {
			t.Fatalf("err %v", pair.src.Err())
		}
	})
	t.Run("nothing in time", func(t *testing.T) {
		pair, _, _ := refusedMove(t)
		if next := pair.src.NextDeadline(); next.IsZero() || next.After(pair.now.Add(ResumeAckTimeout)) {
			t.Fatalf("next deadline %v", next)
		}
		pair.advance(ResumeAckTimeout)
		if !isCut(pair.src.Err()) {
			t.Fatalf("err %v", pair.src.Err())
		}
	})
}

// A stream whose both directions were complete when its resume was refused
// (its CLOSE was lost with the path) finished: nothing was lost.
func TestCoreRefusedAfterBothFinsFinishes(t *testing.T) {
	for _, code := range []byte{RejectUnknown, RejectFinished, RejectReset} {
		pair := newCorePair(t)
		pair.src.Write([]byte("request"), pair.now)
		pair.src.CloseWrite(pair.now)
		pair.tgt.Write([]byte("answer"), pair.now)
		pair.tgt.CloseWrite(pair.now)
		// Everything but the CLOSE exchange gets through.
		for i := 0; i < 10; i++ {
			for {
				if _, _, ok := pair.src.Read(pair.now); !ok {
					break
				}
			}
			for {
				if _, _, ok := pair.tgt.Read(pair.now); !ok {
					break
				}
			}
			var toTarget []Output
			for _, out := range pair.src.TakeOutputs() {
				if out.Frame == nil || out.Frame[0] != TypeClose {
					toTarget = append(toTarget, out)
				}
			}
			pair.deliverOutputs(pair.src, toTarget, pair.tgt)
			pair.deliverOutputs(pair.tgt, pair.tgt.TakeOutputs(), pair.src)
		}
		if !pair.src.Done() {
			t.Fatal("source not done")
		}
		pair.src.PathFailed(pair.src.Current(), false, nil, pair.now)
		srcPath := NewPath(nil, "relay-b", MaxFrameBytes)
		if !pair.src.BeginResume(srcPath, pair.now) {
			t.Fatal("BeginResume refused")
		}
		pair.src.TakeOutputs()
		pair.src.PathFrame(srcPath, mustRecord(&Record{Type: TypeResumeRej, SessionID: pair.src.SessionID(), Code: code}), pair.now)
		if pair.src.State() != StateFinished || pair.src.Err() != nil {
			t.Fatalf("code %d: source %s err %v", code, pair.src.State(), pair.src.Err())
		}
	}
}

// The source takes the window extension from the target's HELLO_ACK, as the
// TS port and the protocol notes do, and a target before the extension (an
// even window) keeps it within MaxWindow.
func TestCoreSourceTakesTheExtensionFromHelloAck(t *testing.T) {
	for _, extended := range []bool{true, false} {
		key := bytes.Repeat([]byte{7}, KeyLen)
		now := time.Unix(1_700_000_000, 0)
		srcPath := NewPath(nil, "relay-a", MaxFrameBytes)
		src := NewSource(Config{RouteID: "route-1", KeyID: "v1", Key: key, SessionID: [16]byte{1, 2, 3}}, srcPath, now)
		out := src.TakeOutputs()
		hello, rest, err := ParseRecord(out[0].Frame)
		if err != nil {
			t.Fatal(err)
		}
		tgtPath := NewPath(nil, "relay-a", MaxFrameBytes)
		tgt := NewTarget(Config{RouteID: "route-1", Keys: func(string) []byte { return key }, TargetNonce: [16]byte{9},
			Authorize: func() error { return nil }}, tgtPath, &hello, hello.KeyID, key, rest, now)
		var ack Record
		for _, output := range tgt.TakeOutputs() {
			if record, _, err := ParseRecord(output.Frame); err == nil && record.Type == TypeHelloAck {
				ack = record
			}
		}
		if ack.Wnd&WindowExtension == 0 {
			t.Fatalf("HELLO_ACK window %d without the extension bit", ack.Wnd)
		}
		if !extended {
			ack.Wnd &^= WindowExtension
			ack.MAC = ComputeMAC(key, tgtPath.mac.HelloAckTranscript(ack.Nonce, ack.Wnd))
		}
		src.PathFrame(srcPath, mustRecord(&ack), now)
		if src.State() != StateOpen || src.PeerExtended() != extended {
			t.Fatalf("extended HELLO_ACK %v: source %s, extended peer %v", extended, src.State(), src.PeerExtended())
		}
	}
}

// A stream read out during a refused planned move carries the refusal: the
// next process, which has no old path to hear out (the target's RST went to
// the process that handed it over), ends it as the target's reset, not as a
// cut, and never tries to move it.
func TestCoreRefusalCarriedOverAHandoverIsThePeersReset(t *testing.T) {
	pair, _, _ := refusedMove(t)
	st := pair.src.exportState()
	if st.Refused != RejectReset {
		t.Fatalf("exported refusal %d", st.Refused)
	}
	st.MaxFrame = MaxFrameBytes
	parsed, err := ParseSessionState(AppendSessionState(nil, &st))
	if err != nil || parsed.Refused != RejectReset {
		t.Fatalf("parsed %v: %+v", err, parsed)
	}
	next, err := restoreCore(Config{}, parsed, pair.now)
	if err != nil {
		t.Fatal(err)
	}
	if next.CanResume() {
		t.Fatal("the next process tries to move a stream the target reset")
	}
	if deadline := next.NextDeadline(); deadline.After(pair.now) {
		t.Fatalf("next deadline %v", deadline)
	}
	next.Tick(pair.now)
	var reset *ResetError
	if next.State() != StateReset || !errors.As(next.Err(), &reset) || !reset.Remote || isCut(next.Err()) {
		t.Fatalf("next process: %s err %v", next.State(), next.Err())
	}
	// A refusal is only a source's, and only a reset's.
	for _, bad := range []SessionState{{Role: RoleTarget, Refused: RejectReset}, {Role: RoleSource, Refused: RejectUnknown}} {
		candidate := *parsed
		candidate.Role, candidate.Refused = bad.Role, bad.Refused
		if candidate.Role == RoleTarget {
			candidate.SourceKind, candidate.SourceID = "daemon", "node-1"
		}
		if candidate.Validate() == nil {
			t.Fatalf("refusal %d for role %d validated", bad.Refused, bad.Role)
		}
	}
}
