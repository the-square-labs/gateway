package slowstart

import (
	"testing"
	"time"
)

func TestSlowStartAhead(t *testing.T) {
	const infinite = 0x7fffffff
	for _, c := range []struct {
		name                                         string
		cwnd, ssthresh, unacked, lastDataSentMs, rto uint32
		want                                         bool
	}{
		{"first slow start", 10, infinite, 0, 0, 200_000, true},
		{"slow start with data in flight", 40, 1600, 30, 0, 200_000, true},
		{"congestion avoidance, busy", 1600, 1000, 300, 0, 200_000, false},
		{"congestion avoidance, short pause", 1600, 1000, 0, 150, 200_000, false},
		{"idle past the retransmission timeout", 1600, 1000, 0, 250, 200_000, true},
		{"data in flight after a long pause", 1600, 1000, 3, 900, 200_000, false},
		{"idle after a timeout: congestion avoidance from the restart", 9, 7, 0, 900, 200_000, false},
	} {
		if got := slowStartAhead(c.cwnd, c.ssthresh, c.unacked, c.lastDataSentMs, c.rto); got != c.want {
			t.Errorf("%s: %v, want %v", c.name, got, c.want)
		}
	}
}

// While a connection carries only small writes in slow start, a smoothed
// round trip that grew to more than twice the shortest since the last
// restart restarts CUBIC; a window-bound slow start does not (HyStart is
// there for it), nor congestion avoidance.
func TestRestartAheadOnSmallWrites(t *testing.T) {
	const infinite = 0x7fffffff
	g := &Guard{}
	small := func(rttUs uint32) tcpState {
		return tcpState{cwnd: 40, ssthresh: infinite, unacked: 2, lastDataSentMs: 1, rtoUs: 201_000, rttUs: rttUs}
	}
	if g.restartAhead(small(600), false) || g.baseRTT != 600 {
		t.Fatalf("first check: base %d", g.baseRTT)
	}
	if g.restartAhead(small(3000), false) {
		t.Fatal("restart at 3 ms over a 0.6 ms base (under twice it plus 2 ms)")
	}
	if !g.restartAhead(small(60_000), false) {
		t.Fatal("no restart after the round trip grew to 60 ms")
	}
	bulk := tcpState{cwnd: 40, ssthresh: infinite, unacked: 38, rtoUs: 201_000, rttUs: 60_000}
	if g.restartAhead(bulk, false) {
		t.Fatal("restart in a window-bound slow start")
	}
	avoidance := tcpState{cwnd: 400, ssthresh: 200, unacked: 3, rtoUs: 201_000, rttUs: 60_000}
	if g.restartAhead(avoidance, false) {
		t.Fatal("restart in congestion avoidance")
	}
	if !g.restartAhead(tcpState{cwnd: 400, ssthresh: 200, unacked: 0, lastDataSentMs: 300, rtoUs: 201_000, rttUs: 600}, true) {
		t.Fatal("no restart after a pause past the retransmission timeout")
	}
}

func TestNilGuardDoesNothing(t *testing.T) {
	var g *Guard
	g.BeforeWrite()
}

// A threshold is judged at the path's round trip (the kernel's recent minimum), not at a smoothed round trip a busy
// host's queues inflate; a sender delivering at BusyRate is busy (the relay's lane hint skips it).
func TestStaleAtThePathsRoundTrip(t *testing.T) {
	lan := State{SlowStartThreshold: 26, RTTUs: 15_000, MinRTTUs: 180, MSS: 1448}
	if lan.PathRTT() != 180*time.Microsecond || lan.Stale() {
		t.Fatalf("LAN sender after a loss at srtt 15 ms: path %v stale %v", lan.PathRTT(), lan.Stale())
	}
	if old := (State{SlowStartThreshold: 26, RTTUs: 15_000, MSS: 1448}); !old.Stale() {
		t.Fatal("without the kernel's minimum the smoothed round trip counts")
	}
	far := State{SlowStartThreshold: 4, RTTUs: 62_000, MinRTTUs: 60_000, MSS: 1448}
	if !far.Collapsed() || !far.Stale() {
		t.Fatal("far sender after a timeout is not collapsed")
	}
	if slow := (State{SlowStartThreshold: 411, RTTUs: 150_000, MinRTTUs: 148_000, MSS: 1448}); !slow.Slow() {
		t.Fatal("a LAN-learned threshold on a 150 ms path is not slow")
	}
	busy := State{DeliveryRate: 110 << 20, LastDataSentMs: 3}
	if !busy.Busy() {
		t.Fatal("sender at 110 MB/s is not busy")
	}
	busy.LastDataSentMs = 5000
	if busy.Busy() {
		t.Fatal("a rate sample from 5 s ago counts as busy")
	}
}
