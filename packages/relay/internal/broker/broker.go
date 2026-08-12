package broker

import (
	"crypto/rand"
	"encoding/base64"
	"io"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/admission"
	"github.com/wiolett-industries/gateway/relay/internal/grant"
	"github.com/wiolett-industries/gateway/relay/internal/peer"
	"github.com/wiolett-industries/gateway/relay/internal/policy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	DefaultMaxFrameBytes  = 1024 * 1024
	AcceptTimeout         = 30 * time.Second
	IdleTimeout           = 5 * time.Minute
	ProxyHalfCloseTimeout = 30 * time.Second
)

type endpointRegistration struct {
	endpointID  string
	generation  uint64
	expiresAt   atomic.Int64
	maxSessions atomic.Uint32
	incoming    chan *relayv1.IncomingTunnel
	stop        chan struct{}
	stopOnce    sync.Once
}

func (r *endpointRegistration) close() { r.stopOnce.Do(func() { close(r.stop) }) }

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
	routeID            string
	routeGeneration    uint64
	sourceKind         string
	sourceID           string
	endpointID         string
	endpointGeneration uint64
	trafficClass       string
	metrics            *routeMetrics
	stop               chan struct{}
	stopOnce           sync.Once
}

func (t *activeTunnel) close() { t.stopOnce.Do(func() { close(t.stop) }) }

type Broker struct {
	relayv1.UnimplementedTunnelBrokerServer
	store          *policy.Store
	verifier       grant.Verifier
	mu             sync.Mutex
	endpoints      map[string]*endpointRegistration
	pending        map[string]*pendingTunnel
	active         map[string]*activeTunnel
	admission      *admission.Controller
	activeProxy    uint64
	activeDatabase uint64
	proxyByRoute   map[string]uint64
	activeByRoute  map[string]uint64
	activeByTarget map[string]uint64
	routeMetrics   map[string]*routeMetrics
	metricsSince   time.Time
}

func New(store *policy.Store) *Broker {
	controller := admission.New()
	controller.UpdatePolicy(store.Current().Admission)
	return &Broker{store: store, verifier: grant.Verifier{Store: store}, endpoints: map[string]*endpointRegistration{}, pending: map[string]*pendingTunnel{}, active: map[string]*activeTunnel{}, admission: controller, proxyByRoute: map[string]uint64{}, activeByRoute: map[string]uint64{}, activeByTarget: map[string]uint64{}, routeMetrics: map[string]*routeMetrics{}, metricsSince: time.Now()}
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
	Admission             admission.Snapshot
}

func (b *Broker) RuntimeSnapshot() RuntimeSnapshot {
	b.mu.Lock()
	defer b.mu.Unlock()
	usage := b.usageLocked()
	return RuntimeSnapshot{
		RegisteredEndpoints:   uint64(len(b.endpoints)),
		ActiveTunnels:         uint64(len(b.active)),
		ActiveProxyTunnels:    usage.ActiveProxy,
		ActiveDatabaseTunnels: usage.ActiveDatabase,
		Admission:             b.admission.GetSnapshot(),
	}
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
	for id, registration := range b.endpoints {
		endpoint := next.Endpoints[id]
		if endpoint == nil || endpoint.Generation != registration.generation {
			registration.close()
			delete(b.endpoints, id)
		}
	}
	for _, tunnel := range b.active {
		route := next.Routes[tunnel.routeID]
		endpoint := next.Endpoints[tunnel.endpointID]
		if route == nil || route.Generation != tunnel.routeGeneration || endpoint == nil || endpoint.Generation != tunnel.endpointGeneration {
			tunnel.close()
		}
	}
}

func (b *Broker) RegisterEndpoint(stream relayv1.TunnelBroker_RegisterEndpointServer) error {
	client, err := peer.Require(stream.Context())
	if err != nil {
		return status.Error(codes.Unauthenticated, err.Error())
	}
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	register := first.GetRegister()
	if register == nil {
		return status.Error(codes.InvalidArgument, "first endpoint frame must register")
	}
	claims, err := b.verifier.Verify(register.Grant, "endpoint", client)
	if err != nil {
		return status.Error(codes.PermissionDenied, err.Error())
	}
	registration := &endpointRegistration{endpointID: claims.EndpointID, generation: claims.EndpointGeneration, incoming: make(chan *relayv1.IncomingTunnel, 32), stop: make(chan struct{})}
	registration.expiresAt.Store(claims.ExpiresAt)
	registration.maxSessions.Store(claims.MaxConcurrentSessions)
	b.mu.Lock()
	if err := grant.ValidatePolicy(claims, "endpoint", b.store.Current()); err != nil {
		b.mu.Unlock()
		return status.Error(codes.PermissionDenied, err.Error())
	}
	if previous := b.endpoints[claims.EndpointID]; previous != nil {
		previous.close()
		b.closeEndpointSessionsLocked(claims.EndpointID)
	}
	b.endpoints[claims.EndpointID] = registration
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		if b.endpoints[registration.endpointID] == registration {
			delete(b.endpoints, registration.endpointID)
			b.closeEndpointSessionsLocked(registration.endpointID)
		}
		b.mu.Unlock()
		registration.close()
	}()
	if err := sendRegistered(stream, registration); err != nil {
		return err
	}
	received := make(chan *relayv1.EndpointControl)
	receiveErr := make(chan error, 1)
	go func() {
		for {
			message, recvErr := stream.Recv()
			if recvErr != nil {
				receiveErr <- recvErr
				return
			}
			select {
			case received <- message:
			case <-stream.Context().Done():
				return
			}
		}
	}()
	for {
		select {
		case <-registration.stop:
			return status.Error(codes.Aborted, "endpoint policy was revoked")
		case <-stream.Context().Done():
			return stream.Context().Err()
		case err := <-receiveErr:
			return err
		case message := <-received:
			renew := message.GetRenew()
			if renew == nil {
				return status.Error(codes.InvalidArgument, "endpoint control accepts only renew after registration")
			}
			next, verifyErr := b.verifier.Verify(renew.Grant, "endpoint", client)
			if verifyErr != nil {
				return status.Error(codes.PermissionDenied, verifyErr.Error())
			}
			if next.EndpointID != registration.endpointID || next.EndpointGeneration != registration.generation {
				return status.Error(codes.FailedPrecondition, "renewal changes endpoint identity")
			}
			b.mu.Lock()
			if b.endpoints[registration.endpointID] != registration {
				b.mu.Unlock()
				return status.Error(codes.Aborted, "endpoint policy was revoked")
			}
			if err := grant.ValidatePolicy(next, "endpoint", b.store.Current()); err != nil {
				b.mu.Unlock()
				return status.Error(codes.PermissionDenied, err.Error())
			}
			registration.expiresAt.Store(next.ExpiresAt)
			registration.maxSessions.Store(next.MaxConcurrentSessions)
			b.mu.Unlock()
			if err := sendRegistered(stream, registration); err != nil {
				return err
			}
		case incoming := <-registration.incoming:
			if err := stream.Send(&relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Incoming{Incoming: incoming}}); err != nil {
				return err
			}
		}
	}
}

func sendRegistered(stream relayv1.TunnelBroker_RegisterEndpointServer, registration *endpointRegistration) error {
	return stream.Send(&relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Registered{Registered: &relayv1.EndpointRegistered{EndpointId: registration.endpointID, GrantExpiresAtUnix: registration.expiresAt.Load()}}})
}

func (b *Broker) OpenTunnel(stream relayv1.TunnelBroker_OpenTunnelServer) (resultErr error) {
	client, err := peer.Require(stream.Context())
	if err != nil {
		return status.Error(codes.Unauthenticated, err.Error())
	}
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	open := first.GetOpen()
	if open == nil {
		return status.Error(codes.InvalidArgument, "first tunnel frame must open")
	}
	claims, err := b.verifier.Verify(open.Grant, "connect", client)
	if err != nil {
		return status.Error(codes.PermissionDenied, err.Error())
	}
	sessionID, err := randomToken()
	if err != nil {
		return status.Error(codes.Internal, "could not create session id")
	}
	token, err := randomToken()
	if err != nil {
		return status.Error(codes.Internal, "could not create accept token")
	}
	b.mu.Lock()
	snapshot := b.store.Current()
	if err := grant.ValidatePolicy(claims, "connect", snapshot); err != nil {
		b.mu.Unlock()
		return status.Error(codes.PermissionDenied, err.Error())
	}
	route := snapshot.Routes[claims.RouteID]
	if route == nil {
		b.mu.Unlock()
		return status.Error(codes.PermissionDenied, "connect grant route was revoked")
	}
	endpoint := snapshot.Endpoints[route.TargetEndpointId]
	if endpoint == nil {
		b.mu.Unlock()
		return status.Error(codes.PermissionDenied, "connect grant endpoint was revoked")
	}
	frameLimit := minNonZero(DefaultMaxFrameBytes, int(route.MaxFrameBytes), int(claims.MaxFrameBytes))
	trafficClass := routeTrafficClass(route)
	metrics := b.routeMetricsLocked(route.RouteId)
	startedAt := time.Now()
	registration := b.endpoints[endpoint.EndpointId]
	if registration == nil || time.Now().Unix() > registration.expiresAt.Load() {
		metrics.opened.Add(1)
		metrics.touch()
		b.mu.Unlock()
		metrics.recordFailedOpen(time.Since(startedAt))
		return status.Error(codes.Unavailable, "target endpoint is not registered")
	}
	if err := b.sessionCapacityErrorLocked(route, endpoint, claims.MaxConcurrentSessions, registration.maxSessions.Load()); err != nil {
		metrics.throttled.Add(1)
		metrics.touch()
		b.mu.Unlock()
		return err
	}
	if err := b.admission.Admit(trafficClass, route.RouteId, b.usageLocked()); err != nil {
		metrics.throttled.Add(1)
		metrics.touch()
		b.mu.Unlock()
		return status.Error(codes.ResourceExhausted, err.Error())
	}
	metrics.opened.Add(1)
	metrics.touch()
	session := &activeTunnel{routeID: route.RouteId, routeGeneration: route.Generation, sourceKind: route.SourceKind, sourceID: route.SourceId, endpointID: endpoint.EndpointId, endpointGeneration: endpoint.Generation, trafficClass: trafficClass, metrics: metrics, stop: make(chan struct{})}
	pending := &pendingTunnel{endpoint: endpoint, session: session, accepted: make(chan acceptedConnection, 1)}
	metrics.active.Add(1)
	b.pending[token] = pending
	b.active[sessionID] = session
	b.trackSessionLocked(session, 1)
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.pending, token)
		if current := b.active[sessionID]; current != nil {
			b.trackSessionLocked(current, -1)
			delete(b.active, sessionID)
		}
		b.mu.Unlock()
		metrics.recordCompletion(time.Since(startedAt), resultErr)
		b.pruneRouteMetrics(session.routeID, metrics)
		session.close()
	}()
	deadline := time.Now().Add(AcceptTimeout)
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	incoming := &relayv1.IncomingTunnel{SessionId: sessionID, AcceptToken: token, AcceptExpiresAtUnix: deadline.Unix()}
	select {
	case registration.incoming <- incoming:
	case <-registration.stop:
		return status.Error(codes.Unavailable, "target endpoint was revoked")
	case <-session.stop:
		return status.Error(codes.PermissionDenied, "tunnel policy was revoked")
	case <-timer.C:
		return status.Error(codes.DeadlineExceeded, "target endpoint did not accept tunnel")
	case <-stream.Context().Done():
		return stream.Context().Err()
	}
	var accepted acceptedConnection
	select {
	case accepted = <-pending.accepted:
	case <-timer.C:
		return status.Error(codes.DeadlineExceeded, "target endpoint did not accept tunnel")
	case <-session.stop:
		return status.Error(codes.PermissionDenied, "tunnel policy was revoked")
	case <-stream.Context().Done():
		return stream.Context().Err()
	}
	if err := stream.Send(readyFrame(frameLimit)); err != nil {
		accepted.result <- err
		return err
	}
	if err := accepted.stream.Send(readyFrame(frameLimit)); err != nil {
		accepted.result <- err
		return err
	}
	metrics.recordSetup(time.Since(startedAt))
	bridgeErr := bridge(stream, accepted.stream, frameLimit, session.stop, route.DisableIdleTimeout, trafficClass == admission.TrafficClassProxy, metrics)
	accepted.result <- bridgeErr
	return bridgeErr
}

func routeTrafficClass(route *relayv1.RoutePolicy) string {
	if route.TrafficClass == admission.TrafficClassDatabase {
		return admission.TrafficClassDatabase
	}
	if route.TrafficClass == admission.TrafficClassProxy || route.SourceKind == "nginx" {
		return admission.TrafficClassProxy
	}
	return admission.TrafficClassDatabase
}

func (b *Broker) usageLocked() admission.Usage {
	return admission.Usage{ActiveProxy: b.activeProxy, ActiveDatabase: b.activeDatabase, ProxyByRoute: b.proxyByRoute}
}

func (b *Broker) sessionCapacityErrorLocked(route *relayv1.RoutePolicy, endpoint *relayv1.EndpointPolicy, routeGrantLimit, endpointGrantLimit uint32) error {
	if limit := minSessionLimit(route.MaxConcurrentSessions, routeGrantLimit); limit > 0 && b.activeByRoute[route.RouteId] >= uint64(limit) {
		return status.Error(codes.ResourceExhausted, "relay route session capacity reached")
	}
	if limit := minSessionLimit(endpoint.MaxConcurrentSessions, endpointGrantLimit); limit > 0 && b.activeByTarget[endpoint.EndpointId] >= uint64(limit) {
		return status.Error(codes.ResourceExhausted, "relay endpoint session capacity reached")
	}
	return nil
}

func minSessionLimit(policyLimit, grantLimit uint32) uint32 {
	if policyLimit == 0 {
		return grantLimit
	}
	if grantLimit == 0 || policyLimit < grantLimit {
		return policyLimit
	}
	return grantLimit
}

func (b *Broker) trackSessionLocked(tunnel *activeTunnel, delta int) {
	adjustSessionCount(b.activeByRoute, tunnel.routeID, delta)
	adjustSessionCount(b.activeByTarget, tunnel.endpointID, delta)
	if tunnel.trafficClass == admission.TrafficClassProxy {
		if delta > 0 {
			b.activeProxy++
			b.proxyByRoute[tunnel.routeID]++
			return
		}
		b.activeProxy--
		if b.proxyByRoute[tunnel.routeID] <= 1 {
			delete(b.proxyByRoute, tunnel.routeID)
		} else {
			b.proxyByRoute[tunnel.routeID]--
		}
		return
	}
	if delta > 0 {
		b.activeDatabase++
	} else {
		b.activeDatabase--
	}
}

func adjustSessionCount(counts map[string]uint64, id string, delta int) {
	if delta > 0 {
		counts[id]++
		return
	}
	if counts[id] <= 1 {
		delete(counts, id)
		return
	}
	counts[id]--
}

func (b *Broker) AcceptTunnel(stream relayv1.TunnelBroker_AcceptTunnelServer) error {
	client, err := peer.Require(stream.Context())
	if err != nil {
		return status.Error(codes.Unauthenticated, err.Error())
	}
	first, err := stream.Recv()
	if err != nil {
		return err
	}
	accept := first.GetAccept()
	if accept == nil || accept.AcceptToken == "" {
		return status.Error(codes.InvalidArgument, "first tunnel frame must accept")
	}
	b.mu.Lock()
	pending := b.pending[accept.AcceptToken]
	if pending != nil {
		delete(b.pending, accept.AcceptToken)
	}
	b.mu.Unlock()
	if pending == nil {
		return status.Error(codes.NotFound, "accept token is unknown or already used")
	}
	if pending.endpoint.SubjectId != client.SubjectID || pending.endpoint.CertificateSha256 != client.CertificateFingerprint {
		return status.Error(codes.PermissionDenied, "accept token does not match client certificate")
	}
	connection := acceptedConnection{stream: stream, result: make(chan error, 1)}
	select {
	case pending.accepted <- connection:
	case <-pending.session.stop:
		return status.Error(codes.PermissionDenied, "tunnel policy was revoked")
	case <-stream.Context().Done():
		return stream.Context().Err()
	}
	select {
	case result := <-connection.result:
		return result
	case <-stream.Context().Done():
		return stream.Context().Err()
	}
}

func (b *Broker) closeEndpointSessionsLocked(endpointID string) {
	for _, tunnel := range b.active {
		if tunnel.endpointID != endpointID {
			continue
		}
		tunnel.close()
	}
}

type tunnelStream interface {
	tunnelReceiver
	tunnelSender
}

func bridge(left, right tunnelStream, maxFrame int, stopped <-chan struct{}, disableIdleTimeout, reapHalfClosed bool, metrics *routeMetrics) error {
	idleTimeout := IdleTimeout
	halfCloseTimeout := time.Duration(0)
	if disableIdleTimeout {
		idleTimeout = 0
	}
	if reapHalfClosed {
		halfCloseTimeout = ProxyHalfCloseTimeout
	}
	return bridgeWithTimeouts(left, right, maxFrame, stopped, idleTimeout, halfCloseTimeout, metrics)
}

func bridgeWithIdleTimeout(left, right tunnelStream, maxFrame int, stopped <-chan struct{}, idleTimeout time.Duration, metrics *routeMetrics) error {
	return bridgeWithTimeouts(left, right, maxFrame, stopped, idleTimeout, 0, metrics)
}

func bridgeWithTimeouts(left, right tunnelStream, maxFrame int, stopped <-chan struct{}, idleTimeout, halfCloseTimeout time.Duration, metrics *routeMetrics) error {
	results := make(chan pumpResult, 2)
	activity := make(chan struct{}, 1)
	bridgeDone := make(chan struct{})
	defer close(bridgeDone)
	go func() {
		terminal, err := pumpUntil(right, left, maxFrame, activity, bridgeDone, func(bytes uint64) {
			if metrics == nil {
				return
			}
			metrics.sourceToTargetBytes.Add(bytes)
			metrics.touch()
		})
		results <- pumpResult{terminal: terminal, err: err, direction: pumpSourceToTarget}
	}()
	go func() {
		terminal, err := pumpUntil(left, right, maxFrame, activity, bridgeDone, func(bytes uint64) {
			if metrics == nil {
				return
			}
			metrics.targetToSourceBytes.Add(bytes)
			metrics.touch()
		})
		results <- pumpResult{terminal: terminal, err: err, direction: pumpTargetToSource}
	}()
	var timer *time.Timer
	var idle <-chan time.Time
	if idleTimeout > 0 {
		timer = time.NewTimer(idleTimeout)
		idle = timer.C
		defer timer.Stop()
	}
	var halfCloseTimer *time.Timer
	var halfCloseDeadline <-chan time.Time
	defer func() {
		if halfCloseTimer != nil {
			halfCloseTimer.Stop()
		}
	}()
	completedDirections := 0
	for {
		select {
		case result := <-results:
			if err := normalizeBridgeError(result.err); err != nil {
				return err
			}
			if result.terminal {
				return nil
			}
			completedDirections++
			if completedDirections == 2 {
				return nil
			}
			if halfCloseTimeout > 0 && result.direction == pumpTargetToSource && halfCloseTimer == nil {
				halfCloseTimer = time.NewTimer(halfCloseTimeout)
				halfCloseDeadline = halfCloseTimer.C
			}
		case <-activity:
			if halfCloseTimer != nil {
				if !halfCloseTimer.Stop() {
					select {
					case <-halfCloseTimer.C:
					default:
					}
				}
				halfCloseTimer.Reset(halfCloseTimeout)
			}
			if timer == nil {
				continue
			}
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(idleTimeout)
		case <-idle:
			return status.Error(codes.DeadlineExceeded, "tunnel idle timeout reached")
		case <-halfCloseDeadline:
			return status.Error(codes.DeadlineExceeded, "tunnel half-close timeout reached")
		case <-stopped:
			return status.Error(codes.PermissionDenied, "tunnel policy was revoked")
		}
	}
}

type tunnelReceiver interface {
	Recv() (*relayv1.TunnelFrame, error)
}
type tunnelSender interface {
	Send(*relayv1.TunnelFrame) error
}

type pumpResult struct {
	terminal  bool
	err       error
	direction pumpDirection
}

type pumpDirection uint8

const (
	pumpSourceToTarget pumpDirection = iota
	pumpTargetToSource
)

func pump(destination tunnelSender, source tunnelReceiver, maxFrame int, activity chan<- struct{}, recordBytes func(uint64)) (bool, error) {
	return pumpUntil(destination, source, maxFrame, activity, nil, recordBytes)
}

func pumpUntil(destination tunnelSender, source tunnelReceiver, maxFrame int, activity chan<- struct{}, stopped <-chan struct{}, recordBytes func(uint64)) (bool, error) {
	for {
		frame, err := source.Recv()
		if err != nil {
			if err == io.EOF {
				if channelClosed(stopped) {
					return true, nil
				}
				return false, destination.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}})
			}
			// A cancelled or failed gRPC stream is a terminal transport event, not
			// a TCP half-close. Mark it terminal even when normalizeBridgeError
			// later suppresses the expected Canceled status; otherwise the bridge
			// waits forever for the peer direction and leaks session capacity.
			return true, err
		}
		dataBytes := 0
		switch payload := frame.Payload.(type) {
		case *relayv1.TunnelFrame_Data:
			if len(payload.Data.Data) == 0 || len(payload.Data.Data) > maxFrame {
				return false, status.Error(codes.InvalidArgument, "tunnel data frame exceeds negotiated limit")
			}
			dataBytes = len(payload.Data.Data)
		case *relayv1.TunnelFrame_HalfClose, *relayv1.TunnelFrame_Close, *relayv1.TunnelFrame_Error:
		default:
			return false, status.Error(codes.InvalidArgument, "unexpected tunnel frame")
		}
		if channelClosed(stopped) {
			return true, nil
		}
		if err := destination.Send(frame); err != nil {
			return false, err
		}
		if dataBytes > 0 && recordBytes != nil {
			recordBytes(uint64(dataBytes))
		}
		select {
		case activity <- struct{}{}:
		default:
		}
		if frame.GetClose() != nil || frame.GetError() != nil {
			return true, nil
		}
		if frame.GetHalfClose() != nil {
			return false, nil
		}
	}
}

func channelClosed(channel <-chan struct{}) bool {
	if channel == nil {
		return false
	}
	select {
	case <-channel:
		return true
	default:
		return false
	}
}

func normalizeBridgeError(err error) error {
	if err == nil || err == io.EOF || status.Code(err) == codes.Canceled {
		return nil
	}
	return err
}

func readyFrame(maxFrame int) *relayv1.TunnelFrame {
	return &relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_Ready{Ready: &relayv1.TunnelReady{MaxFrameBytes: uint32(maxFrame)}}}
}

func randomToken() (string, error) {
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(value), nil
}

func minNonZero(fallback int, values ...int) int {
	result := fallback
	for _, value := range values {
		if value > 0 && value < result {
			result = value
		}
	}
	return result
}
