package broker

import (
	"context"
	"net"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/admission"
	"github.com/wiolett-industries/gateway/relay/internal/grant"
	"github.com/wiolett-industries/gateway/relay/internal/policy"
)

const (
	DefaultMaxFrameBytes  = 1024 * 1024
	AcceptTimeout         = 30 * time.Second
	IdleTimeout           = 5 * time.Minute
	ProxyHalfCloseTimeout = 30 * time.Second
	// EndpointRestartCapability tells daemons that this relay keeps a
	// restarting endpoint's registration (ENDPOINT_SERVING_STATE_RESTARTING).
	EndpointRestartCapability = "endpoint_restart_v1"
)

// EndpointRestartGrace is how long a registration whose daemon announced a
// restart is kept after its stream ended, waiting for the daemon's next
// process to register again (B-13). A daemon that does not come back by then
// is treated as gone.
var EndpointRestartGrace = 15 * time.Second

type endpointRegistration struct {
	endpointID string
	// subjectID is the daemon the registration's grant names (its node):
	// while a registration of a previous generation serves, the endpoint's
	// policy may already name another node.
	subjectID            string
	generation           uint64
	assignmentGeneration uint64
	expiresAt            atomic.Int64
	maxSessions          atomic.Uint32
	incoming             chan *relayv1.IncomingTunnel
	// state is the relayv1.EndpointServingState the endpoint last sent (D6,
	// D7): UNSPECIFIED from endpoints built before serving states.
	state    atomic.Int32
	stop     chan struct{}
	stopOnce sync.Once
	// restartingSince is when a serving endpoint announced that its daemon
	// restarts (B-13), in Unix nanoseconds; 0 while it does not. restarting
	// closes at that moment, so tunnels waiting for the old process to accept
	// are answered at once.
	restartingSince atomic.Int64
	restarting      chan struct{}
	restartOnce     sync.Once
	// supersededAt is when the policy moved the endpoint to a newer
	// generation (certificate rotation, new target node) while this
	// registration of the previous one serves, in Unix nanoseconds; 0 while it
	// is current. It keeps serving until the new generation registers or its
	// grant expires (make-before-break).
	supersededAt atomic.Int64
	// pending is a renewal whose grant is ahead of this relay's policy (the
	// daemon got its grant before the relay got the policy): applied as soon
	// as the policy arrives. Guarded by the broker's mu; recheck wakes the
	// registration's stream handler to try it again.
	pending *relayv1.RenewEndpoint
	recheck chan struct{}
	// stopReason is written before stop closes, so readers of a closed stop
	// see it without a lock.
	stopReason string
}

func (r *endpointRegistration) close() { r.closeWith("") }

func (r *endpointRegistration) servingState() relayv1.EndpointServingState {
	return relayv1.EndpointServingState(r.state.Load())
}

// stateful reports a registration that states whether it serves: it is kept
// whatever the lease gate says, and only SERVING receives tunnels (D7).
func (r *endpointRegistration) stateful() bool {
	return r.servingState() != relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_UNSPECIFIED
}

func (r *endpointRegistration) dormant() bool {
	return r.servingState() == relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
}

// nudge wakes the registration's stream handler to retry a pending renewal.
func (r *endpointRegistration) nudge() {
	if r.recheck == nil {
		return
	}
	select {
	case r.recheck <- struct{}{}:
	default:
	}
}

// announceRestart marks a registration whose daemon restarts. A dormant
// registration takes no traffic either way and is left as it is.
func (r *endpointRegistration) announceRestart(now time.Time) bool {
	if r.dormant() {
		return false
	}
	r.restartingSince.CompareAndSwap(0, now.UnixNano())
	r.restartOnce.Do(func() {
		if r.restarting != nil {
			close(r.restarting)
		}
	})
	return true
}

// restartingAt reports a registration whose daemon announced a restart less
// than EndpointRestartGrace ago.
func (r *endpointRegistration) restartingAt(now time.Time) bool {
	since := r.restartingSince.Load()
	return since != 0 && now.Sub(time.Unix(0, since)) < EndpointRestartGrace
}

func (r *endpointRegistration) closeWith(reason string) {
	r.stopOnce.Do(func() {
		r.stopReason = reason
		close(r.stop)
	})
}

func (r *endpointRegistration) revokedMessage() string {
	if r.stopReason != "" {
		return r.stopReason
	}
	return "endpoint policy was revoked"
}

type acceptedConnection struct {
	stream relayv1.TunnelBroker_AcceptTunnelServer
	result chan error
}

type pendingTunnel struct {
	endpoint *relayv1.EndpointPolicy
	session  *activeTunnel
	accepted chan acceptedConnection
}

type activeTunnel struct {
	routeID              string
	routeGeneration      uint64
	sourceKind           string
	sourceID             string
	endpointID           string
	endpointGeneration   uint64
	assignmentGeneration uint64
	trafficClass         string
	metrics              *routeMetrics
	// registration is the endpoint registration the tunnel was bridged
	// through (nil for built-in local services).
	registration *endpointRegistration
	stop         chan struct{}
	stopOnce     sync.Once
}

func (t *activeTunnel) close() { t.stopOnce.Do(func() { close(t.stop) }) }

type Broker struct {
	relayv1.UnimplementedTunnelBrokerServer
	store            *policy.Store
	verifier         grant.Verifier
	mu               sync.Mutex
	endpoints        map[string]*endpointRegistration
	pending          map[string]*pendingTunnel
	active           map[string]*activeTunnel
	admission        *admission.Controller
	activeProxy      uint64
	activeDatabase   uint64
	activeRegistry   uint64
	proxyByRoute     map[string]uint64
	registryByRoute  map[string]uint64
	activeByRoute    map[string]uint64
	activeByTarget   map[string]uint64
	routeMetrics     map[string]*routeMetrics
	metricsSince     time.Time
	draining         atomic.Bool
	dialLocalService func(context.Context, string) (net.Conn, error)
	lease            LeaseGate
	// policyChanged closes, and is replaced, whenever a new policy snapshot
	// applies: registrations waiting for the policy their grant needs retry.
	policyChanged chan struct{}
}

func New(store *policy.Store) *Broker {
	controller := admission.New()
	controller.UpdatePolicy(store.Current().Admission)
	dialer := net.Dialer{}
	return &Broker{store: store, verifier: grant.Verifier{Store: store}, endpoints: map[string]*endpointRegistration{}, pending: map[string]*pendingTunnel{}, active: map[string]*activeTunnel{}, admission: controller, proxyByRoute: map[string]uint64{}, registryByRoute: map[string]uint64{}, activeByRoute: map[string]uint64{}, activeByTarget: map[string]uint64{}, routeMetrics: map[string]*routeMetrics{}, metricsSince: time.Now(), policyChanged: make(chan struct{}), dialLocalService: func(ctx context.Context, target string) (net.Conn, error) {
		return dialer.DialContext(ctx, "tcp", target)
	}}
}

func (b *Broker) SetLocalServiceDialer(dial func(context.Context, string) (net.Conn, error)) {
	if dial != nil {
		b.dialLocalService = dial
	}
}

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

func (b *Broker) Counts() (uint64, uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return uint64(len(b.endpoints)), uint64(len(b.active))
}

type RuntimeSnapshot struct {
	RegisteredEndpoints   uint64
	ActiveTunnels         uint64
	ActiveProxyTunnels    uint64
	ActiveDatabaseTunnels uint64
	ActiveRegistryTunnels uint64
	Admission             admission.Snapshot
	Draining              bool
	AssignmentTunnels     []AssignmentTunnelCount
}

type AssignmentTunnelCount struct {
	EndpointID           string
	AssignmentGeneration uint64
	ActiveTunnels        uint64
}

func (b *Broker) RuntimeSnapshot() RuntimeSnapshot {
	b.mu.Lock()
	defer b.mu.Unlock()
	usage := b.usageLocked()
	assignmentCounts := make(map[string]AssignmentTunnelCount)
	for _, tunnel := range b.active {
		key := policyAssignmentKey(tunnel.endpointID, tunnel.assignmentGeneration)
		count := assignmentCounts[key]
		count.EndpointID = tunnel.endpointID
		count.AssignmentGeneration = tunnel.assignmentGeneration
		count.ActiveTunnels++
		assignmentCounts[key] = count
	}
	assignmentTunnels := make([]AssignmentTunnelCount, 0, len(assignmentCounts))
	for _, count := range assignmentCounts {
		assignmentTunnels = append(assignmentTunnels, count)
	}
	sort.Slice(assignmentTunnels, func(i, j int) bool {
		if assignmentTunnels[i].EndpointID == assignmentTunnels[j].EndpointID {
			return assignmentTunnels[i].AssignmentGeneration < assignmentTunnels[j].AssignmentGeneration
		}
		return assignmentTunnels[i].EndpointID < assignmentTunnels[j].EndpointID
	})
	return RuntimeSnapshot{
		RegisteredEndpoints:   uint64(len(b.endpoints)),
		ActiveTunnels:         uint64(len(b.active)),
		ActiveProxyTunnels:    usage.ActiveProxy,
		ActiveDatabaseTunnels: usage.ActiveDatabase,
		ActiveRegistryTunnels: usage.ActiveRegistry,
		Admission:             b.admission.GetSnapshot(),
		Draining:              b.draining.Load(),
		AssignmentTunnels:     assignmentTunnels,
	}
}

func (b *Broker) SetDraining(value bool) { b.draining.Store(value) }

func (b *Broker) Draining() bool { return b.draining.Load() }

// ForceDisconnect closes established streams only after the control plane has
// explicitly placed the worker in drain mode. It never changes policy or
// resumes admission by itself.
func (b *Broker) ForceDisconnect() uint64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.draining.Load() {
		return 0
	}
	count := uint64(len(b.active))
	for _, tunnel := range b.active {
		tunnel.close()
	}
	return count
}

func (b *Broker) Reconcile(previous, next *policy.Snapshot) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.reconcileLocked(next)
}

// ApplySnapshot serializes the durable policy swap with endpoint and tunnel
// admission. A grant can therefore never pass against one revision and be
// admitted after a newer revision has become current.
func (b *Broker) ApplySnapshot(request *relayv1.ApplySnapshotRequest) (*policy.Snapshot, bool, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	next, unchanged, err := b.store.Apply(request)
	if err != nil {
		return nil, false, err
	}
	if !unchanged {
		b.reconcileLocked(next)
		if b.lease != nil {
			// Adopt the snapshot's lease blocks before the new policy admits
			// anything, then drop registrations the new view no longer admits.
			b.lease.ApplyPolicy(next)
			b.enforceLeaseGatesLocked()
		}
	}
	return next, unchanged, nil
}

func (b *Broker) reconcileLocked(next *policy.Snapshot) {
	b.admission.UpdatePolicy(next.Admission)
	for routeID, metrics := range b.routeMetrics {
		if next.Routes[routeID] == nil && metrics.active.Load() == 0 {
			delete(b.routeMetrics, routeID)
		}
	}
	now := time.Now().UnixNano()
	for id, registration := range b.endpoints {
		endpoint := next.Endpoint(registration.endpointID, registration.assignmentGeneration)
		if endpoint == nil || endpoint.AssignmentGeneration != registration.assignmentGeneration || endpoint.Generation < registration.generation {
			registration.close()
			delete(b.endpoints, id)
			continue
		}
		if endpoint.Generation > registration.generation {
			// The endpoint moved to a newer generation (its target's
			// certificate rotated, or its target node changed) while this
			// registration serves: it keeps serving, bounded by its grant,
			// until the new generation registers, instead of leaving a gap of
			// one grant sync (make-before-break).
			registration.supersededAt.CompareAndSwap(0, now)
		}
		if registration.pending != nil || registration.supersededAt.Load() != 0 {
			registration.nudge()
		}
	}
	for _, tunnel := range b.active {
		route := next.Route(tunnel.routeID, tunnel.assignmentGeneration)
		endpoint := next.Endpoint(tunnel.endpointID, tunnel.assignmentGeneration)
		// A newer endpoint generation alone does not end a tunnel: it keeps
		// running on the registration it was bridged through until that ends.
		if route == nil || route.AssignmentGeneration != tunnel.assignmentGeneration || route.Generation != tunnel.routeGeneration || endpoint == nil || endpoint.AssignmentGeneration != tunnel.assignmentGeneration || endpoint.Generation < tunnel.endpointGeneration {
			tunnel.close()
		}
	}
	if b.policyChanged != nil {
		close(b.policyChanged)
	}
	b.policyChanged = make(chan struct{})
}

// policyAhead reports a grant that names an endpoint generation or assignment
// this relay's policy does not have yet: the daemon got its grant before the
// relay got the policy, which follows within seconds.
func policyAhead(claims grant.Claims, snapshot *policy.Snapshot) bool {
	endpoint := snapshot.Endpoint(claims.EndpointID, claims.AssignmentGeneration)
	return endpoint == nil || endpoint.Generation < claims.EndpointGeneration ||
		(claims.AssignmentGeneration > 0 && endpoint.AssignmentGeneration < claims.AssignmentGeneration)
}
