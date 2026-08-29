package broker

import (
	"fmt"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/admission"
	"github.com/wiolett-industries/gateway/relay/internal/config"
	"github.com/wiolett-industries/gateway/relay/internal/grant"
	"github.com/wiolett-industries/gateway/relay/internal/peer"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

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
	if b.draining.Load() {
		return status.Error(codes.Unavailable, "relay is draining")
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
	route := snapshot.Route(claims.RouteID, claims.AssignmentGeneration)
	if route == nil {
		b.mu.Unlock()
		return status.Error(codes.PermissionDenied, "connect grant route was revoked")
	}
	endpoint := snapshot.Endpoint(route.TargetEndpointId, claims.AssignmentGeneration)
	if endpoint == nil {
		b.mu.Unlock()
		return status.Error(codes.PermissionDenied, "connect grant endpoint was revoked")
	}
	frameLimit := minNonZero(DefaultMaxFrameBytes, int(route.MaxFrameBytes), int(claims.MaxFrameBytes))
	trafficClass := routeTrafficClass(route)
	metrics := b.routeMetricsLocked(route.RouteId)
	startedAt := time.Now()
	if endpoint.SubjectKind == "local_service" {
		target, targetErr := config.BuiltinLocalServiceTarget(endpoint.SubjectId)
		if targetErr != nil {
			metrics.opened.Add(1)
			metrics.touch()
			b.mu.Unlock()
			metrics.recordFailedOpen(time.Since(startedAt))
			return status.Error(codes.PermissionDenied, targetErr.Error())
		}
		if err := b.sessionCapacityErrorLocked(route, endpoint, claims.MaxConcurrentSessions, endpoint.MaxConcurrentSessions); err != nil {
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
		session := &activeTunnel{routeID: route.RouteId, routeGeneration: route.Generation, sourceKind: route.SourceKind, sourceID: route.SourceId, endpointID: endpoint.EndpointId, endpointGeneration: endpoint.Generation, assignmentGeneration: claims.AssignmentGeneration, trafficClass: trafficClass, metrics: metrics, stop: make(chan struct{})}
		metrics.active.Add(1)
		b.active[sessionID] = session
		b.trackSessionLocked(session, 1)
		b.mu.Unlock()
		defer func() {
			b.mu.Lock()
			if current := b.active[sessionID]; current != nil {
				b.trackSessionLocked(current, -1)
				delete(b.active, sessionID)
			}
			b.mu.Unlock()
			metrics.recordCompletion(time.Since(startedAt), resultErr)
			b.pruneRouteMetrics(session.routeID, metrics)
			session.close()
		}()
		connection, dialErr := b.dialLocalService(stream.Context(), target.Target)
		if dialErr != nil {
			return status.Error(codes.Unavailable, "built-in local service is unavailable")
		}
		defer connection.Close()
		if err := stream.Send(readyFrame(frameLimit)); err != nil {
			return err
		}
		resultErr = bridge(stream, &connectionTunnelStream{connection: connection, maxFrame: frameLimit}, frameLimit, session.stop, route.DisableIdleTimeout, false, metrics)
		return resultErr
	}
	registration := b.endpoints[policyAssignmentKey(endpoint.EndpointId, claims.AssignmentGeneration)]
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
	session := &activeTunnel{routeID: route.RouteId, routeGeneration: route.Generation, sourceKind: route.SourceKind, sourceID: route.SourceId, endpointID: endpoint.EndpointId, endpointGeneration: endpoint.Generation, assignmentGeneration: claims.AssignmentGeneration, trafficClass: trafficClass, metrics: metrics, stop: make(chan struct{})}
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
	if route.TrafficClass == admission.TrafficClassRegistry {
		return admission.TrafficClassRegistry
	}
	if route.TrafficClass == admission.TrafficClassDatabase {
		return admission.TrafficClassDatabase
	}
	if route.TrafficClass == admission.TrafficClassProxy || route.SourceKind == "nginx" {
		return admission.TrafficClassProxy
	}
	return admission.TrafficClassDatabase
}

func (b *Broker) usageLocked() admission.Usage {
	return admission.Usage{ActiveProxy: b.activeProxy, ActiveDatabase: b.activeDatabase, ActiveRegistry: b.activeRegistry, ProxyByRoute: b.proxyByRoute, RegistryByRoute: b.registryByRoute}
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
	if tunnel.trafficClass == admission.TrafficClassRegistry {
		if delta > 0 {
			b.activeRegistry++
			b.registryByRoute[tunnel.routeID]++
			return
		}
		b.activeRegistry--
		if b.registryByRoute[tunnel.routeID] <= 1 {
			delete(b.registryByRoute, tunnel.routeID)
		} else {
			b.registryByRoute[tunnel.routeID]--
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

func policyAssignmentKey(id string, generation uint64) string {
	if generation == 0 {
		return id
	}
	return fmt.Sprintf("%s:%d", id, generation)
}

func (b *Broker) closeEndpointSessionsLocked(endpointID string, assignmentGenerations ...uint64) {
	for _, tunnel := range b.active {
		if tunnel.endpointID != endpointID ||
			(len(assignmentGenerations) > 0 && tunnel.assignmentGeneration != assignmentGenerations[0]) {
			continue
		}
		tunnel.close()
	}
}
