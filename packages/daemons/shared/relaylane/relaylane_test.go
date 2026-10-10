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
	if why := trigger.Reason(state(4000, 2000+3*BulkBytes, 90, 60), true); why != "round_trip_grew" {
		t.Fatalf("download after the round trip grew: %q", why)
	}
	upload := &Trigger{}
	upload.Reason(state(1000, 1000, 1, 0), true)
	upload.Reason(state(1000+BulkBytes, 1000, 1, 0), true)
	if why := upload.Reason(state(1000+3*BulkBytes, 1000, 60, 0), true); why != "round_trip_grew" {
		t.Fatalf("upload after the round trip grew: %q", why)
	}
	if why := (&Trigger{}).Reason(slowstart.State{SlowStartThreshold: 7, RTTUs: ms(60)}, true); why != "collapsed" {
		t.Fatalf("collapsed sender: %q", why)
	}
	if why := (&Trigger{}).Reason(slowstart.State{SlowStartThreshold: 7, RTTUs: ms(1)}, true); why != "" {
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
	if why := quiet.Reason(state(1200, 1100+BulkBytes, 150, 150), true); why != "round_trip_grew" {
		t.Fatalf("first bulk after the round trip grew: %q", why)
	}
	far := &Trigger{}
	far.Reason(state(1000, 1000, 150, 0), true)
	if why := far.Reason(state(1100, 1000+BulkBytes, 150, 150), true); why != "" {
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
