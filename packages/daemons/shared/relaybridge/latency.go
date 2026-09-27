package relaybridge

import (
	"sort"
	"sync"
	"time"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

const (
	// LatencySampleInterval is how often a daemon measures each relay.
	LatencySampleInterval = 30 * time.Second
	// latencyWeight is the share of a new sample in the moving average: a
	// single slow round trip moves it, but only a lasting change settles it.
	latencyWeight = 0.3
	// latencyMaxAge drops a relay that was not measured for a few intervals:
	// its distance is unknown again rather than stale.
	latencyMaxAge = 3 * time.Minute
)

// LatencyTracker holds the smoothed round-trip time from this daemon to each
// relay. It is process-wide: the lifecycle measures, tunnel selection reads.
type LatencyTracker struct {
	mu      sync.Mutex
	now     func() time.Time
	samples map[string]latencySample
}

type latencySample struct {
	micros float64
	at     time.Time
}

// Latency is the tracker the daemon lifecycle feeds and tunnel selection reads.
var Latency = NewLatencyTracker(time.Now)

func NewLatencyTracker(now func() time.Time) *LatencyTracker {
	return &LatencyTracker{now: now, samples: map[string]latencySample{}}
}

// Observe folds one measured round trip into the relay's moving average.
func (t *LatencyTracker) Observe(relayInstanceID string, rtt time.Duration) {
	if relayInstanceID == "" || rtt <= 0 {
		return
	}
	micros := float64(rtt.Microseconds())
	if micros < 1 {
		micros = 1
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	if current, ok := t.samples[relayInstanceID]; ok && now.Sub(current.at) <= latencyMaxAge {
		micros = current.micros + latencyWeight*(micros-current.micros)
	}
	t.samples[relayInstanceID] = latencySample{micros: micros, at: now}
}

// RTT is the relay's smoothed round trip, if it was measured recently.
func (t *LatencyTracker) RTT(relayInstanceID string) (time.Duration, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	sample, ok := t.samples[relayInstanceID]
	if !ok || t.now().Sub(sample.at) > latencyMaxAge {
		return 0, false
	}
	return time.Duration(sample.micros * float64(time.Microsecond)), true
}

// Samples reports every recently measured relay for the health report.
func (t *LatencyTracker) Samples() []*pb.RelayLatencySample {
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	result := make([]*pb.RelayLatencySample, 0, len(t.samples))
	for id, sample := range t.samples {
		if now.Sub(sample.at) > latencyMaxAge {
			delete(t.samples, id)
			continue
		}
		result = append(result, &pb.RelayLatencySample{RelayInstanceId: id, RttMicros: uint32(sample.micros + 0.5)})
	}
	sort.Slice(result, func(i, j int) bool { return result[i].RelayInstanceId < result[j].RelayInstanceId })
	return result
}

// LatencyTargets lists the pool relays Gateway asks this daemon to measure,
// with the relays its assignments use first so their details win.
func LatencyTargets(bundle *pb.SyncRelayGrantsCommand) []Target {
	byID := map[string]Target{}
	for _, target := range RequiredTargets(bundle) {
		byID[target.ID] = target
	}
	for _, target := range bundle.GetRelayLatencyTargets() {
		id := target.GetRelayInstanceId()
		if _, known := byID[id]; id == "" || known {
			continue
		}
		byID[id] = Target{ID: id, Addresses: append([]string(nil), target.GetAddresses()...), Port: target.GetPort()}
	}
	result := make([]Target, 0, len(byID))
	for _, target := range byID {
		result = append(result, target)
	}
	sort.Slice(result, func(i, j int) bool { return result[i].ID < result[j].ID })
	return result
}
