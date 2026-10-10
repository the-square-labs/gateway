package relaylane

import (
	"testing"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/connector"
	"github.com/wiolett-industries/gateway/daemon-shared/slowstart"
)

// A lane is rotated when its own sending side collapsed, when the relay says
// its side did, or when its round trip under bulk data grew far beyond the
// one it learned on; not for a round trip measured on small writes.
func TestReason(t *testing.T) {
	ms := func(d int) uint32 { return uint32(d * 1000) }
	trigger := &Trigger{}
	state := func(sent, received uint64, rttMs, rcvRTTMs int) slowstart.State {
		return slowstart.State{SlowStartThreshold: slowstart.InfiniteThreshold, BytesAcked: sent, BytesReceived: received,
			RTTUs: ms(rttMs), RcvRTTUs: ms(rcvRTTMs)}
	}
	if why := trigger.Reason(state(1000, 1000, 1, 1), true); why != "" {
		t.Fatalf("first look: %q", why)
	}
	// A LAN download: the lane learns the receiver's 1 ms, not its own 40 ms (delayed acks of its small writes).
	if why := trigger.Reason(state(2000, 1000+BulkBytes, 40, 1), true); why != "" || trigger.bulkRTT != time.Millisecond {
		t.Fatalf("LAN bulk: %q, learned %v", why, trigger.bulkRTT)
	}
	if why := trigger.Reason(state(3000, 2000+BulkBytes, 60, 60), true); why != "" {
		t.Fatalf("small writes: %q", why)
	}
	if why := trigger.Reason(state(4000, 2000+3*BulkBytes, 90, 60), true); why != "" {
		t.Fatalf("one look after the round trip grew: %q", why)
	}
	if why := trigger.Reason(state(5000, 2000+5*BulkBytes, 90, 60), true); why != "round_trip_grew" {
		t.Fatalf("download after the round trip grew: %q", why)
	}
	upload := &Trigger{}
	upload.Reason(state(1000, 1000, 1, 0), true)
	upload.Reason(state(1000+BulkBytes, 1000, 1, 0), true)
	upload.Reason(state(1000+3*BulkBytes, 1000, 60, 0), true)
	if why := upload.Reason(state(1000+5*BulkBytes, 1000, 60, 0), true); why != "round_trip_grew" {
		t.Fatalf("upload after the round trip grew: %q", why)
	}
	if why := idleLooks(&Trigger{}, slowstart.State{SlowStartThreshold: 7, RTTUs: ms(60)}); why != "collapsed" {
		t.Fatalf("collapsed sender: %q", why)
	}
	if why := idleLooks(&Trigger{}, slowstart.State{SlowStartThreshold: 7, RTTUs: ms(1)}); why != "" {
		t.Fatalf("a small threshold on a LAN: %q", why)
	}
	// A threshold learned on the LAN (411 segments) on a 150 ms leg: rotated while the lane sends bulk data, not while
	// it idles; a large one (CUBIC after a loss at the path's rate) stays.
	lanState := func(sent uint64, ssthresh uint32) slowstart.State {
		return slowstart.State{SlowStartThreshold: ssthresh, BytesAcked: sent, RTTUs: ms(150), MSS: 1448}
	}
	slow := &Trigger{}
	slow.Reason(lanState(1000, 411), true)
	if why := slow.Reason(lanState(2000, 411), true); why != "" {
		t.Fatalf("idle lane with a small threshold: %q", why)
	}
	if why := slow.Reason(lanState(2000+BulkBytes, 411), true); why != "slow_threshold" {
		t.Fatalf("bulk under a LAN threshold: %q", why)
	}
	fresh := &Trigger{}
	fresh.Reason(lanState(1000, 2400), true)
	if why := fresh.Reason(lanState(1000+BulkBytes, 2400), true); why != "" {
		t.Fatalf("bulk under a path-sized threshold: %q", why)
	}
	// A lane that never carried bulk data on the LAN: its first bulk at 150 ms is measured against the shortest round
	// trip it showed (2 ms).
	quiet := &Trigger{}
	quiet.Reason(state(1000, 1000, 2, 0), true)
	quiet.Reason(state(1100, 1100, 150, 0), true)
	quiet.Reason(state(1200, 1100+BulkBytes, 150, 150), true)
	if why := quiet.Reason(state(1300, 1100+2*BulkBytes, 150, 150), true); why != "round_trip_grew" {
		t.Fatalf("first bulk after the round trip grew: %q", why)
	}
	far := &Trigger{}
	far.Reason(state(1000, 1000, 150, 0), true)
	far.Reason(state(1100, 1000+BulkBytes, 150, 150), true)
	if why := far.Reason(state(1200, 1000+2*BulkBytes, 150, 150), true); why != "" {
		t.Fatalf("a lane that always ran at 150 ms: %q", why)
	}
	hinted := &Trigger{}
	hinted.NoteHeader(map[string][]string{connector.LaneRenewHeader: {"1"}})
	if why := hinted.Reason(slowstart.State{}, false); why != "relay_collapsed" {
		t.Fatalf("relay's word: %q", why)
	}
	hinted.ClearHint()
	if why := hinted.Reason(slowstart.State{}, false); why != "" {
		t.Fatalf("after ClearHint: %q", why)
	}
}

// idleLooks looks at an idle lane (no bytes moving) until it is idle long enough and returns the last reason.
func idleLooks(trigger *Trigger, state slowstart.State) string {
	why := ""
	for range IdleChecks + 1 {
		why = trigger.Reason(state, true)
	}
	return why
}

// A busy LAN lane after an ordinary loss (stand rc.9: 110 MB/s to the local relay, cwnd and ssthresh 26, srtt 5-19 ms
// from the host's queues) is never rotated: not while it delivers, and not once it idles, since its threshold is worth
// line rate at its path's round trip. Not on the relay's word while it delivers either.
func TestBusyLANLaneWithALossIsNotRotated(t *testing.T) {
	const perCheck = 110 << 20 / 4
	lane := func(sent uint64, srttMs int) slowstart.State {
		return slowstart.State{SlowStartThreshold: 26, BytesAcked: sent, RTTUs: uint32(srttMs * 1000), MinRTTUs: 180,
			MSS: 1448, DeliveryRate: 110 << 20}
	}
	trigger := &Trigger{}
	sent := uint64(1 << 30)
	for i, srtt := range []int{5, 8, 12, 19, 15, 10, 8} {
		sent += perCheck
		if why := trigger.Reason(lane(sent, srtt), true); why != "" {
			t.Fatalf("look %d at srtt %d ms while moving 110 MB/s: %q", i, srtt, why)
		}
	}
	trigger.NoteHeader(map[string][]string{connector.LaneRenewHeader: {"1"}})
	sent += perCheck
	if why := trigger.Reason(lane(sent, 15), true); why != "" {
		t.Fatalf("relay's word while the lane delivers: %q", why)
	}
	trigger.ClearHint()
	idle := lane(sent, 15)
	idle.DeliveryRate, idle.LastDataSentMs = 0, 5000
	if why := idleLooks(trigger, idle); why != "" {
		t.Fatalf("the same lane idle: %q", why)
	}
	// Without the kernel's minimum the lane's shortest smoothed round trip stands in.
	noMin := &Trigger{}
	noMin.Reason(slowstart.State{SlowStartThreshold: 26, BytesAcked: 1000, RTTUs: 400, MSS: 1448}, true)
	if why := idleLooks(noMin, slowstart.State{SlowStartThreshold: 26, BytesAcked: 1000, RTTUs: 15_000, MSS: 1448}); why != "" {
		t.Fatalf("idle LAN lane without the kernel's minimum: %q", why)
	}
}

// An idle lane on a far path left with a tiny threshold by a retransmission timeout is rotated: its next transfer
// would start slow. Not before it has been idle for IdleChecks looks.
func TestIdleLaneAfterTimeoutIsRotated(t *testing.T) {
	far := slowstart.State{SlowStartThreshold: 4, BytesAcked: 5 << 20, RTTUs: 62_000, MinRTTUs: 60_000, MSS: 1448,
		DeliveryRate: 300 << 10, LastDataSentMs: 3000}
	trigger := &Trigger{}
	for i := range IdleChecks - 1 {
		if why := trigger.Reason(far, true); why != "" {
			t.Fatalf("look %d, not idle long enough: %q", i, why)
		}
	}
	if why := trigger.Reason(far, true); why != "collapsed" {
		t.Fatalf("idle far lane after a timeout: %q", why)
	}
}

// A far lane whose round trip grew (learned on 1 ms, now 60 ms) and that moves a download at a few MB/s is rotated on
// the second look; the same growth at line rate is not.
func TestFarLaneAfterRoundTripGrowthIsRotated(t *testing.T) {
	look := func(trigger *Trigger, received uint64, rcvRTTMs int) string {
		return trigger.Reason(slowstart.State{SlowStartThreshold: slowstart.InfiniteThreshold, BytesAcked: 1000,
			BytesReceived: received, RTTUs: 40_000, RcvRTTUs: uint32(rcvRTTMs * 1000), MSS: 1448}, true)
	}
	slow := &Trigger{}
	look(slow, 1000, 1)
	look(slow, 1000+2*BulkBytes, 1)
	if why := look(slow, 1000+4*BulkBytes, 60); why != "" {
		t.Fatalf("first look at 60 ms: %q", why)
	}
	if why := look(slow, 1000+6*BulkBytes, 60); why != "round_trip_grew" {
		t.Fatalf("download at 2 MB/s after the round trip grew: %q", why)
	}
	fast := &Trigger{}
	look(fast, 1000, 1)
	look(fast, 1000+2*BulkBytes, 1)
	received := uint64(1000 + 2*BulkBytes)
	for i := range 4 {
		received += 2 * BusyBytes
		if why := look(fast, received, 60); why != "" {
			t.Fatalf("look %d, download at line rate after the round trip grew: %q", i, why)
		}
	}
}
