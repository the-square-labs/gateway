package relayresume

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

// Role is the side of a session: the source opens tunnels, the target
// accepts them.
type Role uint8

const (
	RoleSource Role = 1
	RoleTarget Role = 2
)

// State is a session's state.
type State uint8

const (
	// StateHandshake: the source sent HELLO and has no HELLO_ACK yet. Data
	// flows (0-RTT) but the session cannot resume.
	StateHandshake State = iota + 1
	// StateOpen: one current path carries both directions.
	StateOpen
	// StateSuspended: no path; the source looks for one, the target waits.
	StateSuspended
	// StateResuming: the source sent RESUME on a new path and waits for the
	// answer. A planned migration keeps receiving on the old path meanwhile.
	StateResuming
	// StateFinished: both directions ended and were acknowledged.
	StateFinished
	// StateReset: the stream ended abnormally.
	StateReset
)

func (s State) String() string {
	switch s {
	case StateHandshake:
		return "handshake"
	case StateOpen:
		return "open"
	case StateSuspended:
		return "suspended"
	case StateResuming:
		return "resuming"
	case StateFinished:
		return "finished"
	case StateReset:
		return "reset"
	}
	return "unknown"
}

// Terminal reports a finished or reset session.
func (s State) Terminal() bool { return s == StateFinished || s == StateReset }

var (
	ErrProtocol       = errors.New("relayresume: protocol violation")
	ErrLegacyPeer     = errors.New("relayresume: peer is not resume-aware")
	ErrNotResumable   = errors.New("relayresume: path failed before the stream could resume")
	ErrSuspendTimeout = errors.New("relayresume: no path came back in time")
	ErrAborted        = errors.New("relayresume: stream aborted")
	ErrRevoked        = errors.New("relayresume: route is no longer authorized")
	ErrHalfCloseIdle  = errors.New("relayresume: half-closed stream idle")
	ErrWriteClosed    = errors.New("relayresume: write after close")
)

// ResetError ends a stream abnormally.
type ResetError struct {
	Code   byte   // RST code (sent or received)
	Reason string // free text
	Remote bool   // the peer reset the stream
	Reject byte   // RESUME_REJ code that ended the stream, if any
	Err    error  // cause class (ErrProtocol, ErrLegacyPeer, ...)
}

func (e *ResetError) Error() string {
	side := "local"
	if e.Remote {
		side = "peer"
	}
	if e.Reject != 0 {
		return fmt.Sprintf("relayresume: resume rejected (code %d)", e.Reject)
	}
	if e.Reason != "" {
		return fmt.Sprintf("relayresume: %s reset (code %d): %s", side, e.Code, e.Reason)
	}
	return fmt.Sprintf("relayresume: %s reset (code %d)", side, e.Code)
}

func (e *ResetError) Unwrap() error { return e.Err }

// Path is the session's view of one relay tunnel stream.
type Path struct {
	// Handle belongs to the driver (the gRPC stream).
	Handle any

	relayID    string
	maxPayload int
	mac        PathContext

	sendCursor uint64 // next outbound offset to transmit on this path
	recvCursor uint64 // offset of the next inbound byte on this path

	established bool // carries data both ways
	rxOnly      bool // source: old path during a planned resume
	closed      bool
	awaiting    byte // first inbound record expected: TypeHelloAck or TypeResumeAck
	epoch       uint64
	resumeFrom  uint64 // the rcv_nxt this side sent in RESUME
	closeSent   bool   // source: CLOSE sent on this path
	deadline    time.Time
}

// NewPath describes a tunnel through relayID whose Ready frame allowed
// maxFrame bytes per Data frame.
func NewPath(handle any, relayID string, maxFrame int) *Path {
	if maxFrame <= 0 || maxFrame > MaxFrameBytes {
		maxFrame = MaxFrameBytes
	}
	return &Path{Handle: handle, relayID: relayID, maxPayload: maxFrame - MaxRecordHeader}
}

// RelayID is the relay instance the path runs through.
func (p *Path) RelayID() string { return p.relayID }

// Closed reports a path the session gave up.
func (p *Path) Closed() bool { return p.closed }

// Output is one action for the driver, in order: send Frame on Path, or
// close Path when Close is set.
type Output struct {
	Path  *Path
	Frame []byte
	Close bool
	// Pooled: once the frame was handed to the transport (which copies
	// it), the driver may return it with ReleaseFrame.
	Pooled bool
}

// pooledFrameCap fits a 32 KiB read plus its DATA header: the common frame
// is built without a large allocation.
const pooledFrameCap = 32*1024 + MaxRecordHeader

var framePool = sync.Pool{New: func() any {
	buffer := make([]byte, 0, pooledFrameCap)
	return &buffer
}}

// ReleaseFrame returns a pooled frame after the transport copied it.
func ReleaseFrame(frame []byte) {
	if cap(frame) == pooledFrameCap {
		frame = frame[:0]
		framePool.Put(&frame)
	}
}

type segment struct {
	off  uint64
	data []byte
}

type chunk struct {
	data []byte
}

// Keys returns the route key for a key id, nil when unknown (target side).
type Keys func(keyID string) []byte

// Config configures a session core.
type Config struct {
	Role    Role
	RouteID string
	// Source: the key named in HELLO and RESUME.
	KeyID string
	Key   []byte
	// Target: current and previous route keys, read on every resume.
	Keys Keys
	// Target: per-process nonce.
	TargetNonce [NonceLen]byte
	// Source: the session id (random).
	SessionID [SessionIDLen]byte
	// Target: rechecked on every resume; an error refuses the resume and
	// resets the stream.
	Authorize func() error
	// Source: reset a stream whose peer finished sending and that saw no
	// traffic for this long (proxy routes). 0: never.
	HalfCloseTimeout time.Duration
	// Budget for window growth; nil: unbounded.
	Budget *WindowBudget
	// Window is the initial send window; 0: InitialWindow.
	Window int
}

// Core is the sans-IO session state machine. It is not safe for concurrent
// use: the driver serialises every call.
type Core struct {
	cfg   Config
	state State
	err   error

	sessionID [SessionIDLen]byte
	nonce     [NonceLen]byte
	keyID     string
	key       []byte
	epoch     uint64

	cur     *Path
	old     *Path // source: rx-only during a planned resume
	pending *Path // source: RESUME in flight

	// Send side: [sndUna, sndNxt) is retained; FIN takes one unit.
	sndUna, sndNxt uint64
	segs           []segment
	segHead        int
	finQueued      bool
	finOff         uint64
	wnd            uint64
	reserved       uint64
	blocked        bool
	ackedBlocked   uint64

	// Receive side: [delivered, rcvNxt) is queued for the local socket.
	rcvNxt, delivered, ackSent uint64
	rq                         []chunk
	rqHead                     int
	peerWnd                    uint64
	peerFin                    bool
	peerFinOff                 uint64
	finDelivered               bool
	closeRecv                  bool

	ackDue           time.Time
	suspendDeadline  time.Time
	lingerDeadline   time.Time
	handshakeDeadine time.Time
	lastActivity     time.Time

	migrateReq byte
	out        []Output

	// Statistics.
	Retransmitted uint64
	Migrations    uint64
	AcksSent      uint64 // standalone ACK records
	AcksDelayed   uint64 // of which the delayed-ack timer sent
	WindowBlocks  uint64 // writes that found the window full
}

// NewSource creates a source session and sends HELLO on its first path.
func NewSource(cfg Config, path *Path, now time.Time) *Core {
	cfg.Role = RoleSource
	c := newCore(cfg, now)
	c.sessionID = cfg.SessionID
	c.keyID, c.key = cfg.KeyID, cfg.Key
	c.state = StateHandshake
	c.handshakeDeadine = now.Add(HelloAckTimeout)
	c.cur = path
	c.bindPath(path)
	path.established = true
	path.awaiting = TypeHelloAck
	hello := Record{Type: TypeHello, KeyID: c.keyID, SessionID: c.sessionID, Wnd: c.wnd}
	hello.MAC = ComputeMAC(c.key, path.mac.HelloTranscript(c.wnd))
	path.mac.HelloMAC = hello.MAC
	c.emitRecord(path, &hello)
	return c
}

// NewTarget creates a target session from a verified HELLO received on path
// (see VerifyHello) and answers HELLO_ACK. rest holds the records that
// followed HELLO in its frame.
func NewTarget(cfg Config, path *Path, hello *Record, keyID string, key []byte, rest []byte, now time.Time) *Core {
	cfg.Role = RoleTarget
	c := newCore(cfg, now)
	c.sessionID = hello.SessionID
	c.nonce = cfg.TargetNonce
	c.keyID, c.key = keyID, key
	c.peerWnd = clampPeerWindow(hello.Wnd)
	c.state = StateOpen
	c.cur = path
	c.bindPath(path)
	path.established = true
	path.mac.HelloMAC = hello.MAC
	ack := Record{Type: TypeHelloAck, SessionID: c.sessionID, Nonce: c.nonce, Wnd: c.wnd}
	ack.MAC = ComputeMAC(key, path.mac.HelloAckTranscript(c.nonce, c.wnd))
	c.emitRecord(path, &ack)
	if len(rest) > 0 {
		c.records(path, rest, now)
	}
	return c
}

func newCore(cfg Config, now time.Time) *Core {
	c := &Core{cfg: cfg, lastActivity: now, peerWnd: InitialWindow}
	wnd := uint64(cfg.Window)
	if wnd == 0 {
		wnd = initialWindow
	}
	wnd = max(wnd, MinWindow)
	wnd = min(wnd, MaxWindow)
	if wnd > MinWindow && cfg.Budget != nil && !cfg.Budget.reserve(wnd-MinWindow) {
		wnd = MinWindow
	}
	c.wnd = wnd
	c.reserved = wnd - MinWindow
	return c
}

func (c *Core) bindPath(path *Path) {
	path.mac = PathContext{RouteID: c.cfg.RouteID, RelayID: path.relayID, KeyID: c.keyID, Key: c.key, SessionID: c.sessionID, TargetNonce: c.nonce}
}

// SetKey replaces the key the source signs its next RESUME with (route key
// rotation: the latest bundle's key, not the one HELLO used).
func (c *Core) SetKey(keyID string, key []byte) {
	if c.cfg.Role == RoleSource && validKeyID(keyID) && len(key) > 0 {
		c.keyID, c.key = keyID, key
	}
}

// State is the session state.
func (c *Core) State() State { return c.state }

// Err is why a reset session ended (nil otherwise).
func (c *Core) Err() error { return c.err }

// Role is the session's side.
func (c *Core) Role() Role { return c.cfg.Role }

// SessionID is the session id.
func (c *Core) SessionID() [SessionIDLen]byte { return c.sessionID }

// Epoch is the current resume epoch.
func (c *Core) Epoch() uint64 { return c.epoch }

// Current is the path carrying data (nil while suspended or resuming).
func (c *Core) Current() *Path { return c.cur }

// Pending is the source's resume attempt in flight.
func (c *Core) Pending() *Path { return c.pending }

// Old is the source's rx-only path during a planned resume.
func (c *Core) Old() *Path { return c.old }

// Window is the current send window.
func (c *Core) Window() uint64 { return c.wnd }

// Unacked is the number of retained offset units.
func (c *Core) Unacked() uint64 { return c.sndNxt - c.sndUna }

// Queued is the number of received bytes not yet handed to the local socket.
func (c *Core) Queued() uint64 { return c.rcvNxt - c.delivered }

// Offsets reports the stream positions (tests and telemetry).
func (c *Core) Offsets() (sndUna, sndNxt, rcvNxt, delivered uint64) {
	return c.sndUna, c.sndNxt, c.rcvNxt, c.delivered
}

// TakeOutputs returns and clears the pending outputs.
func (c *Core) TakeOutputs() []Output {
	out := c.out
	c.out = nil
	return out
}

// HasOutputs reports pending outputs.
func (c *Core) HasOutputs() bool { return len(c.out) > 0 }

// TakeMigrateRequest returns a MIGRATE_REQ reason the target sent (source).
func (c *Core) TakeMigrateRequest() (byte, bool) {
	reason := c.migrateReq
	c.migrateReq = 0
	return reason, reason != 0
}

// CanResume reports a source session that can start a resume attempt now.
func (c *Core) CanResume() bool {
	return c.cfg.Role == RoleSource && c.pending == nil && (c.state == StateOpen || c.state == StateSuspended) &&
		!c.closeEchoDone()
}

// NeedsPath reports a suspended source session.
func (c *Core) NeedsPath() bool {
	return c.cfg.Role == RoleSource && c.state == StateSuspended
}

func (c *Core) closeEchoDone() bool { return c.state == StateFinished }

// CanWrite reports whether Write would accept n bytes now (or fail). A
// false answer marks the sender window-blocked (window autotuning).
func (c *Core) CanWrite(n int) bool {
	if c.state.Terminal() || c.finQueued {
		return true // Write reports the error
	}
	inflight := c.sndNxt - c.sndUna
	if inflight == 0 || inflight+uint64(n) <= c.wnd {
		return true
	}
	c.blocked = true
	c.WindowBlocks++
	return false
}

// Write queues p (owned by the session from now on) for the peer. It
// reports false when the window is full; the caller waits for Writable.
func (c *Core) Write(p []byte, now time.Time) (bool, error) {
	if c.state.Terminal() {
		return false, c.terminalErr()
	}
	if c.finQueued {
		return false, ErrWriteClosed
	}
	if len(p) == 0 {
		return true, nil
	}
	inflight := c.sndNxt - c.sndUna
	if inflight > 0 && inflight+uint64(len(p)) > c.wnd {
		c.blocked = true
		return false, nil
	}
	if inflight < c.wnd/2 {
		c.blocked, c.ackedBlocked = false, 0
	}
	c.segs = append(c.segs, segment{off: c.sndNxt, data: p})
	c.sndNxt += uint64(len(p))
	c.lastActivity = now
	c.pump()
	return true, nil
}

// CloseWrite ends the local -> peer direction (FIN).
func (c *Core) CloseWrite(now time.Time) error {
	if c.state.Terminal() {
		return c.terminalErr()
	}
	if c.finQueued {
		return nil
	}
	c.finQueued = true
	c.finOff = c.sndNxt
	c.sndNxt++
	c.lastActivity = now
	c.pump()
	c.checkFinish(now)
	return nil
}

// Readable reports data or the peer's FIN waiting for the local socket.
func (c *Core) Readable() bool {
	return c.rqHead < len(c.rq) || (c.peerFin && !c.finDelivered && c.delivered == c.peerFinOff)
}

// Read hands the next received chunk to the local socket: data, or fin once
// every byte before the peer's FIN was read. The chunk counts as delivered.
func (c *Core) Read(now time.Time) (data []byte, fin bool, ok bool) {
	if c.state == StateReset {
		return nil, false, false
	}
	if c.rqHead < len(c.rq) {
		data = c.rq[c.rqHead].data
		c.rq[c.rqHead] = chunk{}
		c.rqHead++
		if c.rqHead == len(c.rq) {
			c.rq, c.rqHead = c.rq[:0], 0
		}
		c.delivered += uint64(len(data))
		c.afterDeliver(now)
		return data, false, true
	}
	if c.peerFin && !c.finDelivered && c.delivered == c.peerFinOff {
		c.finDelivered = true
		c.delivered++
		c.afterDeliver(now)
		c.checkFinish(now)
		return nil, true, true
	}
	return nil, false, false
}

// FinDelivered reports that the peer's FIN reached the local socket.
func (c *Core) FinDelivered() bool { return c.finDelivered }

// Done reports a stream that needs nothing more from the peer: both FINs
// are complete (the CLOSE exchange may still be running).
func (c *Core) Done() bool { return c.ourFinAcked() && c.finDelivered }

func (c *Core) ourFinAcked() bool { return c.finQueued && c.sndUna == c.finOff+1 }

func (c *Core) afterDeliver(now time.Time) {
	unacked := c.delivered - c.ackSent
	if unacked == 0 {
		return
	}
	threshold := max(c.peerWnd/4, 1)
	if unacked >= threshold || c.finDelivered {
		c.sendAck(false)
		return
	}
	if c.ackDue.IsZero() {
		c.ackDue = now.Add(DelayedAck)
	}
}

func (c *Core) canSendOn(p *Path) bool {
	return p != nil && p == c.cur && p.established && !p.closed && (c.state == StateOpen || c.state == StateHandshake)
}

func (c *Core) sendAck(announceWindow bool) {
	if !c.canSendOn(c.cur) {
		return
	}
	if c.delivered == c.ackSent && !announceWindow {
		return
	}
	c.out = append(c.out, Output{Path: c.cur, Frame: AppendAck(nil, c.delivered, c.wnd)})
	c.AcksSent++
	c.ackSent = c.delivered
	c.ackDue = time.Time{}
}

// pump transmits [cursor, sndNxt) on the current path.
func (c *Core) pump() {
	p := c.cur
	if !c.canSendOn(p) {
		return
	}
	for p.sendCursor < c.sndNxt {
		if c.finQueued && p.sendCursor == c.finOff {
			c.out = append(c.out, Output{Path: p, Frame: AppendFin(nil, c.delivered)})
			c.ackSent, c.ackDue = c.delivered, time.Time{}
			p.sendCursor++
			continue
		}
		seg := c.segmentAt(p.sendCursor)
		data := seg.data[p.sendCursor-seg.off:]
		if len(data) > p.maxPayload {
			data = data[:p.maxPayload]
		}
		size := 1 + uvarintLen(c.delivered) + len(data)
		var frame []byte
		pooled := size <= pooledFrameCap
		if pooled {
			frame = (*framePool.Get().(*[]byte))[:0]
		} else {
			frame = make([]byte, 0, size)
		}
		frame = AppendDataHeader(frame, c.delivered)
		frame = append(frame, data...)
		c.out = append(c.out, Output{Path: p, Frame: frame, Pooled: pooled})
		c.ackSent, c.ackDue = c.delivered, time.Time{}
		p.sendCursor += uint64(len(data))
	}
}

// segmentAt finds the retained segment holding offset (sndUna <= offset <
// data end). Transmission is almost always at the tail.
func (c *Core) segmentAt(offset uint64) *segment {
	for i := len(c.segs) - 1; i >= c.segHead; i-- {
		if c.segs[i].off <= offset {
			return &c.segs[i]
		}
	}
	panic("relayresume: offset below the retained data")
}

func (c *Core) emitRecord(p *Path, record *Record) {
	frame, err := AppendRecord(nil, record)
	if err != nil {
		panic(err)
	}
	c.out = append(c.out, Output{Path: p, Frame: frame})
}

// PathFrame processes one TunnelData payload received on path.
func (c *Core) PathFrame(p *Path, frame []byte, now time.Time) {
	if p.closed || c.state.Terminal() {
		return
	}
	if p.awaiting != 0 {
		record, rest, err := ParseRecord(frame)
		switch p.awaiting {
		case TypeHelloAck:
			if err != nil || record.Type != TypeHelloAck {
				c.reset(RstLegacyPeer, "first record is not HELLO_ACK", ErrLegacyPeer)
				return
			}
			if record.SessionID != c.sessionID || !VerifyMAC(c.key, p.mac.HelloAckTranscript(record.Nonce, record.Wnd), record.MAC) {
				c.reset(RstProtocol, "HELLO_ACK does not verify", ErrProtocol)
				return
			}
			c.nonce = record.Nonce
			p.mac.TargetNonce = record.Nonce
			c.peerWnd = clampPeerWindow(record.Wnd)
			p.awaiting = 0
			c.handshakeDeadine = time.Time{}
			c.state = StateOpen
		case TypeResumeAck:
			if err != nil {
				c.attemptFailed(p, now)
				return
			}
			if !c.resumeAnswer(p, &record, now) {
				return
			}
		}
		frame = rest
		if len(frame) == 0 {
			c.pump()
			c.checkFinish(now)
			return
		}
	}
	c.records(p, frame, now)
}

func (c *Core) records(p *Path, frame []byte, now time.Time) {
	for len(frame) > 0 {
		record, rest, err := ParseRecord(frame)
		if err != nil {
			c.reset(RstProtocol, "malformed record", ErrProtocol)
			return
		}
		frame = rest
		switch record.Type {
		case TypeData:
			if !c.ack(record.Ack) || !c.data(p, record.Payload, now) {
				return
			}
		case TypeAck:
			if !c.ack(record.Ack) {
				return
			}
			c.peerWnd = clampPeerWindow(record.Wnd)
		case TypeFin:
			if !c.ack(record.Ack) || !c.fin(p) {
				return
			}
		case TypeRst:
			c.peerReset(record.Code, string(record.Reason))
			return
		case TypeClose:
			if !c.closeRecord(p, now) {
				return
			}
		case TypeMigrateReq:
			if c.cfg.Role != RoleSource {
				c.reset(RstProtocol, "MIGRATE_REQ from a source", ErrProtocol)
				return
			}
			c.migrateReq = record.Code
			if c.migrateReq == 0 {
				c.migrateReq = MigrateDrain
			}
		default:
			c.reset(RstProtocol, "handshake record mid-stream", ErrProtocol)
			return
		}
		if c.state.Terminal() {
			return
		}
	}
	c.pump()
	c.checkFinish(now)
}

// ack processes a cumulative ack (the peer's delivered offset).
func (c *Core) ack(ack uint64) bool {
	if ack > c.sndNxt {
		c.reset(RstProtocol, "ack beyond sent data", ErrProtocol)
		return false
	}
	c.advanceUna(ack)
	return true
}

func (c *Core) advanceUna(ack uint64) {
	if ack <= c.sndUna {
		return
	}
	delta := ack - c.sndUna
	c.sndUna = ack
	for c.segHead < len(c.segs) {
		seg := &c.segs[c.segHead]
		if seg.off+uint64(len(seg.data)) > ack {
			break
		}
		*seg = segment{}
		c.segHead++
	}
	if c.segHead == len(c.segs) {
		c.segs, c.segHead = c.segs[:0], 0
	} else if c.segHead > 64 && c.segHead*2 > len(c.segs) {
		n := copy(c.segs, c.segs[c.segHead:])
		clear(c.segs[n:])
		c.segs, c.segHead = c.segs[:n], 0
	}
	if c.blocked {
		c.ackedBlocked += delta
		if c.ackedBlocked >= 2*c.wnd && c.wnd < MaxWindow {
			grow := min(c.wnd, MaxWindow-c.wnd)
			if c.cfg.Budget == nil || c.cfg.Budget.reserve(grow) {
				c.wnd += grow
				c.reserved += grow
				c.sendAck(true)
			}
			c.ackedBlocked = 0
		}
	}
}

func (c *Core) data(p *Path, payload []byte, now time.Time) bool {
	off := p.recvCursor
	n := uint64(len(payload))
	p.recvCursor += n
	if c.peerFin && off+n > c.peerFinOff {
		c.reset(RstProtocol, "data after FIN", ErrProtocol)
		return false
	}
	if off+n <= c.rcvNxt {
		return true // duplicate
	}
	if off > c.rcvNxt {
		c.reset(RstProtocol, "data beyond the receive offset", ErrProtocol)
		return false
	}
	skip := c.rcvNxt - off
	c.rq = append(c.rq, chunk{data: payload[skip:]})
	c.rcvNxt += n - skip
	c.lastActivity = now
	if c.rcvNxt-c.delivered > 2*(MaxWindow+MaxFrameBytes) {
		c.reset(RstWindowViolation, "peer exceeded its window", ErrProtocol)
		return false
	}
	return true
}

func (c *Core) fin(p *Path) bool {
	off := p.recvCursor
	p.recvCursor++
	if c.peerFin {
		if off != c.peerFinOff {
			c.reset(RstProtocol, "second FIN", ErrProtocol)
			return false
		}
		return true
	}
	if off != c.rcvNxt {
		c.reset(RstProtocol, "FIN out of order", ErrProtocol)
		return false
	}
	c.peerFin = true
	c.peerFinOff = off
	c.rcvNxt = off + 1
	return true
}

func (c *Core) closeRecord(p *Path, now time.Time) bool {
	if c.cfg.Role == RoleSource {
		if !c.Done() {
			c.reset(RstProtocol, "CLOSE before both FINs", ErrProtocol)
			return false
		}
		c.finish()
		return false
	}
	// The source saw both FINs complete. RESUME_ACK may have acked the
	// source's FIN before the local socket read it: echo now, let the path
	// go, and finish once the local socket has everything.
	if !c.ourFinAcked() || !c.peerFin {
		c.reset(RstProtocol, "CLOSE before both FINs", ErrProtocol)
		return false
	}
	c.closeRecv = true
	c.emitRecord(p, &Record{Type: TypeClose})
	for _, path := range []*Path{c.cur, p} {
		if path != nil && !path.closed {
			path.closed = true
			c.out = append(c.out, Output{Path: path, Close: true})
		}
	}
	c.cur = nil
	c.checkFinish(now)
	return false
}

func (c *Core) checkFinish(now time.Time) {
	if c.cfg.Role == RoleTarget {
		if c.closeRecv && c.Done() {
			c.finish()
		}
		return
	}
	if c.state != StateOpen || !c.Done() || c.cur == nil || c.cur.closeSent {
		return
	}
	c.sendAck(false)
	c.emitRecord(c.cur, &Record{Type: TypeClose})
	c.cur.closeSent = true
	c.lingerDeadline = now.Add(CloseLingerTimeout)
}

func (c *Core) finish() {
	c.state = StateFinished
	c.closeAll()
}

func (c *Core) closeAll() {
	for _, p := range []*Path{c.cur, c.old, c.pending} {
		if p != nil && !p.closed {
			p.closed = true
			c.out = append(c.out, Output{Path: p, Close: true})
		}
	}
	c.ackDue, c.suspendDeadline, c.lingerDeadline, c.handshakeDeadine = time.Time{}, time.Time{}, time.Time{}, time.Time{}
	c.rq, c.rqHead = nil, 0
	c.segs, c.segHead = nil, 0
	if c.reserved > 0 && c.cfg.Budget != nil {
		c.cfg.Budget.release(c.reserved)
	}
	c.reserved = 0
}

// reset ends the stream locally and tells the peer when a path is up.
func (c *Core) reset(code byte, reason string, cause error) {
	if c.state.Terminal() {
		return
	}
	if p := c.cur; p != nil && p.established && !p.closed {
		c.out = append(c.out, Output{Path: p, Frame: AppendRst(nil, code, reason)})
	}
	c.err = &ResetError{Code: code, Reason: reason, Err: cause}
	c.state = StateReset
	c.closeAll()
}

func (c *Core) peerReset(code byte, reason string) {
	c.err = &ResetError{Code: code, Reason: reason, Remote: true, Err: ErrAborted}
	c.state = StateReset
	c.closeAll()
}

func (c *Core) terminalErr() error {
	if c.err != nil {
		return c.err
	}
	return ErrWriteClosed
}

// Abort resets the stream (a local socket error, a shutdown, a revocation).
func (c *Core) Abort(code byte, reason string, cause error) {
	if cause == nil {
		cause = ErrAborted
	}
	c.reset(code, reason, cause)
}

// RequestMigrate sends MIGRATE_REQ on the current path (target).
func (c *Core) RequestMigrate(reason byte) {
	if c.cfg.Role != RoleTarget || !c.canSendOn(c.cur) {
		return
	}
	c.emitRecord(c.cur, &Record{Type: TypeMigrateReq, Code: reason})
}

// DropPath closes a path the session never used.
func (c *Core) DropPath(p *Path) {
	if !p.closed {
		p.closed = true
		c.out = append(c.out, Output{Path: p, Close: true})
	}
}

// PathFailed reports that path ended. terminal marks an end that must not be
// resumed (the relay's idle timeout).
func (c *Core) PathFailed(p *Path, terminal bool, cause error, now time.Time) {
	if p.closed {
		return
	}
	// The driver ends the stream too: a path that failed by a relay frame
	// (HalfClose, Close, Error) is still open at gRPC level, and the relay
	// holds the tunnel until it is cancelled.
	p.closed = true
	c.out = append(c.out, Output{Path: p, Close: true})
	if c.state.Terminal() {
		return
	}
	if terminal && (p == c.cur || p == c.old) {
		if cause == nil {
			cause = ErrNotResumable
		}
		c.err = &ResetError{Code: RstAborted, Reason: "relay ended the stream", Err: cause}
		c.state = StateReset
		c.closeAll()
		return
	}
	switch p {
	case c.pending:
		c.attemptFailed(p, now)
	case c.old:
		c.old = nil
	case c.cur:
		c.cur = nil
		if c.state == StateHandshake {
			c.err = &ResetError{Code: RstAborted, Reason: "path failed before HELLO_ACK", Err: ErrNotResumable}
			c.state = StateReset
			c.closeAll()
			return
		}
		c.suspend(now)
	}
}

func (c *Core) suspend(now time.Time) {
	if c.state == StateOpen {
		c.state = StateSuspended
	}
	if c.suspendDeadline.IsZero() {
		timeout := TargetSuspendTimeout
		if c.cfg.Role == RoleSource {
			timeout = UnplannedBudget
		}
		c.suspendDeadline = now.Add(timeout)
	}
	c.ackDue = time.Time{}
}

// attemptFailed gives up the resume attempt on p (source).
func (c *Core) attemptFailed(p *Path, now time.Time) {
	if !p.closed {
		p.closed = true
		c.out = append(c.out, Output{Path: p, Close: true})
	}
	if c.pending != p {
		return
	}
	c.pending = nil
	if c.old != nil && !c.old.closed {
		// Planned: stay on the old path.
		c.cur, c.old = c.old, nil
		c.cur.rxOnly = false
		c.state = StateOpen
		c.lastActivity = now
		c.pump()
		c.afterDeliver(now)
		c.checkFinish(now)
		return
	}
	c.old = nil
	c.state = StateSuspended
	c.suspend(now)
}

// BeginResume starts a resume attempt on a new path (source). With a current
// path (planned migration) the session stops sending on it and keeps
// receiving until the target answers.
func (c *Core) BeginResume(p *Path, now time.Time) bool {
	if !c.CanResume() {
		return false
	}
	c.bindPath(p)
	if c.cur != nil {
		c.old = c.cur
		c.old.rxOnly = true
		c.cur = nil
	}
	c.epoch++
	c.Migrations++
	p.epoch = c.epoch
	p.awaiting = TypeResumeAck
	p.resumeFrom = c.rcvNxt
	p.deadline = now.Add(ResumeAckTimeout)
	c.pending = p
	c.state = StateResuming
	c.ackDue = time.Time{}
	resume := Record{Type: TypeResume, SessionID: c.sessionID, Epoch: p.epoch, RcvNxt: p.resumeFrom, KeyID: c.keyID}
	resume.MAC = ComputeMAC(c.key, p.mac.ResumeTranscript(p.epoch, p.resumeFrom))
	p.mac.ResumeMAC = resume.MAC
	c.emitRecord(p, &resume)
	return true
}

// resumeAnswer handles the first record on a resume attempt (source).
func (c *Core) resumeAnswer(p *Path, record *Record, now time.Time) bool {
	if p != c.pending {
		return false
	}
	switch record.Type {
	case TypeResumeRej:
		if record.SessionID != c.sessionID {
			c.attemptFailed(p, now)
			return false
		}
		if record.Code == RejectFinished && c.Done() {
			c.finish()
			return false
		}
		if record.Code == RejectStaleEpoch {
			// Another RESUME with this epoch reached the target first (a
			// relay replayed or delayed one): try again with a higher epoch.
			c.attemptFailed(p, now)
			return false
		}
		c.err = &ResetError{Code: RstResumeRejected, Reject: record.Code, Err: ErrProtocol}
		c.state = StateReset
		c.closeAll()
		return false
	case TypeResumeAck:
	default:
		c.attemptFailed(p, now)
		return false
	}
	if record.SessionID != c.sessionID || record.Epoch != p.epoch || record.SendFrom != p.resumeFrom ||
		!VerifyMAC(p.mac.Key, p.mac.ResumeAckTranscript(record.Epoch, record.RcvNxt, record.SendFrom), record.MAC) {
		c.attemptFailed(p, now)
		return false
	}
	if record.RcvNxt < c.sndUna || record.RcvNxt > c.sndNxt {
		c.cur = p
		p.established, p.awaiting = true, 0
		c.pending = nil
		c.reset(RstProtocol, "resume offset outside the retained data", ErrProtocol)
		return false
	}
	if c.old != nil {
		c.old.closed = true
		c.out = append(c.out, Output{Path: c.old, Close: true})
		c.old = nil
	}
	c.pending = nil
	c.cur = p
	p.awaiting = 0
	p.established = true
	p.sendCursor = record.RcvNxt
	p.recvCursor = record.SendFrom
	c.Retransmitted += c.sndNxt - record.RcvNxt
	c.advanceUna(record.RcvNxt)
	c.state = StateOpen
	c.suspendDeadline = time.Time{}
	c.lastActivity = now
	// The target knows p.resumeFrom (RESUME.rcv_nxt); bytes and a FIN that
	// arrived on the old path after RESUME left still need an ack.
	c.ackSent, c.ackDue = min(c.delivered, p.resumeFrom), time.Time{}
	if c.delivered > c.ackSent {
		c.sendAck(false)
	}
	return true
}

// ResumeVerdict is the target's answer to a RESUME.
type ResumeVerdict struct {
	Accepted bool
	Reject   byte
}

// AcceptResume handles a RESUME (already parsed, its frame holding nothing
// else) on a new path (target). On acceptance the path becomes current: the
// old path is closed and RESUME_ACK plus the retransmission are queued. On
// refusal the RESUME_REJ is queued on p and p is closed.
func (c *Core) AcceptResume(p *Path, record *Record, now time.Time) ResumeVerdict {
	reject := func(code byte) ResumeVerdict {
		c.out = append(c.out, Output{Path: p, Frame: mustRecord(&Record{Type: TypeResumeRej, SessionID: record.SessionID, Code: code})})
		p.closed = true
		c.out = append(c.out, Output{Path: p, Close: true})
		return ResumeVerdict{Reject: code}
	}
	switch {
	case c.state == StateFinished || c.closeRecv:
		return reject(RejectFinished)
	case c.state == StateReset:
		return reject(RejectReset)
	}
	var key []byte
	if c.cfg.Keys != nil {
		key = c.cfg.Keys(record.KeyID)
	}
	if key == nil {
		return reject(RejectUnauthorized)
	}
	ctx := PathContext{RouteID: c.cfg.RouteID, RelayID: p.relayID, KeyID: record.KeyID, Key: key, SessionID: c.sessionID, TargetNonce: c.nonce}
	if record.SessionID != c.sessionID || !VerifyMAC(key, ctx.ResumeTranscript(record.Epoch, record.RcvNxt), record.MAC) {
		return reject(RejectUnauthorized)
	}
	if record.Epoch <= c.epoch {
		return reject(RejectStaleEpoch)
	}
	if c.cfg.Authorize != nil {
		if err := c.cfg.Authorize(); err != nil {
			verdict := reject(RejectUnauthorized)
			c.reset(RstRevoked, "route is no longer authorized", fmt.Errorf("%w: %v", ErrRevoked, err))
			return verdict
		}
	}
	if record.RcvNxt < c.sndUna {
		// A RESUME the source abandoned (its relay delivered it late): the
		// source has acknowledged more since, on the path it stayed on.
		return reject(RejectStaleEpoch)
	}
	if record.RcvNxt > c.sndNxt {
		verdict := reject(RejectReset)
		c.reset(RstProtocol, "resume offset outside the retained data", ErrProtocol)
		return verdict
	}
	if c.cur != nil && !c.cur.closed {
		c.cur.closed = true
		c.out = append(c.out, Output{Path: c.cur, Close: true})
	}
	c.keyID, c.key = record.KeyID, key
	ctx.ResumeMAC = record.MAC
	p.mac = ctx
	c.epoch = record.Epoch
	c.Migrations++
	// RESUME_ACK is the first record on the path: the source trusts nothing
	// before it (advanceUna may announce a grown window with an ACK).
	answer := Record{Type: TypeResumeAck, SessionID: c.sessionID, Epoch: record.Epoch, RcvNxt: c.rcvNxt, SendFrom: record.RcvNxt}
	answer.MAC = ComputeMAC(key, ctx.ResumeAckTranscript(answer.Epoch, answer.RcvNxt, answer.SendFrom))
	c.emitRecord(p, &answer)
	c.cur = p
	p.established = true
	p.sendCursor = record.RcvNxt
	p.recvCursor = c.rcvNxt
	c.Retransmitted += c.sndNxt - record.RcvNxt
	c.state = StateOpen
	c.suspendDeadline = time.Time{}
	c.advanceUna(record.RcvNxt)
	c.ackSent = c.delivered
	c.pump()
	c.afterDeliver(now)
	return ResumeVerdict{Accepted: true}
}

func mustRecord(record *Record) []byte {
	frame, err := AppendRecord(nil, record)
	if err != nil {
		panic(err)
	}
	return frame
}

// NextDeadline is the earliest timer the driver must call Tick for (zero:
// none).
func (c *Core) NextDeadline() time.Time {
	var next time.Time
	consider := func(t time.Time) {
		if !t.IsZero() && (next.IsZero() || t.Before(next)) {
			next = t
		}
	}
	if c.state.Terminal() {
		return next
	}
	consider(c.ackDue)
	consider(c.suspendDeadline)
	consider(c.lingerDeadline)
	consider(c.handshakeDeadine)
	if c.pending != nil {
		consider(c.pending.deadline)
	}
	if c.halfCloseArmed() {
		consider(c.lastActivity.Add(c.cfg.HalfCloseTimeout))
	}
	return next
}

// Tick runs the timers due at now.
func (c *Core) Tick(now time.Time) {
	if c.state.Terminal() {
		return
	}
	if !c.handshakeDeadine.IsZero() && !now.Before(c.handshakeDeadine) && c.state == StateHandshake {
		c.reset(RstLegacyPeer, "no HELLO_ACK", ErrLegacyPeer)
		return
	}
	if c.pending != nil && !now.Before(c.pending.deadline) {
		c.attemptFailed(c.pending, now)
	}
	if !c.suspendDeadline.IsZero() && !now.Before(c.suspendDeadline) && (c.state == StateSuspended || c.state == StateResuming) {
		if c.Done() {
			// Everything was delivered both ways; only the CLOSE exchange is missing.
			c.finish()
			return
		}
		c.reset(RstSuspendTimeout, "no path came back in time", ErrSuspendTimeout)
		return
	}
	if !c.lingerDeadline.IsZero() && !now.Before(c.lingerDeadline) && c.Done() {
		c.finish()
		return
	}
	if c.halfCloseArmed() && !now.Before(c.lastActivity.Add(c.cfg.HalfCloseTimeout)) {
		c.reset(RstHalfCloseIdle, "half-closed stream idle", ErrHalfCloseIdle)
		return
	}
	if !c.ackDue.IsZero() && !now.Before(c.ackDue) {
		c.ackDue = time.Time{}
		c.AcksDelayed++
		c.sendAck(false)
	}
}

// halfCloseArmed: the relay's half-close reaping, which only runs while a
// path is up (a suspended stream is not idle by choice).
func (c *Core) halfCloseArmed() bool {
	return c.cfg.HalfCloseTimeout > 0 && c.finDelivered && !c.Done() && c.state == StateOpen
}

// initialWindow is InitialWindow; benchmarks vary it.
var initialWindow uint64 = InitialWindow

func clampPeerWindow(wnd uint64) uint64 {
	return min(max(wnd, 1024), MaxWindow)
}
