// Package relaylane decides when a relay lane's connection is replaced. A lane
// is one long-lived TCP connection, and TCP keeps what it learned of its path
// for the life of the connection: after a retransmission timeout, or after
// the lane's round trip grew far beyond the one it learned on, a transfer
// that starts on it ramps up in congestion avoidance from a few segments and
// takes tens of seconds to reach the rate a new connection reaches in a
// second (stand rc.8 F-1: GETs at 3-12 MB/s). The daemons rotate such a lane:
// they dial a new connection like it, send new tunnels there, move its
// resumable streams over with a planned move and let the rest finish on the
// old one.
package relaylane

import (
	"sync/atomic"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/connector"
	"github.com/wiolett-industries/gateway/daemon-shared/slowstart"
)

const (
	// Check is how often the lanes' TCP state is looked at.
	Check = 250 * time.Millisecond
	// Every bounds the rotations of one lane: a new connection per lane at
	// most this often. Back-to-back transfers on a lane that rotated within
	// it start on the state it learned since (accepted: a real path does not
	// change its round trip every minute).
	Every = 10 * time.Minute
	// EveryCheap is the shortest time between two rotations of one lane whose
	// rotation moves no stream that carries data (see MayRotate): Every
	// exists so streams are not moved over and over; replacing a connection
	// that moves nothing costs one dial (stand rc.9 F-4: a far60 first GET
	// held at 7.8 MB/s inside the 10 min).
	EveryCheap = 30 * time.Second
	// CheapQuiet and CheapBytes: a stream counts as moving nothing that
	// carried no byte for CheapQuiet, or fewer than CheapBytes in all (a
	// transfer that just started on the stale connection, which is what the
	// rotation is for).
	CheapQuiet = time.Second
	CheapBytes = 4 << 20
	// Spacing spaces the rotations of one relay's lanes: one at a time.
	Spacing = 2 * time.Second
	// DialTimeout bounds the dial of a replacement connection.
	DialTimeout = 15 * time.Second
	// BulkBytes is how much a lane carries within one Check for its round
	// trip to count as the one it learned its congestion state on.
	BulkBytes = 256 << 10
	// BusyBytes is how much a lane carries within one Check to count as
	// delivering (slowstart.BusyRate): such a lane is never rotated, whatever
	// its learned state or the relay says.
	BusyBytes uint64 = slowstart.BusyRate * uint64(Check) / uint64(time.Second)
	// IdleChecks is how many Checks in a row without bulk data make a lane
	// idle: its next transfer starts from what the lane learned (a slow start
	// up to its threshold), and a lane whose threshold is worth less than
	// slowstart.SlowRate at its path's round trip is rotated before it.
	IdleChecks = 4
	// RTTGrowth and RTTGrowthMin: a lane whose round trip under bulk data grew
	// this far beyond the one it learned on, at GrewChecks Checks in a row, is
	// rotated (one Check's round trip can be a queue on a busy host).
	RTTGrowth    = 4
	RTTGrowthMin = 10 * time.Millisecond
	GrewChecks   = 2
)

// Trigger is one lane connection's rotation trigger state. Hint is safe from
// any goroutine; Reason belongs to the rotation loop.
type Trigger struct {
	hinted atomic.Bool
	// bulkRTT is the shortest round trip seen while the lane carried bulk
	// data (0: none yet); lastSent and lastReceived the socket's byte counts
	// at the last look.
	bulkRTT                time.Duration
	lastSent, lastReceived uint64
	// minRTT is the shortest smoothed round trip the lane's socket showed at
	// any look (0: none yet): the round trip a lane that never carried bulk
	// data learned its state on.
	minRTT time.Duration
	// idle counts the Checks in a row without bulk data (up to IdleChecks),
	// grew those in a row whose round trip under bulk data grew.
	idle, grew int
	looked     bool
}

// NoteHeader takes a tunnel's response header: the relay says its sending
// side of the lane collapsed (connector.LaneRenewHeader).
func (t *Trigger) NoteHeader(header map[string][]string) {
	if len(header[connector.LaneRenewHeader]) > 0 {
		t.hinted.Store(true)
	}
}

// ClearHint forgets the relay's word (the lane may not rotate yet).
func (t *Trigger) ClearHint() { t.hinted.Store(false) }

// Reason decides from a lane's TCP state, looked at every Check, whether it
// is rotated ("" if not). A lane that delivers BusyBytes per Check is never
// rotated: it delivers, whatever it learned (stand rc.9: LAN lanes to the
// local relay rotated as "collapsed" after an ordinary loss while moving 110
// MB/s). Otherwise a lane is rotated when
//   - the relay said its sending side went stale (relay_collapsed);
//   - it is idle and its own sending side is stale at its path's round trip
//     (collapsed: the next transfer would start slow);
//   - its sending side carries bulk data under a threshold worth less than
//     slowstart.SlowRate (slow_threshold);
//   - its round trip under bulk data grew far beyond the one it learned on
//     (the shortest round trip it carried bulk at, or, before any, the
//     shortest it showed at all) at GrewChecks looks in a row
//     (round_trip_grew).
//
// The round trip is read where bulk data flows: the sender's smoothed round
// trip while the lane sends bulk, the receiver's estimate while it receives
// bulk (the acks it sends meanwhile are small writes whose round trip the
// peer's delayed acks inflate).
func (t *Trigger) Reason(state slowstart.State, known bool) string {
	if !known {
		if t.hinted.Load() {
			return "relay_collapsed"
		}
		return ""
	}
	if state.RTTUs != 0 {
		if rtt := time.Duration(state.RTTUs) * time.Microsecond; t.minRTT == 0 || rtt < t.minRTT {
			t.minRTT = rtt
		}
	}
	if state.MinRTTUs == 0 && t.minRTT != 0 {
		// Without the kernel's minimum, the shortest round trip this lane
		// showed stands for its path's.
		state.MinRTTUs = uint32(t.minRTT / time.Microsecond)
	}
	sent, received := state.BytesAcked-t.lastSent, state.BytesReceived-t.lastReceived
	first := !t.looked
	t.looked = true
	t.lastSent, t.lastReceived = state.BytesAcked, state.BytesReceived
	if first {
		sent, received = 0, 0
	}
	bulk := sent >= BulkBytes || received >= BulkBytes
	if bulk {
		t.idle = 0
	} else if t.idle < IdleChecks {
		t.idle++
	}
	if sent >= BusyBytes || received >= BusyBytes || state.Busy() {
		// Delivering: not now, the relay's word included (it stays for a
		// look when the lane no longer delivers).
		t.grew = 0
		return ""
	}
	if t.hinted.Load() {
		return "relay_collapsed"
	}
	if first {
		return ""
	}
	if t.idle >= IdleChecks && state.Stale() {
		return "collapsed"
	}
	// The rate rule only while the lane sends bulk data: an idle lane's
	// round trip comes from small writes the peer acks late.
	if sent >= BulkBytes && state.Slow() {
		return "slow_threshold"
	}
	var rttUs uint32
	switch {
	case sent >= BulkBytes && state.RTTUs != 0:
		rttUs = state.RTTUs
	case received >= BulkBytes && state.RcvRTTUs != 0:
		rttUs = state.RcvRTTUs
	default:
		t.grew = 0
		return ""
	}
	rtt := time.Duration(rttUs) * time.Microsecond
	learned := t.bulkRTT
	if learned == 0 {
		learned = t.minRTT
	}
	if learned != 0 && rtt >= RTTGrowth*learned && rtt >= learned+RTTGrowthMin {
		// Not learned from: the next look compares with the same round trip.
		t.grew++
		if t.grew >= GrewChecks {
			return "round_trip_grew"
		}
		return ""
	}
	t.grew = 0
	if t.bulkRTT == 0 || rtt < t.bulkRTT {
		t.bulkRTT = rtt
	}
	return ""
}

// MayRotate reports whether a lane last rotated at rotatedAt (zero: never)
// may rotate at now: after Every, or after EveryCheap when cheap reports
// that its rotation moves no stream that carries data.
func MayRotate(rotatedAt, now time.Time, cheap func() bool) bool {
	since := now.Sub(rotatedAt)
	return rotatedAt.IsZero() || since >= Every || (since >= EveryCheap && cheap != nil && cheap())
}

// Rotations counts lane connections replaced by this process (health).
var Rotations atomic.Uint64
