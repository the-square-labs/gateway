package broker

import (
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
	registration := &endpointRegistration{endpointID: claims.EndpointID, generation: claims.EndpointGeneration, assignmentGeneration: claims.AssignmentGeneration, incoming: make(chan *relayv1.IncomingTunnel, 32), stop: make(chan struct{})}
	registration.expiresAt.Store(claims.ExpiresAt)
	registration.maxSessions.Store(claims.MaxConcurrentSessions)
	b.mu.Lock()
	if err := grant.ValidatePolicy(claims, "endpoint", b.store.Current()); err != nil {
		b.mu.Unlock()
		return status.Error(codes.PermissionDenied, err.Error())
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
			delete(b.endpoints, key)
			b.closeEndpointSessionsLocked(registration.endpointID, registration.assignmentGeneration)
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
			if next.EndpointID != registration.endpointID || next.EndpointGeneration != registration.generation || next.AssignmentGeneration != registration.assignmentGeneration {
				return status.Error(codes.FailedPrecondition, "renewal changes endpoint identity")
			}
			b.mu.Lock()
			if b.endpoints[registrationKey] != registration {
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
