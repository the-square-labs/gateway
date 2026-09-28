package broker

import (
	"time"

	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
	"github.com/wiolett-industries/gateway/relay/internal/policy"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// LeaseAdmission is the availability lease data-path gate for one subject of
// one policy (A2.4, A8, A11).
type LeaseAdmission struct {
	// LeaseMode is false when no lease manifest is in force for the policy
	// (it was lease-closed): legacy admission applies.
	LeaseMode bool
	// Open admits the subject: it is the committed holder of a slot and the
	// relay's own promise of that ballot is fresh.
	Open bool
	// Remaining is how long an open gate stays open unless refreshed.
	Remaining time.Duration
	Reason    string
}

// LeaseGate is the relay's availability lease coordinator.
type LeaseGate interface {
	Admit(policyID, subjectID string) LeaseAdmission
	// ApplyPolicy adopts the lease blocks and policy keys of a snapshot. It
	// must not call back into the broker synchronously.
	ApplyPolicy(snapshot *policy.Snapshot)
	Coordinate(stream relayv1.TunnelBroker_CoordinateServer) error
	WatchLeaseGates(request *relayv1.LeaseGateWatchRequest, stream relayv1.TunnelBroker_WatchLeaseGatesServer) error
}

// SetLeaseGate installs the lease coordinator before the server starts.
func (b *Broker) SetLeaseGate(gate LeaseGate) { b.lease = gate }

func (b *Broker) Coordinate(stream relayv1.TunnelBroker_CoordinateServer) error {
	if b.lease == nil {
		return status.Error(codes.Unavailable, "availability lease coordination is not running on this relay")
	}
	return b.lease.Coordinate(stream)
}

func (b *Broker) WatchLeaseGates(request *relayv1.LeaseGateWatchRequest, stream relayv1.TunnelBroker_WatchLeaseGatesServer) error {
	if b.lease == nil {
		return status.Error(codes.Unavailable, "availability lease coordination is not running on this relay")
	}
	return b.lease.WatchLeaseGates(request, stream)
}

// leaseErrorLocked returns nil when policyID is empty (a placement that is not
// lease-bound keeps today's admission), when the policy is not in lease mode,
// or when the gate is open for subjectID.
func (b *Broker) leaseErrorLocked(policyID, subjectID string) error {
	if policyID == "" {
		return nil
	}
	if b.lease == nil {
		return status.Error(codes.FailedPrecondition, "availability lease gate closed: lease coordination is not running")
	}
	admission := b.lease.Admit(policyID, subjectID)
	if !admission.LeaseMode || admission.Open {
		return nil
	}
	return status.Error(codes.FailedPrecondition, "availability lease gate closed: "+admission.Reason)
}

func (b *Broker) endpointLeaseErrorLocked(endpoint *relayv1.EndpointPolicy) error {
	if endpoint == nil {
		return nil
	}
	return b.leaseErrorLocked(endpoint.LeasePolicyId, endpoint.SubjectId)
}

// tunnelLeaseErrorLocked gates a tunnel on its target endpoint's lease (Secure
// Link traffic to a placement) and on its route source's lease (managed-DB
// tunnels opened by a placement).
func (b *Broker) tunnelLeaseErrorLocked(route *relayv1.RoutePolicy, endpoint *relayv1.EndpointPolicy) error {
	if err := b.endpointLeaseErrorLocked(endpoint); err != nil {
		return err
	}
	if route == nil {
		return nil
	}
	return b.leaseErrorLocked(route.LeasePolicyId, route.SourceId)
}

// EnforceLeaseGates drops every endpoint registration and closes every tunnel
// whose lease gate is closed or superseded (A8). It returns how long until
// the earliest open gate closes unless refreshed, or zero when no admitted
// registration or tunnel depends on a gate.
func (b *Broker) EnforceLeaseGates() time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.enforceLeaseGatesLocked()
}

func (b *Broker) enforceLeaseGatesLocked() time.Duration {
	if b.lease == nil {
		return 0
	}
	snapshot := b.store.Current()
	decisions := map[[2]string]LeaseAdmission{}
	var next time.Duration
	open := func(policyID, subjectID string) (bool, string) {
		if policyID == "" {
			return true, ""
		}
		id := [2]string{policyID, subjectID}
		admission, ok := decisions[id]
		if !ok {
			admission = b.lease.Admit(policyID, subjectID)
			decisions[id] = admission
		}
		if !admission.LeaseMode {
			return true, ""
		}
		if !admission.Open {
			return false, admission.Reason
		}
		if next == 0 || admission.Remaining < next {
			next = max(admission.Remaining, time.Millisecond)
		}
		return true, ""
	}
	for key, registration := range b.endpoints {
		endpoint := snapshot.Endpoint(registration.endpointID, registration.assignmentGeneration)
		if endpoint == nil {
			continue
		}
		if ok, reason := open(endpoint.LeasePolicyId, endpoint.SubjectId); !ok {
			b.closeEndpointSessionsLocked(registration.endpointID, registration.assignmentGeneration)
			if registration.stateful() {
				// A stateful registration outlives the gate (D7); its tunnels do not.
				continue
			}
			registration.closeWith("availability lease gate closed: " + reason)
			delete(b.endpoints, key)
		}
	}
	for _, tunnel := range b.active {
		if endpoint := snapshot.Endpoint(tunnel.endpointID, tunnel.assignmentGeneration); endpoint != nil {
			if ok, _ := open(endpoint.LeasePolicyId, endpoint.SubjectId); !ok {
				tunnel.close()
				continue
			}
		}
		if route := snapshot.Route(tunnel.routeID, tunnel.assignmentGeneration); route != nil {
			if ok, _ := open(route.LeasePolicyId, route.SourceId); !ok {
				tunnel.close()
			}
		}
	}
	return next
}

// HolderEndpoint reports whether a lease holder takes traffic through this
// relay (D6), for the gate views nginx daemons watch. It is READY when one of
// the holder's lease-bound endpoints of the policy is registered here and not
// dormant (an endpoint built before serving states registers only while it
// serves), NOT_READY when this relay carries such an endpoint but none is
// registered serving (a standby's dormant registration, or a new holder whose
// workload is not ready yet), and UNKNOWN when this relay carries no
// lease-bound endpoint of the holder for the policy (not assigned here, or the
// policy is still bootstrapping), which says nothing either way. RESTARTING
// when its only serving registrations belong to a daemon that announced a
// restart (B-13): it serves again once the next process registers.
func (b *Broker) HolderEndpoint(policyID, holderID string) relayv1.LeaseHolderEndpoint {
	if policyID == "" || holderID == "" {
		return relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_UNKNOWN
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	snapshot := b.store.Current()
	holderOwns := func(endpoint *relayv1.EndpointPolicy) bool {
		return endpoint != nil && endpoint.LeasePolicyId == policyID && endpoint.SubjectId == holderID
	}
	now := time.Now()
	restarting := false
	for _, registration := range b.endpoints {
		if !holderOwns(snapshot.Endpoint(registration.endpointID, registration.assignmentGeneration)) || now.Unix() > registration.expiresAt.Load() ||
			(registration.subjectID != "" && registration.subjectID != holderID) {
			continue
		}
		if registration.dormant() {
			continue
		}
		if registration.restartingAt(now) {
			restarting = true
			continue
		}
		return relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_READY
	}
	if restarting {
		// Served, and its daemon restarts: nginx holds its traffic (B-13).
		return relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_RESTARTING
	}
	for _, endpoints := range []map[string]*relayv1.EndpointPolicy{snapshot.EndpointAssignments, snapshot.Endpoints} {
		for _, endpoint := range endpoints {
			if holderOwns(endpoint) {
				return relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_NOT_READY
			}
		}
	}
	return relayv1.LeaseHolderEndpoint_LEASE_HOLDER_ENDPOINT_UNKNOWN
}
