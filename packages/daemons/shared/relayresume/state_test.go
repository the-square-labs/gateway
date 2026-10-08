package relayresume

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protowire"
)

// stateFixture sets every field of a SessionState (golden vector of format
// version 1).
func stateFixture() *SessionState {
	return &SessionState{
		Role: RoleTarget, RouteID: "route-1", SessionID: [SessionIDLen]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16},
		TargetNonce: [NonceLen]byte{16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1}, KeyID: "v7", Epoch: 3,
		SourceKind: "daemon", SourceID: "node-1",
		SndUna: 100, SndNxt: 106, FinQueued: true, FinOff: 105, Unacked: []byte("hello"), Window: 2 * MinWindow, PeerDelivered: 90,
		RcvNxt: 50, Delivered: 40, AckSent: 38, PeerWindow: InitialWindow, Queued: []byte("0123456789"), Unwritten: []byte("abc"),
		MaxFrame: 64 * 1024, HalfCloseTimeout: 30 * time.Second, Retransmitted: 12, Migrations: 2,
		FrozenAt: time.UnixMilli(1_790_000_000_123),
	}
}

// The encoding of version 1 is frozen: the release before and the release
// after this one read it (a rolled back binary takes over what the candidate
// did not). The golden file was written once; never regenerate it for a
// change that is not a pure addition of fields.
func TestSessionStateGoldenV1(t *testing.T) {
	path := filepath.Join("testdata", "session-state-v1.bin")
	encoded := AppendSessionState(nil, stateFixture())
	if os.Getenv("RELAYRESUME_WRITE_GOLDEN") == "1" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, encoded, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	golden, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(encoded, golden) {
		t.Fatal("the version 1 encoding of a stream state changed")
	}
	decoded, err := ParseSessionState(golden)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decoded, stateFixture()) {
		t.Fatalf("decoded %+v", decoded)
	}
}

// A later release adds fields: this one skips them (it reads the next
// release's states).
func TestSessionStateSkipsUnknownFields(t *testing.T) {
	encoded := AppendSessionState(nil, stateFixture())
	encoded = protowire.AppendTag(encoded, 99, protowire.BytesType)
	encoded = protowire.AppendBytes(encoded, []byte("a later field"))
	encoded = protowire.AppendTag(encoded, 100, protowire.VarintType)
	encoded = protowire.AppendVarint(encoded, 7)
	decoded, err := ParseSessionState(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(decoded, stateFixture()) {
		t.Fatalf("decoded %+v", decoded)
	}
}

func TestSessionStateRejectsInconsistentStates(t *testing.T) {
	cases := map[string]func(*SessionState){
		"unacked bytes":   func(st *SessionState) { st.Unacked = st.Unacked[1:] },
		"queued bytes":    func(st *SessionState) { st.Queued = append(st.Queued, 'x') },
		"fin not last":    func(st *SessionState) { st.FinOff = 103 },
		"receive offsets": func(st *SessionState) { st.Delivered = st.RcvNxt + 1 },
		"no source":       func(st *SessionState) { st.SourceID = "" },
		"unwritten":       func(st *SessionState) { st.Unwritten = make([]byte, 41) },
		"peer delivered":  func(st *SessionState) { st.PeerDelivered = st.SndNxt + 1 },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			st := stateFixture()
			mutate(st)
			if _, err := ParseSessionState(AppendSessionState(nil, st)); err == nil {
				t.Fatal("accepted")
			}
		})
	}
	encoded := AppendSessionState(nil, stateFixture())
	wrongType := protowire.AppendTag(nil, stateFieldRouteID, protowire.VarintType)
	wrongType = protowire.AppendVarint(wrongType, 1)
	if _, err := ParseSessionState(append(encoded, wrongType...)); err == nil {
		t.Fatal("accepted a known field of the wrong type")
	}
}

// A stream read out of one process and restored in another carries on from
// exactly where it stopped: the bytes the peer still had to deliver, the bytes
// it retained for retransmission and the ones queued for the local socket.
func TestCoreHandoverCarriesTheStreamOn(t *testing.T) {
	pair := newCorePair(t)
	pair.src.Write([]byte("abc"), pair.now)
	pair.tgt.Write([]byte("xyz"), pair.now)
	pair.flush()
	// Bytes in flight both ways that nobody delivered or acked yet: the
	// target's are queued at the source, the source's at the target...
	if ok, err := pair.src.Write([]byte("source-unacked"), pair.now); !ok || err != nil {
		t.Fatal(ok, err)
	}
	if ok, err := pair.tgt.Write([]byte("target-unacked"), pair.now); !ok || err != nil {
		t.Fatal(ok, err)
	}
	for _, out := range pair.tgt.TakeOutputs() {
		pair.src.PathFrame(pair.links[out.Path], out.Frame, pair.now)
	}
	_ = pair.src.TakeOutputs() // ...and the source's never arrive (the path dies with the process)
	srcState, tgtState := pair.src.exportState(), pair.tgt.exportState()
	tgtState.SourceKind, tgtState.SourceID = "daemon", "node-1"
	srcState.MaxFrame, tgtState.MaxFrame = MaxFrameBytes, MaxFrameBytes
	for _, st := range []*SessionState{&srcState, &tgtState} {
		decoded, err := ParseSessionState(AppendSessionState(nil, st))
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(decoded, st) {
			t.Fatalf("round trip %+v != %+v", decoded, st)
		}
	}
	src, err := restoreCore(Config{}, &srcState, pair.now)
	if err != nil {
		t.Fatal(err)
	}
	src.SetKey("v1", pair.key)
	tgt, err := restoreCore(Config{Keys: pair.keys, Authorize: func() error { return nil }}, &tgtState, pair.now)
	if err != nil {
		t.Fatal(err)
	}
	if again := src.exportState(); !reflect.DeepEqual(again.Unacked, srcState.Unacked) || again.SndUna != srcState.SndUna ||
		again.RcvNxt != srcState.RcvNxt || !bytes.Equal(again.Queued, srcState.Queued) {
		t.Fatalf("restored source differs: %+v", again)
	}
	pair.src, pair.tgt = src, tgt
	pair.srcGot, pair.tgtGot = nil, nil
	_, tgtPath, resume := pair.resumeFrame("relay-b")
	if verdict := pair.tgt.AcceptResume(tgtPath, &resume, pair.now); !verdict.Accepted {
		t.Fatalf("resume refused: %d", verdict.Reject)
	}
	pair.flush()
	if string(pair.tgtGot) != "source-unacked" || string(pair.srcGot) != "target-unacked" {
		t.Fatalf("after the handover: %q %q", pair.tgtGot, pair.srcGot)
	}
	pair.src.CloseWrite(pair.now)
	pair.tgt.CloseWrite(pair.now)
	pair.flush()
	pair.advance(DelayedAck)
	if pair.src.State() != StateFinished || pair.tgt.State() != StateFinished {
		t.Fatalf("states %s %s", pair.src.State(), pair.tgt.State())
	}
}

// A resume frees the bytes the peer received, which it still holds for a slow
// local socket: the window counts from what the peer delivered, so a stream
// resumed again and again never piles more than a window up at the peer.
func TestCoreWindowCountsFromPeerDelivered(t *testing.T) {
	pair := newCorePair(t)
	chunk := bytes.Repeat([]byte{1}, 16*1024)
	fill := func() {
		for pair.src.CanWrite(len(chunk)) {
			if ok, err := pair.src.Write(chunk, pair.now); !ok || err != nil {
				t.Fatal(ok, err)
			}
			for _, out := range pair.src.TakeOutputs() {
				pair.tgt.PathFrame(pair.links[out.Path], out.Frame, pair.now)
			}
			for _, out := range pair.tgt.TakeOutputs() {
				pair.src.PathFrame(pair.links[out.Path], out.Frame, pair.now)
			}
		}
	}
	fill() // the target's socket reads nothing
	for round := 0; round < 3; round++ {
		_, tgtPath, resume := pair.resumeFrame("relay-" + string(rune('b'+round)))
		if !pair.tgt.AcceptResume(tgtPath, &resume, pair.now).Accepted {
			t.Fatal("resume refused")
		}
		for i := 0; i < 4; i++ {
			for _, out := range pair.tgt.TakeOutputs() {
				pair.src.PathFrame(pair.links[out.Path], out.Frame, pair.now)
			}
			for _, out := range pair.src.TakeOutputs() {
				pair.tgt.PathFrame(pair.links[out.Path], out.Frame, pair.now)
			}
		}
		fill()
	}
	if queued := pair.tgt.Queued(); queued > pair.src.Window()+uint64(len(chunk)) {
		t.Fatalf("the peer holds %d bytes for its socket, the window is %d", queued, pair.src.Window())
	}
}

// A peer that predates the ack after a resume sends none until it delivers
// more: without it the window counts from what the peer received again.
func TestCoreWindowFallsBackWithoutPeerAck(t *testing.T) {
	pair := newCorePair(t)
	chunk := bytes.Repeat([]byte{1}, 16*1024)
	for pair.src.CanWrite(len(chunk)) {
		if ok, err := pair.src.Write(chunk, pair.now); !ok || err != nil {
			t.Fatal(ok, err)
		}
		for _, out := range pair.src.TakeOutputs() {
			pair.tgt.PathFrame(pair.links[out.Path], out.Frame, pair.now)
		}
		// The target delivers everything; its acks are lost with the path.
		for {
			if _, _, ok := pair.tgt.Read(pair.now); !ok {
				break
			}
		}
		_ = pair.tgt.TakeOutputs()
	}
	srcPath, tgtPath, resume := pair.resumeFrame("relay-b")
	if !pair.tgt.AcceptResume(tgtPath, &resume, pair.now).Accepted {
		t.Fatal("resume refused")
	}
	for _, out := range pair.tgt.TakeOutputs() {
		if record, _, _ := ParseRecord(out.Frame); out.Path == tgtPath && record.Type == TypeResumeAck {
			pair.src.PathFrame(srcPath, out.Frame, pair.now) // the ACK behind it never comes
		}
	}
	if pair.src.State() != StateOpen || pair.src.CanWrite(len(chunk)) {
		t.Fatalf("the window counts from the received offset at once (%s)", pair.src.State())
	}
	pair.now = pair.now.Add(resumeAckFallback)
	pair.src.Tick(pair.now)
	if !pair.src.CanWrite(len(chunk)) {
		t.Fatal("the window did not fall back")
	}
}
