package admin

import (
	"context"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/broker"
	"github.com/wiolett-industries/gateway/relay/internal/identity"
	"github.com/wiolett-industries/gateway/relay/internal/peer"
	"github.com/wiolett-industries/gateway/relay/internal/policy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type Service struct {
	relayv1.UnimplementedRelayAdminServer
	store        *policy.Store
	broker       *broker.Broker
	identity     *identity.Store
	reloadApp    func() error
	buildVersion string
}

func New(store *policy.Store, broker *broker.Broker, identityStore *identity.Store, reloadApp func() error, buildVersion string) *Service {
	return &Service{store: store, broker: broker, identity: identityStore, reloadApp: reloadApp, buildVersion: buildVersion}
}

func (s *Service) caller(ctx context.Context) (peer.Identity, error) {
	caller, ok := peer.FromContext(ctx)
	if !ok {
		return peer.Identity{}, status.Error(codes.Unauthenticated, "Gateway app service certificate required")
	}
	if !s.identity.AuthorizeAppClient(caller.CertificateFingerprint) {
		return peer.Identity{}, status.Error(codes.PermissionDenied, "Gateway app service certificate required")
	}
	return caller, nil
}

func (s *Service) authorize(ctx context.Context) error {
	_, err := s.caller(ctx)
	return err
}

func (s *Service) GetHealth(ctx context.Context, _ *relayv1.HealthRequest) (*relayv1.HealthResponse, error) {
	if err := s.authorize(ctx); err != nil {
		return nil, err
	}
	current := s.store.Current()
	endpoints, tunnels := s.broker.Counts()
	ready := current.Revision > 0 && len(current.PublicKeys) > 0
	reason := ""
	if !ready {
		reason = "policy_snapshot_required"
	}
	return &relayv1.HealthResponse{BuildVersion: s.buildVersion, ProtocolMajor: 1, AppliedRevision: current.Revision, KeyIds: s.store.KeyIDs(), RegisteredEndpoints: endpoints, ActiveTunnels: tunnels, Liveness: true, Readiness: ready, Reason: reason}, nil
}

func (s *Service) ApplySnapshot(ctx context.Context, request *relayv1.ApplySnapshotRequest) (*relayv1.ApplySnapshotResponse, error) {
	if err := s.authorize(ctx); err != nil {
		return nil, err
	}
	next, unchanged, err := s.broker.ApplySnapshot(request)
	if err != nil {
		return nil, status.Error(codes.FailedPrecondition, err.Error())
	}
	return &relayv1.ApplySnapshotResponse{AppliedRevision: next.Revision, Unchanged: unchanged}, nil
}

func (s *Service) ReloadIdentity(ctx context.Context, request *relayv1.ReloadIdentityRequest) (*relayv1.ReloadIdentityResponse, error) {
	if err := s.authorize(ctx); err != nil {
		return nil, err
	}
	if err := s.identity.Reload(request.OperationId); err != nil {
		return nil, status.Error(codes.FailedPrecondition, err.Error())
	}
	// Existing upstream transports presented the previous relay client leaf.
	// Force the next proxied RPC to establish TLS with the newly loaded leaf
	// before Gateway commits its staged fingerprint trust.
	if err := s.reloadApp(); err != nil {
		return nil, status.Error(codes.Unavailable, "relay app client identity reload failed")
	}
	return &relayv1.ReloadIdentityResponse{Reloaded: true}, nil
}

func (s *Service) CommitIdentityRotation(ctx context.Context, request *relayv1.CommitIdentityRotationRequest) (*relayv1.CommitIdentityRotationResponse, error) {
	caller, err := s.caller(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.identity.CommitAppClientRotation(request.OperationId, caller.CertificateFingerprint); err != nil {
		return nil, status.Error(codes.FailedPrecondition, err.Error())
	}
	return &relayv1.CommitIdentityRotationResponse{Committed: true}, nil
}
