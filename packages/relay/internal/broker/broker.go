package broker

import (
	"crypto/rand"
	"encoding/base64"
	"io"
	"sync"
	"sync/atomic"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/grant"
	"github.com/wiolett-industries/gateway/relay/internal/peer"
	"github.com/wiolett-industries/gateway/relay/internal/policy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const (
	DefaultMaxFrameBytes = 1024 * 1024
	AcceptTimeout        = 30 * time.Second
	IdleTimeout          = 5 * time.Minute
)

type endpointRegistration struct {
	endpointID string
	generation uint64
	expiresAt  atomic.Int64
	incoming   chan *relayv1.IncomingTunnel
	stop       chan struct{}
	stopOnce   sync.Once
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
	stop               chan struct{}
	stopOnce           sync.Once
}

func (t *activeTunnel) close() { t.stopOnce.Do(func() { close(t.stop) }) }

type Broker struct {
	relayv1.UnimplementedTunnelBrokerServer
	store     *policy.Store
	verifier  grant.Verifier
	mu        sync.Mutex
	endpoints map[string]*endpointRegistration
	pending   map[string]*pendingTunnel
	active    map[string]*activeTunnel
}

func New(store *policy.Store) *Broker {
	return &Broker{store: store, verifier: grant.Verifier{Store: store}, endpoints: map[string]*endpointRegistration{}, pending: map[string]*pendingTunnel{}, active: map[string]*activeTunnel{}}
}

func (b *Broker) Counts() (uint64, uint64) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return uint64(len(b.endpoints)), uint64(len(b.active))
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

func (b *Broker) OpenTunnel(stream relayv1.TunnelBroker_OpenTunnelServer) error {
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
	session := &activeTunnel{routeID: route.RouteId, routeGeneration: route.Generation, sourceKind: route.SourceKind, sourceID: route.SourceId, endpointID: endpoint.EndpointId, endpointGeneration: endpoint.Generation, stop: make(chan struct{})}
	pending := &pendingTunnel{endpoint: endpoint, session: session, accepted: make(chan acceptedConnection, 1)}
	registration := b.endpoints[endpoint.EndpointId]
	if registration == nil || time.Now().Unix() > registration.expiresAt.Load() {
		b.mu.Unlock()
		return status.Error(codes.Unavailable, "target endpoint is not registered")
	}
	b.pending[token] = pending
	b.active[sessionID] = session
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.pending, token)
		delete(b.active, sessionID)
		b.mu.Unlock()
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
	bridgeErr := bridge(stream, accepted.stream, frameLimit, session.stop, route.DisableIdleTimeout)
	accepted.result <- bridgeErr
	return bridgeErr
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

func bridge(left, right tunnelStream, maxFrame int, stopped <-chan struct{}, disableIdleTimeout bool) error {
	idleTimeout := IdleTimeout
	if disableIdleTimeout {
		idleTimeout = 0
	}
	return bridgeWithIdleTimeout(left, right, maxFrame, stopped, idleTimeout)
}

func bridgeWithIdleTimeout(left, right tunnelStream, maxFrame int, stopped <-chan struct{}, idleTimeout time.Duration) error {
	results := make(chan pumpResult, 2)
	activity := make(chan struct{}, 1)
	go func() {
		terminal, err := pump(right, left, maxFrame, activity)
		results <- pumpResult{terminal: terminal, err: err}
	}()
	go func() {
		terminal, err := pump(left, right, maxFrame, activity)
		results <- pumpResult{terminal: terminal, err: err}
	}()
	var timer *time.Timer
	var idle <-chan time.Time
	if idleTimeout > 0 {
		timer = time.NewTimer(idleTimeout)
		idle = timer.C
		defer timer.Stop()
	}
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
		case <-activity:
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
	terminal bool
	err      error
}

func pump(destination tunnelSender, source tunnelReceiver, maxFrame int, activity chan<- struct{}) (bool, error) {
	for {
		frame, err := source.Recv()
		if err != nil {
			if err == io.EOF {
				return false, destination.Send(&relayv1.TunnelFrame{Payload: &relayv1.TunnelFrame_HalfClose{HalfClose: &relayv1.TunnelHalfClose{}}})
			}
			// A cancelled or failed gRPC stream is a terminal transport event, not
			// a TCP half-close. Mark it terminal even when normalizeBridgeError
			// later suppresses the expected Canceled status; otherwise the bridge
			// waits forever for the peer direction and leaks session capacity.
			return true, err
		}
		switch payload := frame.Payload.(type) {
		case *relayv1.TunnelFrame_Data:
			if len(payload.Data.Data) == 0 || len(payload.Data.Data) > maxFrame {
				return false, status.Error(codes.InvalidArgument, "tunnel data frame exceeds negotiated limit")
			}
		case *relayv1.TunnelFrame_HalfClose, *relayv1.TunnelFrame_Close, *relayv1.TunnelFrame_Error:
		default:
			return false, status.Error(codes.InvalidArgument, "unexpected tunnel frame")
		}
		if err := destination.Send(frame); err != nil {
			return false, err
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
