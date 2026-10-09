// Package slowstart keeps a long-lived TCP connection's slow start from
// ending at a round trip it learned long ago. A relay lane lives for hours:
// Linux's CUBIC keeps the shortest round trip it ever saw on a connection
// (HyStart's delay_min, reset only by a retransmission timeout). When the
// lane's round trip grows (its route got longer) and the lane was idle, the
// kernel restarts the window at 10 segments, and HyStart compares the new
// round trip with the old one: it ends the slow start at 16 segments, and
// congestion avoidance takes tens of seconds to fill the longer path. On the
// stand a link's first transfer after its relay leg went from 1 to 60 ms ran
// at 6-30 MB/s for up to 45 s instead of 60 MB/s (rc.7 F-5); a new
// connection, as a direct transfer makes, never had the old round trip.
//
// A Guard sits beneath a lane's TLS connection and restarts CUBIC (switches
// the connection's congestion control to reno and back, which starts CUBIC
// afresh: HyStart learns the round trip of the slow start ahead, as on a new
// connection) before a write when the kernel is about to slow-start with a
// round trip CUBIC did not see:
//   - after a pause, if the window is below the slow start threshold, or
//     nothing is in flight and the pause is longer than the retransmission
//     timeout (Linux restarts the window there);
//   - while the connection carries only small writes in slow start (the
//     acks of a transfer in the other direction) and its smoothed round trip
//     grew to more than twice the shortest one since the last restart:
//     HyStart would end the slow start on those small writes.
//
// The window and the slow start threshold stay as they are: a threshold the
// connection learned on a LAN still caps the next slow start, and congestion
// avoidance takes a few seconds from there to a longer path's rate (a new
// connection has no threshold yet). Nothing changes on the wire, and only
// CUBIC (Linux's default) is touched.
package slowstart

import (
	"net"
	"sync/atomic"
	"time"
)

// Pause is the gap between two writes after which a write checks the
// connection. A stream moving bulk data writes far more often.
const Pause = 20 * time.Millisecond

// checkEvery bounds how often writes in a row check the connection (one
// TCP_INFO read).
const checkEvery = 5 * time.Millisecond

var resets atomic.Uint64

// Resets counts the congestion control restarts of every Guard (tests,
// telemetry).
func Resets() uint64 { return resets.Load() }

// Guard watches one TCP connection. Its methods are not safe for concurrent
// use: the writer that owns the connection calls them.
type Guard struct {
	sys       guardSys
	last      time.Time
	lastCheck time.Time
	// baseRTT is the shortest smoothed round trip (µs) seen since the last
	// restart; 0 before the first check.
	baseRTT uint32
	off     bool
}

// New returns a Guard for conn, or nil when conn is not a TCP socket under
// CUBIC (or the system does not let this process switch it). A nil Guard
// does nothing.
func New(conn net.Conn) *Guard {
	sys, ok := newGuardSys(conn)
	if !ok {
		return nil
	}
	return &Guard{sys: sys}
}

// tcpState is what a check reads of the connection (TCP_INFO).
type tcpState struct {
	cwnd, ssthresh, unacked, lastDataSentMs, rtoUs, rttUs uint32
}

// BeforeWrite is called before each write to the connection.
func (g *Guard) BeforeWrite() {
	if g == nil || g.off {
		return
	}
	now := time.Now()
	last := g.last
	g.last = now
	if last.IsZero() {
		g.lastCheck = now
		return
	}
	paused := now.Sub(last) >= Pause
	if !paused && now.Sub(g.lastCheck) < checkEvery {
		return
	}
	g.lastCheck = now
	state, ok := g.sys.info()
	if !ok {
		g.off = true
		return
	}
	if !g.restartAhead(state, paused) {
		return
	}
	if !g.sys.restart() {
		g.off = true
		return
	}
	g.baseRTT = state.rttUs
	resets.Add(1)
}

// restartAhead decides on a check and keeps baseRTT.
func (g *Guard) restartAhead(state tcpState, paused bool) bool {
	if paused && slowStartAhead(state.cwnd, state.ssthresh, state.unacked, state.lastDataSentMs, state.rtoUs) {
		return true
	}
	if g.baseRTT == 0 || state.rttUs < g.baseRTT {
		g.baseRTT = state.rttUs
		return false
	}
	smallWrites := state.cwnd < state.ssthresh && 2*state.unacked < state.cwnd
	return smallWrites && uint64(state.rttUs) > 2*uint64(g.baseRTT)+2000
}

// initialWindow is Linux's window after an idle restart (segments).
const initialWindow = 10

// slowStartAhead: the next send runs in slow start. ssthresh is
// 0x7fffffff before the first loss. Linux restarts an idle window (nothing in
// flight for longer than the retransmission timeout) at the initial window
// and keeps the threshold at least 3/4 of the window it had; a threshold at
// or below the initial window (after a timeout) means congestion avoidance,
// where CUBIC's memory of the window it last reached makes it grow back fast
// and a restart would only slow it down.
func slowStartAhead(cwnd, ssthresh, unacked, lastDataSentMs, rtoUs uint32) bool {
	if cwnd < ssthresh {
		return true
	}
	idle := unacked == 0 && uint64(lastDataSentMs)*1000 >= uint64(rtoUs)
	return idle && max(ssthresh, cwnd/4*3) > initialWindow
}
