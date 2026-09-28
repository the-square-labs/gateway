package broker

import (
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/grant"
	"github.com/wiolett-industries/gateway/relay/internal/peer"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

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
	registration := &endpointRegistration{endpointID: claims.EndpointID, generation: claims.EndpointGeneration, assignmentGeneration: claims.AssignmentGeneration, incoming: make(chan *relayv1.IncomingTunnel, 32), stop: make(chan struct{}), restarting: make(chan struct{})}
	registration.state.Store(int32(servingState(register.GetState())))
	registration.expiresAt.Store(claims.ExpiresAt)
	registration.maxSessions.Store(claims.MaxConcurrentSessions)
	b.mu.Lock()
	snapshot := b.store.Current()
	if err := grant.ValidatePolicy(claims, "endpoint", snapshot); err != nil {
		b.mu.Unlock()
		return status.Error(codes.PermissionDenied, err.Error())
	}
	// An endpoint that does not state whether it serves registers a
	// lease-bound placement only while this relay's lease gate is open for it
	// (A2.4, A8, A11). A dormant or serving registration is kept whatever the
	// gate says: tunnels to it are gated instead, so a successor is already
	// registered on every relay when it takes over (D7).
	if !registration.stateful() {
		if err := b.endpointLeaseErrorLocked(snapshot.Endpoint(claims.EndpointID, claims.AssignmentGeneration)); err != nil {
			b.mu.Unlock()
			return err
		}
	}
	registrationKey := policyAssignmentKey(claims.EndpointID, claims.AssignmentGeneration)
	if previous := b.endpoints[registrationKey]; previous != nil {
		previous.close()
		b.closeEndpointSessionsLocked(claims.EndpointID, claims.AssignmentGeneration)
	}
	b.endpoints[registrationKey] = registration
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		key := policyAssignmentKey(registration.endpointID, registration.assignmentGeneration)
		if b.endpoints[key] == registration {
			if registration.restartingAt(time.Now()) {
				// The daemon announced a restart (B-13): the registration stays
				// until its next process registers again, answering new tunnels
				// "restarting" meanwhile, or until the grace ends. The tunnels
				// of the old process end with its connections.
				b.forgetRestartedLater(key, registration)
			} else {
				delete(b.endpoints, key)
				b.closeEndpointSessionsLocked(registration.endpointID, registration.assignmentGeneration)
			}
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
			return status.Error(codes.Aborted, registration.revokedMessage())
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
			if next.EndpointID != registration.endpointID || next.EndpointGeneration != registration.generation || next.AssignmentGeneration != registration.assignmentGeneration {
				return status.Error(codes.FailedPrecondition, "renewal changes endpoint identity")
			}
			b.mu.Lock()
			if b.endpoints[registrationKey] != registration {
				b.mu.Unlock()
				return status.Error(codes.Aborted, "endpoint policy was revoked")
			}
			current := b.store.Current()
			if err := grant.ValidatePolicy(next, "endpoint", current); err != nil {
				b.mu.Unlock()
				return status.Error(codes.PermissionDenied, err.Error())
			}
			if renew.GetState() == relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_RESTARTING {
				// The daemon restarts (service restart, update): keep the
				// registration and its serving state, refuse new tunnels with a
				// retryable answer until the next process registers (B-13).
				registration.announceRestart(time.Now())
				registration.expiresAt.Store(next.ExpiresAt)
				b.mu.Unlock()
				if err := sendRegistered(stream, registration); err != nil {
					return err
				}
				continue
			}
			// Any other renewal means the daemon serves on (or stops serving)
			// without restarting after all.
			registration.restartingSince.Store(0)
			state := servingState(renew.GetState())
			if state == relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_UNSPECIFIED && registration.stateful() {
				// The endpoint's policy left lease mode (its link is plain again)
				// while the registration serves: it keeps serving in place, with
				// its tunnels, instead of falling back to the rule that drops a
				// registration the gate does not admit (B-12b, make-before-break).
				state = relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING
			}
			if state == relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_UNSPECIFIED {
				if err := b.endpointLeaseErrorLocked(current.Endpoint(next.EndpointID, next.AssignmentGeneration)); err != nil {
					b.mu.Unlock()
					return err
				}
			}
			if previous := registration.servingState(); previous != state {
				registration.state.Store(int32(state))
				if state == relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT {
					// The endpoint stopped serving (released, fenced or no longer
					// ready): no tunnel admitted before stays open.
					b.closeEndpointSessionsLocked(registration.endpointID, registration.assignmentGeneration)
				}
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

// forgetRestartedLater removes a restarting registration whose daemon did not
// register again within the grace.
func (b *Broker) forgetRestartedLater(key string, registration *endpointRegistration) {
	since := time.Unix(0, registration.restartingSince.Load())
	time.AfterFunc(time.Until(since.Add(EndpointRestartGrace)), func() {
		b.mu.Lock()
		defer b.mu.Unlock()
		if b.endpoints[key] == registration {
			delete(b.endpoints, key)
			b.closeEndpointSessionsLocked(registration.endpointID, registration.assignmentGeneration)
		}
	})
}

// servingState maps states this relay does not know to DORMANT: an endpoint
// that sends a state the relay cannot read never receives traffic by mistake.
func servingState(state relayv1.EndpointServingState) relayv1.EndpointServingState {
	switch state {
	case relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_UNSPECIFIED,
		relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT,
		relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_SERVING:
		return state
	}
	return relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_DORMANT
}

func sendRegistered(stream relayv1.TunnelBroker_RegisterEndpointServer, registration *endpointRegistration) error {
	return stream.Send(&relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Registered{Registered: &relayv1.EndpointRegistered{EndpointId: registration.endpointID, GrantExpiresAtUnix: registration.expiresAt.Load()}}})
}
