package relayresume

import (
	"errors"
	"fmt"
	"time"

	"google.golang.org/protobuf/encoding/protowire"
)

// Live handover (LH): a daemon that exits for its update hands every resumable
// stream to its next process. The stream stops at a point where every byte is
// either in its session or in the local socket (Session.Freeze), its state is
// read out (Session.HandoverState) and the next process carries on with it
// (Manager.RestoreSource, TargetTable.Restore): for the peer, the update looks
// like the loss of the stream's path, which RESUME already covers. From the
// read-out on, the old process tells the peer nothing beyond that state (see
// Session.sealed) until it thaws or lets the stream go.
//
// SessionState is that state. It holds no key: the next process takes the
// route keys from its grant bundle. Its encoding (MarshalSessionState) is
// frozen at version 1 like the wire format: fields are only ever added, and a
// reader skips the fields it does not know, so the release before and the
// release after read each other's states (a rolled back binary takes over
// what the candidate it replaces did not).

// ErrNotHandoverable reports a stream that cannot be handed over now: its
// handshake did not complete (no target nonce yet), it ended, or it was
// handed over already.
var ErrNotHandoverable = errors.New("relayresume: stream cannot be handed over")

// ErrHandedOver is what a stream handed to another process answers from now on.
var ErrHandedOver = errors.New("relayresume: stream was handed over to another process")

// SessionState is a resumable stream as another process takes it over.
type SessionState struct {
	Role      Role
	RouteID   string
	SessionID [SessionIDLen]byte
	// TargetNonce is the nonce of the target process that answered HELLO; a
	// restored target keeps answering with it.
	TargetNonce [NonceLen]byte
	// KeyID is the key the stream last used (no key material).
	KeyID string
	Epoch uint64
	// Target: the relay-vouched source of the stream (TargetKey).
	SourceKind string
	SourceID   string

	// Send side: [SndUna, SndNxt) is retained, a FIN at FinOff takes one unit.
	// Unacked holds the data bytes of it.
	SndUna, SndNxt uint64
	FinQueued      bool
	FinOff         uint64
	Unacked        []byte
	// Window is this side's send window; PeerDelivered is where it counts
	// from (the peer's last ack).
	Window        uint64
	PeerDelivered uint64

	// Receive side: [Delivered, RcvNxt) was received and not handed to the
	// local socket; Queued holds its data bytes.
	RcvNxt, Delivered, AckSent uint64
	PeerWindow                 uint64
	PeerFin                    bool
	PeerFinOff                 uint64
	FinDelivered               bool
	// CloseRecv: the target echoed the source's CLOSE.
	CloseRecv bool
	Queued    []byte
	// Unwritten was handed to the bridge (it counts as delivered) and not
	// written to the local socket yet: it goes out before Queued.
	Unwritten []byte

	// MaxFrame is the Data size the bridges were given (Session.MaxFrame).
	MaxFrame int
	// Source: the half-close reaping of the route.
	HalfCloseTimeout time.Duration
	Retransmitted    uint64
	Migrations       uint64
	// FrozenAt is when the stream stopped carrying data: its pause, and the
	// budget to find a new path, start there.
	FrozenAt time.Time
}

// dataEnd is the offset after the last data byte sent.
func (st *SessionState) dataEnd() uint64 {
	if st.FinQueued {
		return st.FinOff
	}
	return st.SndNxt
}

// Validate checks that the offsets and the bytes of a state agree.
func (st *SessionState) Validate() error {
	invalid := func(format string, args ...any) error {
		return fmt.Errorf("relayresume: invalid stream state: "+format, args...)
	}
	switch {
	case st.Role != RoleSource && st.Role != RoleTarget:
		return invalid("role %d", st.Role)
	case st.RouteID == "":
		return invalid("no route")
	case !validKeyID(st.KeyID):
		return invalid("key id")
	case st.Role == RoleTarget && (st.SourceKind == "" || st.SourceID == ""):
		return invalid("target without its source")
	case st.SndUna > st.SndNxt || st.PeerDelivered > st.SndNxt:
		return invalid("send offsets")
	case st.FinQueued && st.FinOff+1 != st.SndNxt:
		return invalid("FIN is not the last unit sent")
	case st.FinQueued && st.SndUna > st.FinOff+1:
		return invalid("acked beyond the FIN")
	case st.Delivered > st.RcvNxt:
		return invalid("receive offsets")
	case uint64(len(st.Unwritten)) > st.Delivered:
		return invalid("unwritten bytes before the stream start")
	case st.MaxFrame <= 0 || st.MaxFrame > MaxFrameBytes:
		return invalid("frame size %d", st.MaxFrame)
	case st.Window < MinWindow || st.Window > MaxWindow:
		return invalid("window %d", st.Window)
	}
	unacked := uint64(0)
	if end := st.dataEnd(); st.SndUna < end {
		unacked = end - st.SndUna
	}
	if uint64(len(st.Unacked)) != unacked {
		return invalid("%d unacked bytes, offsets say %d", len(st.Unacked), unacked)
	}
	queued := st.RcvNxt - st.Delivered
	if st.PeerFin {
		if st.RcvNxt != st.PeerFinOff+1 {
			return invalid("peer FIN is not the last unit received")
		}
		if st.FinDelivered {
			if st.Delivered != st.RcvNxt || len(st.Queued) != 0 || len(st.Unwritten) != 0 {
				return invalid("bytes left after the delivered FIN")
			}
			queued = 0
		} else {
			queued = st.PeerFinOff - st.Delivered
		}
	} else if st.FinDelivered {
		return invalid("FIN delivered without one")
	}
	if uint64(len(st.Queued)) != queued {
		return invalid("%d queued bytes, offsets say %d", len(st.Queued), queued)
	}
	return nil
}

// exportState reads the core out (the caller holds the session).
func (c *Core) exportState() SessionState {
	st := SessionState{
		Role: c.cfg.Role, RouteID: c.cfg.RouteID, SessionID: c.sessionID, TargetNonce: c.nonce, KeyID: c.keyID, Epoch: c.epoch,
		SndUna: c.sndUna, SndNxt: c.sndNxt, FinQueued: c.finQueued, FinOff: c.finOff, Window: c.wnd, PeerDelivered: c.peerDelivered,
		RcvNxt: c.rcvNxt, Delivered: c.delivered, AckSent: c.ackSent, PeerWindow: c.peerWnd, PeerFin: c.peerFin,
		PeerFinOff: c.peerFinOff, FinDelivered: c.finDelivered, CloseRecv: c.closeRecv,
		HalfCloseTimeout: c.cfg.HalfCloseTimeout, Retransmitted: c.Retransmitted, Migrations: c.Migrations,
	}
	end := st.dataEnd()
	if c.sndUna < end {
		st.Unacked = make([]byte, 0, end-c.sndUna)
		for i := c.segHead; i < len(c.segs); i++ {
			seg := &c.segs[i]
			segEnd := seg.off + uint64(len(seg.data))
			start := max(seg.off, c.sndUna)
			if segEnd <= start {
				continue
			}
			st.Unacked = append(st.Unacked, seg.data[start-seg.off:]...)
		}
	}
	for i := c.rqHead; i < len(c.rq); i++ {
		st.Queued = append(st.Queued, c.rq[i].data...)
	}
	return st
}

// restoreCore is the core of a stream another process handed over: no path,
// suspended until the source resumes it.
func restoreCore(cfg Config, st *SessionState, now time.Time) (*Core, error) {
	if err := st.Validate(); err != nil {
		return nil, err
	}
	cfg.Role = st.Role
	cfg.RouteID = st.RouteID
	if cfg.Role == RoleSource {
		cfg.HalfCloseTimeout = st.HalfCloseTimeout
	}
	c := &Core{cfg: cfg, state: StateSuspended, lastActivity: now}
	wnd := st.Window
	if wnd > MinWindow && cfg.Budget != nil && !cfg.Budget.reserve(wnd-MinWindow) {
		// The window is this side's own pacing: a smaller one only makes the
		// next writes wait for acks.
		wnd = min(wnd, FallbackWindow)
		if wnd > MinWindow && !cfg.Budget.reserve(wnd-MinWindow) {
			wnd = MinWindow
		}
	}
	c.wnd, c.reserved = wnd, wnd-MinWindow
	c.sessionID, c.nonce, c.keyID, c.epoch = st.SessionID, st.TargetNonce, st.KeyID, st.Epoch
	c.sndUna, c.sndNxt, c.finQueued, c.finOff, c.peerDelivered = st.SndUna, st.SndNxt, st.FinQueued, st.FinOff, st.PeerDelivered
	if len(st.Unacked) > 0 {
		c.segs = []segment{{off: st.SndUna, data: append([]byte(nil), st.Unacked...)}}
	}
	c.rcvNxt, c.delivered, c.ackSent = st.RcvNxt, st.Delivered, min(st.AckSent, st.Delivered)
	c.peerWnd = clampPeerWindow(st.PeerWindow)
	c.peerFin, c.peerFinOff, c.finDelivered, c.closeRecv = st.PeerFin, st.PeerFinOff, st.FinDelivered, st.CloseRecv
	if len(st.Queued) > 0 {
		c.rq = []chunk{{data: append([]byte(nil), st.Queued...)}}
	}
	c.Retransmitted, c.Migrations = st.Retransmitted, st.Migrations
	frozen := st.FrozenAt
	if frozen.IsZero() || frozen.After(now) {
		frozen = now
	}
	timeout := TargetSuspendTimeout
	if cfg.Role == RoleSource {
		timeout = UnplannedBudget
	}
	c.suspendDeadline = frozen.Add(timeout)
	return c, nil
}

// SessionState field numbers (protobuf wire format, version 1). Never reuse
// or renumber one.
const (
	stateFieldRole             = 1
	stateFieldRouteID          = 2
	stateFieldSessionID        = 3
	stateFieldTargetNonce      = 4
	stateFieldKeyID            = 5
	stateFieldEpoch            = 6
	stateFieldSourceKind       = 7
	stateFieldSourceID         = 8
	stateFieldSndUna           = 9
	stateFieldSndNxt           = 10
	stateFieldFinQueued        = 11
	stateFieldFinOff           = 12
	stateFieldUnacked          = 13
	stateFieldWindow           = 14
	stateFieldRcvNxt           = 15
	stateFieldDelivered        = 16
	stateFieldAckSent          = 17
	stateFieldPeerWindow       = 18
	stateFieldPeerFin          = 19
	stateFieldPeerFinOff       = 20
	stateFieldFinDelivered     = 21
	stateFieldCloseRecv        = 22
	stateFieldQueued           = 23
	stateFieldUnwritten        = 24
	stateFieldMaxFrame         = 25
	stateFieldHalfCloseTimeout = 26 // milliseconds
	stateFieldRetransmitted    = 27
	stateFieldMigrations       = 28
	stateFieldFrozenAt         = 29 // unix milliseconds
	stateFieldPeerDelivered    = 30
)

// stateFieldKinds is the wire type of every known field.
var stateFieldKinds = func() map[protowire.Number]protowire.Type {
	kinds := map[protowire.Number]protowire.Type{}
	for field := protowire.Number(stateFieldRole); field <= stateFieldPeerDelivered; field++ {
		kinds[field] = protowire.VarintType
	}
	for _, field := range []protowire.Number{stateFieldRouteID, stateFieldSessionID, stateFieldTargetNonce, stateFieldKeyID,
		stateFieldSourceKind, stateFieldSourceID, stateFieldUnacked, stateFieldQueued, stateFieldUnwritten} {
		kinds[field] = protowire.BytesType
	}
	return kinds
}()

// AppendSessionState appends the encoding of st to buffer.
func AppendSessionState(buffer []byte, st *SessionState) []byte {
	varint := func(field protowire.Number, value uint64) {
		if value != 0 {
			buffer = protowire.AppendTag(buffer, field, protowire.VarintType)
			buffer = protowire.AppendVarint(buffer, value)
		}
	}
	boolean := func(field protowire.Number, value bool) {
		if value {
			varint(field, 1)
		}
	}
	bytes := func(field protowire.Number, value []byte) {
		if len(value) > 0 {
			buffer = protowire.AppendTag(buffer, field, protowire.BytesType)
			buffer = protowire.AppendBytes(buffer, value)
		}
	}
	varint(stateFieldRole, uint64(st.Role))
	bytes(stateFieldRouteID, []byte(st.RouteID))
	bytes(stateFieldSessionID, st.SessionID[:])
	if st.TargetNonce != ([NonceLen]byte{}) {
		bytes(stateFieldTargetNonce, st.TargetNonce[:])
	}
	bytes(stateFieldKeyID, []byte(st.KeyID))
	varint(stateFieldEpoch, st.Epoch)
	bytes(stateFieldSourceKind, []byte(st.SourceKind))
	bytes(stateFieldSourceID, []byte(st.SourceID))
	varint(stateFieldSndUna, st.SndUna)
	varint(stateFieldSndNxt, st.SndNxt)
	boolean(stateFieldFinQueued, st.FinQueued)
	varint(stateFieldFinOff, st.FinOff)
	bytes(stateFieldUnacked, st.Unacked)
	varint(stateFieldWindow, st.Window)
	varint(stateFieldRcvNxt, st.RcvNxt)
	varint(stateFieldDelivered, st.Delivered)
	varint(stateFieldAckSent, st.AckSent)
	varint(stateFieldPeerWindow, st.PeerWindow)
	boolean(stateFieldPeerFin, st.PeerFin)
	varint(stateFieldPeerFinOff, st.PeerFinOff)
	boolean(stateFieldFinDelivered, st.FinDelivered)
	boolean(stateFieldCloseRecv, st.CloseRecv)
	bytes(stateFieldQueued, st.Queued)
	bytes(stateFieldUnwritten, st.Unwritten)
	varint(stateFieldMaxFrame, uint64(st.MaxFrame))
	varint(stateFieldHalfCloseTimeout, uint64(st.HalfCloseTimeout.Milliseconds()))
	varint(stateFieldRetransmitted, st.Retransmitted)
	varint(stateFieldMigrations, st.Migrations)
	if !st.FrozenAt.IsZero() {
		varint(stateFieldFrozenAt, uint64(st.FrozenAt.UnixMilli()))
	}
	varint(stateFieldPeerDelivered, st.PeerDelivered)
	return buffer
}

// ParseSessionState decodes a state written by AppendSessionState, skipping
// the fields a later release added, and validates it. Byte fields alias data.
func ParseSessionState(data []byte) (*SessionState, error) {
	st := &SessionState{}
	malformed := errors.New("relayresume: malformed stream state")
	for len(data) > 0 {
		field, kind, n := protowire.ConsumeTag(data)
		if n < 0 {
			return nil, malformed
		}
		data = data[n:]
		var value uint64
		var raw []byte
		switch kind {
		case protowire.VarintType:
			value, n = protowire.ConsumeVarint(data)
		case protowire.BytesType:
			raw, n = protowire.ConsumeBytes(data)
		default:
			n = protowire.ConsumeFieldValue(field, kind, data)
		}
		if n < 0 {
			return nil, malformed
		}
		data = data[n:]
		if want, known := stateFieldKinds[field]; known && want != kind {
			return nil, malformed
		}
		fixed := func(target []byte) error {
			if kind != protowire.BytesType || len(raw) != len(target) {
				return malformed
			}
			copy(target, raw)
			return nil
		}
		var err error
		switch field {
		case stateFieldRole:
			st.Role = Role(value)
		case stateFieldRouteID:
			st.RouteID = string(raw)
		case stateFieldSessionID:
			err = fixed(st.SessionID[:])
		case stateFieldTargetNonce:
			err = fixed(st.TargetNonce[:])
		case stateFieldKeyID:
			st.KeyID = string(raw)
		case stateFieldEpoch:
			st.Epoch = value
		case stateFieldSourceKind:
			st.SourceKind = string(raw)
		case stateFieldSourceID:
			st.SourceID = string(raw)
		case stateFieldSndUna:
			st.SndUna = value
		case stateFieldSndNxt:
			st.SndNxt = value
		case stateFieldFinQueued:
			st.FinQueued = value != 0
		case stateFieldFinOff:
			st.FinOff = value
		case stateFieldUnacked:
			st.Unacked = raw
		case stateFieldWindow:
			st.Window = value
		case stateFieldRcvNxt:
			st.RcvNxt = value
		case stateFieldDelivered:
			st.Delivered = value
		case stateFieldAckSent:
			st.AckSent = value
		case stateFieldPeerWindow:
			st.PeerWindow = value
		case stateFieldPeerFin:
			st.PeerFin = value != 0
		case stateFieldPeerFinOff:
			st.PeerFinOff = value
		case stateFieldFinDelivered:
			st.FinDelivered = value != 0
		case stateFieldCloseRecv:
			st.CloseRecv = value != 0
		case stateFieldQueued:
			st.Queued = raw
		case stateFieldUnwritten:
			st.Unwritten = raw
		case stateFieldMaxFrame:
			if value > MaxFrameBytes {
				return nil, malformed
			}
			st.MaxFrame = int(value)
		case stateFieldHalfCloseTimeout:
			if value > uint64(time.Hour/time.Millisecond) {
				return nil, malformed
			}
			st.HalfCloseTimeout = time.Duration(value) * time.Millisecond
		case stateFieldRetransmitted:
			st.Retransmitted = value
		case stateFieldMigrations:
			st.Migrations = value
		case stateFieldFrozenAt:
			if value > 1<<62 {
				return nil, malformed
			}
			st.FrozenAt = time.UnixMilli(int64(value))
		case stateFieldPeerDelivered:
			st.PeerDelivered = value
		}
		if err != nil {
			return nil, err
		}
	}
	if err := st.Validate(); err != nil {
		return nil, err
	}
	return st, nil
}
