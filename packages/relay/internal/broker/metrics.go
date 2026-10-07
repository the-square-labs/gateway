package broker

import (
	"sort"
	"sync"
	"sync/atomic"
	"time"
)

const routeSetupLatencyWindow = 256

type routeMetrics struct {
	active              atomic.Uint64
	opened              atomic.Uint64
	completed           atomic.Uint64
	failed              atomic.Uint64
	throttled           atomic.Uint64
	sourceToTargetBytes atomic.Uint64
	targetToSourceBytes atomic.Uint64
	durationMillis      atomic.Uint64
	durationCount       atomic.Uint64
	lastActivityMillis  atomic.Int64
	setupMu             sync.Mutex
	setupLatencies      [routeSetupLatencyWindow]uint64
	setupCount          uint64
}

func (m *routeMetrics) touch() {
	m.lastActivityMillis.Store(time.Now().UnixMilli())
}

func (m *routeMetrics) recordSetup(duration time.Duration) {
	m.setupMu.Lock()
	m.setupLatencies[m.setupCount%routeSetupLatencyWindow] = uint64(max(0, duration.Microseconds()))
	m.setupCount++
	m.setupMu.Unlock()
	m.touch()
}

func (m *routeMetrics) recordCompletion(duration time.Duration, err error) {
	m.active.Add(^uint64(0))
	m.completed.Add(1)
	m.durationMillis.Add(uint64(max(0, duration.Milliseconds())))
	m.durationCount.Add(1)
	if err != nil {
		m.failed.Add(1)
	}
	m.touch()
}

func (m *routeMetrics) recordFailedOpen(duration time.Duration) {
	m.completed.Add(1)
	m.failed.Add(1)
	m.durationMillis.Add(uint64(max(0, duration.Milliseconds())))
	m.durationCount.Add(1)
	m.touch()
}

func (m *routeMetrics) setupP95Micros() uint64 {
	m.setupMu.Lock()
	count := min(m.setupCount, uint64(routeSetupLatencyWindow))
	values := append([]uint64(nil), m.setupLatencies[:count]...)
	m.setupMu.Unlock()
	if len(values) == 0 {
		return 0
	}
	sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
	index := (len(values)*95 + 99) / 100
	return values[max(0, index-1)]
}

type RouteRuntimeSnapshot struct {
	RouteID                string
	ActiveTunnels          uint64
	OpenedTotal            uint64
	CompletedTotal         uint64
	FailedTotal            uint64
	ThrottledTotal         uint64
	SourceToTargetBytes    uint64
	TargetToSourceBytes    uint64
	SetupLatencyP95Micros  uint64
	AverageDurationMillis  uint64
	LastActivityUnixMillis int64
	MetricsSinceUnixMillis int64
}

func (b *Broker) RouteRuntimeSnapshot(routeID string) (RouteRuntimeSnapshot, bool) {
	b.mu.Lock()
	if b.store.Current().Routes[routeID] == nil {
		b.mu.Unlock()
		return RouteRuntimeSnapshot{}, false
	}
	metrics := b.routeMetrics[routeID]
	metricsSince := b.metricsSince.UnixMilli()
	b.mu.Unlock()

	snapshot := RouteRuntimeSnapshot{RouteID: routeID, MetricsSinceUnixMillis: metricsSince}
	if metrics == nil {
		return snapshot, true
	}
	durationCount := metrics.durationCount.Load()
	snapshot.ActiveTunnels = metrics.active.Load()
	snapshot.OpenedTotal = metrics.opened.Load()
	snapshot.CompletedTotal = metrics.completed.Load()
	snapshot.FailedTotal = metrics.failed.Load()
	snapshot.ThrottledTotal = metrics.throttled.Load()
	snapshot.SourceToTargetBytes = metrics.sourceToTargetBytes.Load()
	snapshot.TargetToSourceBytes = metrics.targetToSourceBytes.Load()
	snapshot.SetupLatencyP95Micros = metrics.setupP95Micros()
	if durationCount > 0 {
		snapshot.AverageDurationMillis = metrics.durationMillis.Load() / durationCount
	}
	snapshot.LastActivityUnixMillis = metrics.lastActivityMillis.Load()
	return snapshot, true
}

func (b *Broker) routeMetricsLocked(routeID string) *routeMetrics {
	metrics := b.routeMetrics[routeID]
	if metrics == nil {
		metrics = &routeMetrics{}
		b.routeMetrics[routeID] = metrics
	}
	return metrics
}

func (b *Broker) pruneRouteMetrics(routeID string, metrics *routeMetrics) {
	if metrics.active.Load() != 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.store.Current().Routes[routeID] == nil && b.routeMetrics[routeID] == metrics {
		delete(b.routeMetrics, routeID)
	}
}
