package broker

import (
	"context"
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/grant"
	"github.com/wiolett-industries/gateway/relay/internal/peer"
	"github.com/wiolett-industries/gateway/relay/internal/policy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// RegistrationPolicyHold is how long a registration whose grant is ahead of
// this relay's policy waits for that policy before it is refused: Gateway
// pushes the policy to the relays and the grants to the daemons at the same
// time, and either may arrive first.
var RegistrationPolicyHold = 10 * time.Second

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
	// Bound to the policy below, where a grant ahead of the policy may wait for it.
	claims, err := b.verifier.VerifyEnvelope(register.Grant, "endpoint", client)
	if err != nil {
		return status.Error(codes.PermissionDenied, err.Error())
	}
	registration := &endpointRegistration{endpointID: claims.EndpointID, subjectID: claims.SubjectID, generation: claims.EndpointGeneration, assignmentGeneration: claims.AssignmentGeneration, incoming: make(chan *relayv1.IncomingTunnel, 32), stop: make(chan struct{}), restarting: make(chan struct{}), recheck: make(chan struct{}, 1)}
	registration.state.Store(int32(servingState(register.GetState())))
	registration.expiresAt.Store(claims.ExpiresAt)
	registration.maxSessions.Store(claims.MaxConcurrentSessions)
	b.mu.Lock()
	snapshot, err := b.awaitPolicyLocked(stream.Context(), claims)
	if err != nil {
		b.mu.Unlock()
		return err
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
		if previous.generation >= registration.generation {
			// The same generation registers again (a reconnect): the tunnels
			// of the previous registration ran over the connection that ended.
			b.closeRegistrationSessionsLocked(previous)
		}
		// A previous generation's tunnels keep running over its connection
		// until they end (make-before-break).
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
				b.closeRegistrationSessionsLocked(registration)
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
		var renew *relayv1.RenewEndpoint
		select {
		case <-registration.stop:
			return status.Error(codes.Aborted, registration.revokedMessage())
		case <-stream.Context().Done():
			return stream.Context().Err()
		case err := <-receiveErr:
			return err
		case message := <-received:
			if renew = message.GetRenew(); renew == nil {
				return status.Error(codes.InvalidArgument, "endpoint control accepts only renew after registration")
			}
		case <-registration.recheck:
			b.mu.Lock()
			renew = registration.pending
			b.mu.Unlock()
			if renew == nil {
				continue
			}
		case incoming := <-registration.incoming:
			if err := stream.Send(&relayv1.EndpointControl{Payload: &relayv1.EndpointControl_Incoming{Incoming: incoming}}); err != nil {
				return err
			}
			continue
		}
		applied, err := b.applyRenewal(registration, registrationKey, client, renew)
		if err != nil {
			return err
		}
		if applied {
			if err := sendRegistered(stream, registration); err != nil {
				return err
			}
		}
	}
}

// awaitPolicyLocked validates a registration's grant against this relay's
// policy. A grant ahead of the policy waits for it, up to
// RegistrationPolicyHold, and passes the moment the policy arrives instead of
// being refused and retried later (a gap of one retry on every change).
// Called with mu held; returns with mu held.
func (b *Broker) awaitPolicyLocked(ctx context.Context, claims grant.Claims) (*policy.Snapshot, error) {
	holdUntil := time.Now().Add(RegistrationPolicyHold)
	for {
		snapshot := b.store.Current()
		err := grant.ValidatePolicy(claims, "endpoint", snapshot)
		if err == nil {
			return snapshot, nil
		}
		if !policyAhead(claims, snapshot) || !time.Now().Before(holdUntil) {
			return nil, status.Error(codes.PermissionDenied, err.Error())
		}
		changed := b.policyChanged
		b.mu.Unlock()
		// Re-checked every half second too, should a policy change arrive
		// through a path that does not signal it.
		timer := time.NewTimer(min(time.Until(holdUntil), 500*time.Millisecond))
		select {
		case <-changed:
		case <-timer.C:
		case <-ctx.Done():
		}
		timer.Stop()
		b.mu.Lock()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
	}
}

// applyRenewal applies a renewal to a live registration and reports whether
// it did (the relay then confirms it). A renewal whose grant is ahead of this
// relay's policy is kept and applied once the policy arrives. A registration
// its policy superseded keeps serving on its previous grant until the new
// generation registers; a new generation's grant renews it in place when this
// connection may use it. Any other refusal ends the registration.
func (b *Broker) applyRenewal(registration *endpointRegistration, registrationKey string, client peer.Identity, renew *relayv1.RenewEndpoint) (bool, error) {
	next, verifyErr := b.verifier.VerifyEnvelope(renew.Grant, "endpoint", client)
	if verifyErr != nil {
		if registration.supersededAt.Load() != 0 {
			// The new generation's grant names a certificate this connection
			// does not hold (the daemon's certificate rotated): the previous
			// registration serves on until the daemon registers the new
			// generation over a connection with its new certificate.
			return false, nil
		}
		return false, status.Error(codes.PermissionDenied, verifyErr.Error())
	}
	if next.EndpointID != registration.endpointID || next.AssignmentGeneration != registration.assignmentGeneration {
		return false, status.Error(codes.FailedPrecondition, "renewal changes endpoint identity")
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.endpoints[registrationKey] != registration {
		return false, status.Error(codes.Aborted, "endpoint policy was revoked")
	}
	if next.EndpointGeneration < registration.generation {
		// A grant older than the registration: nothing to apply.
		return false, nil
	}
	current := b.store.Current()
	if err := grant.ValidatePolicy(next, "endpoint", current); err != nil {
		switch {
		case policyAhead(next, current):
			registration.pending = renew
			return false, nil
		case registration.supersededAt.Load() != 0 && next.EndpointGeneration == registration.generation:
			// The previous generation's grant renews the registration that
			// serves until the new generation registers.
		default:
			return false, status.Error(codes.PermissionDenied, err.Error())
		}
	}
	registration.pending = nil
	if next.EndpointGeneration > registration.generation {
		// Renewed in place into the new generation (make-before-break).
		registration.generation = next.EndpointGeneration
		registration.subjectID = next.SubjectID
		registration.supersededAt.Store(0)
	}
	if renew.GetState() == relayv1.EndpointServingState_ENDPOINT_SERVING_STATE_RESTARTING {
		// The daemon restarts (service restart, update): keep the
		// registration and its serving state, refuse new tunnels with a
		// retryable answer until the next process registers (B-13).
		registration.announceRestart(time.Now())
		registration.expiresAt.Store(next.ExpiresAt)
		return true, nil
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
			return false, err
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
	return true, nil
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
			b.closeRegistrationSessionsLocked(registration)
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
