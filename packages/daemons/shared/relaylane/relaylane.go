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
	// Spacing spaces the rotations of one relay's lanes: one at a time.
	Spacing = 2 * time.Second
	// DialTimeout bounds the dial of a replacement connection.
	DialTimeout = 15 * time.Second
	// BulkBytes is how much a lane carries within one Check for its round
	// trip to count as the one it learned its congestion state on.
	BulkBytes = 256 << 10
	// RTTGrowth and RTTGrowthMin: a lane whose round trip under bulk data grew
	// this far beyond the one it learned on is rotated.
	RTTGrowth    = 4
	RTTGrowthMin = 10 * time.Millisecond
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

// Reason decides from a lane's TCP state whether it is rotated ("" if not):
// its own sending side collapsed, the relay said its side did, its sending
// side carries bulk data under a threshold worth less than
// slowstart.SlowRate, or its round trip under bulk data grew far beyond the
// one it learned on (the shortest round trip it carried bulk at, or, before
// any, the shortest it showed at all). The round trip is read where bulk
// data flows: the sender's smoothed round trip while the lane sends bulk, the
// receiver's estimate while it receives bulk (the acks it sends meanwhile are
// small writes whose round trip the peer's delayed acks inflate).
func (t *Trigger) Reason(state slowstart.State, known bool) string {
	if t.hinted.Load() {
		return "relay_collapsed"
	}
	if !known {
		return ""
	}
	if state.Collapsed() {
		return "collapsed"
	}
	if state.RTTUs != 0 {
		if rtt := time.Duration(state.RTTUs) * time.Microsecond; t.minRTT == 0 || rtt < t.minRTT {
			t.minRTT = rtt
		}
	}
	sent, received := state.BytesAcked-t.lastSent, state.BytesReceived-t.lastReceived
	first := t.lastSent == 0 && t.lastReceived == 0
	t.lastSent, t.lastReceived = state.BytesAcked, state.BytesReceived
	if first {
		return ""
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
		return ""
	}
	rtt := time.Duration(rttUs) * time.Microsecond
	learned := t.bulkRTT
	if learned == 0 || rtt < learned {
		t.bulkRTT = rtt
	}
	if learned == 0 {
		learned = t.minRTT
	}
	if learned != 0 && rtt >= RTTGrowth*learned && rtt >= learned+RTTGrowthMin {
		return "round_trip_grew"
	}
	return ""
}

// Rotations counts lane connections replaced by this process (health).
var Rotations atomic.Uint64
