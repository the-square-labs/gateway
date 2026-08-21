package admin

import (
	"context"
	"time"

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
	runtime := s.broker.RuntimeSnapshot()
	var policyExpiresAtUnix int64
	if !current.ExpiresAt.IsZero() {
		policyExpiresAtUnix = current.ExpiresAt.Unix()
	}
	ready := s.store.Ready(time.Now()) && len(current.PublicKeys) > 0
	reason := ""
	if !ready {
		if err := s.store.AdmissionError(time.Now()); err != nil {
			reason = err.Error()
		} else {
			reason = "grant_public_keys_required"
		}
	}
	return &relayv1.HealthResponse{
		BuildVersion: s.buildVersion, ProtocolMajor: 1, AppliedRevision: current.Revision,
		KeyIds: s.store.KeyIDs(), RegisteredEndpoints: runtime.RegisteredEndpoints,
		ActiveTunnels: runtime.ActiveTunnels, ActiveProxyTunnels: runtime.ActiveProxyTunnels,
		ActiveDatabaseTunnels:  runtime.ActiveDatabaseTunnels,
		ThrottledProxyTotal:    runtime.Admission.ThrottledProxyTotal,
		ThrottledDatabaseTotal: runtime.Admission.ThrottledDatabaseTotal,
		PressurePercent:        runtime.Admission.PressurePercent,
		CpuPressurePercent:     runtime.Admission.CPUPressurePercent,
		MemoryPressurePercent:  runtime.Admission.MemoryPressurePercent,
		FdPressurePercent:      runtime.Admission.FDPressurePercent,
		AdmissionState:         runtime.Admission.State,
		MemoryRssBytes:         runtime.Admission.MemoryRSSBytes,
		HeapInUseBytes:         runtime.Admission.HeapInUseBytes,
		MemoryLimitBytes:       runtime.Admission.MemoryLimitBytes,
		OpenFileDescriptors:    runtime.Admission.OpenFileDescriptors,
		FileDescriptorLimit:    runtime.Admission.FileDescriptorLimit,
		Liveness:               true, Readiness: ready, Reason: reason,
		PoolId: current.PoolID, RelayInstanceId: current.RelayInstanceID, Mode: current.Mode,
		PolicyExpiresAtUnix: policyExpiresAtUnix, Capabilities: []string{policy.PoolCapability, "signed_policy_envelope_v1"},
		Draining: runtime.Draining,
		PolicyKeyIds: s.store.PolicyKeyIDs(),
		AssignmentTunnels: func() []*relayv1.AssignmentTunnelCount {
			result := make([]*relayv1.AssignmentTunnelCount, 0, len(runtime.AssignmentTunnels))
			for _, count := range runtime.AssignmentTunnels {
				result = append(result, &relayv1.AssignmentTunnelCount{
					EndpointId: count.EndpointID, AssignmentGeneration: count.AssignmentGeneration, ActiveTunnels: count.ActiveTunnels,
				})
			}
			return result
		}(),
	}, nil
}

func (s *Service) GetRouteRuntime(ctx context.Context, request *relayv1.RouteRuntimeRequest) (*relayv1.RouteRuntimeResponse, error) {
	if err := s.authorize(ctx); err != nil {
		return nil, err
	}
	if request.GetRouteId() == "" {
		return nil, status.Error(codes.InvalidArgument, "route id is required")
	}
	runtime, found := s.broker.RouteRuntimeSnapshot(request.GetRouteId())
	if !found {
		return nil, status.Error(codes.NotFound, "relay route is not active")
	}
	return &relayv1.RouteRuntimeResponse{
		RouteId:                      runtime.RouteID,
		ActiveTunnels:                runtime.ActiveTunnels,
		OpenedTotal:                  runtime.OpenedTotal,
		CompletedTotal:               runtime.CompletedTotal,
		FailedTotal:                  runtime.FailedTotal,
		ThrottledTotal:               runtime.ThrottledTotal,
		SourceToTargetBytes:          runtime.SourceToTargetBytes,
		TargetToSourceBytes:          runtime.TargetToSourceBytes,
		SetupLatencyP95Microseconds:  runtime.SetupLatencyP95Micros,
		AverageDurationMilliseconds:  runtime.AverageDurationMillis,
		LastActivityUnixMilliseconds: runtime.LastActivityUnixMillis,
		MetricsSinceUnixMilliseconds: runtime.MetricsSinceUnixMillis,
	}, nil
}

func (s *Service) ApplySnapshot(ctx context.Context, request *relayv1.ApplySnapshotRequest) (*relayv1.ApplySnapshotResponse, error) {
	if err := s.authorize(ctx); err != nil {
		return nil, err
	}
	next, unchanged, err := s.broker.ApplySnapshot(request)
	if err != nil {
		return nil, status.Error(codes.FailedPrecondition, err.Error())
	}
	var policyExpiresAtUnix int64
	if !next.ExpiresAt.IsZero() {
		policyExpiresAtUnix = next.ExpiresAt.Unix()
	}
	return &relayv1.ApplySnapshotResponse{
		AppliedRevision: next.Revision, Unchanged: unchanged, PoolId: next.PoolID,
		RelayInstanceId: next.RelayInstanceID, PolicyExpiresAtUnix: policyExpiresAtUnix,
	}, nil
}

func (s *Service) BootstrapPolicyTrust(ctx context.Context, request *relayv1.BootstrapPolicyTrustRequest) (*relayv1.BootstrapPolicyTrustResponse, error) {
	if err := s.authorize(ctx); err != nil {
		return nil, err
	}
	unchanged, err := s.store.BootstrapPolicyTrust(request.KeyId, request.PublicKey, request.PublicKeyFingerprint)
	if err != nil {
		return nil, status.Error(codes.FailedPrecondition, err.Error())
	}
	return &relayv1.BootstrapPolicyTrustResponse{
		KeyId: request.KeyId, PublicKeyFingerprint: request.PublicKeyFingerprint, Unchanged: unchanged,
	}, nil
}

func (s *Service) SetDrain(ctx context.Context, request *relayv1.SetDrainRequest) (*relayv1.SetDrainResponse, error) {
	if err := s.authorize(ctx); err != nil {
		return nil, err
	}
	s.broker.SetDraining(request.Draining)
	var disconnected uint64
	if request.GetForceDisconnect() {
		if !request.GetDraining() {
			return nil, status.Error(codes.FailedPrecondition, "force disconnect requires drain mode")
		}
		disconnected = s.broker.ForceDisconnect()
	}
	return &relayv1.SetDrainResponse{Draining: s.broker.Draining(), DisconnectedTunnels: disconnected}, nil
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
