package daemon

import (
	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

// leaseGatedBinding names one availability member's Secure Link socket for
// the availability-lease coordinator to reconcile against relay gate views
// (D8, A8).
type leaseGatedBinding struct {
	LinkID      string
	PolicyID    string
	CandidateID string
}

// applyLeaseMetadata records which availability member a newly staged
// binding serves. A lease-gated binding starts with its Unix socket closed:
// it opens only once a relay gate view says its candidate holds the lease
// (D8, A8). Non-availability bindings are left exactly as they were: their
// Unix socket keeps listening unconditionally.
func applyLeaseMetadata(binding *sourceLinkBinding, desired *pb.ProxySecureLinkBinding) {
	binding.availabilityPolicyID = desired.GetAvailabilityPolicyId()
	binding.availabilityCandidateID = desired.GetAvailabilityCandidateId()
	binding.dormant = desired.GetDormant()
	binding.leaseGated = binding.availabilityPolicyID != ""
	if binding.leaseGated {
		binding.closeUnixForLease()
	}
}

// closeUnixForLease stops accepting on this binding's Unix socket and removes
// the socket file, so a connect attempt fails immediately instead of nginx
// waiting on a request timeout (D8, A8). Connections already established are
// left running: in-flight requests at the exact switch moment may still see
// an error from upstream, which is the documented residual (A8).
func (b *sourceLinkBinding) closeUnixForLease() {
	b.leaseMu.Lock()
	defer b.leaseMu.Unlock()
	b.leaseOpen = false
	if b.unix == nil {
		return
	}
	_ = b.unix.Close()
	b.unix = nil
}

// openUnixForLease (re)creates and starts accepting on this binding's Unix
// socket once a relay gate view says its candidate holds the lease.
func (b *sourceLinkBinding) openUnixForLease(m *sourceLinkManager, id string) error {
	b.leaseMu.Lock()
	defer b.leaseMu.Unlock()
	b.leaseOpen = true
	if b.unix != nil {
		return nil
	}
	select {
	case <-b.done:
		// The binding was removed entirely; there is nothing left to open.
		return nil
	default:
	}
	listener, err := m.listenUnixSocket(b.socketPath)
	if err != nil {
		return err
	}
	b.unix = listener
	m.accept(id, b, listener, true)
	return nil
}

// leaseGate reports whether this binding is gated by an availability lease
// and, if so, the policy and candidate it represents (D8).
func (b *sourceLinkBinding) leaseGate() (policyID, candidateID string, gated bool) {
	b.leaseMu.Lock()
	defer b.leaseMu.Unlock()
	return b.availabilityPolicyID, b.availabilityCandidateID, b.leaseGated
}

// setLeaseOpen opens or closes a lease-gated binding's socket. It is a no-op
// for bindings that are not availability members or that no longer exist.
func (m *sourceLinkManager) setLeaseOpen(linkID string, open bool) error {
	m.mu.Lock()
	binding := m.bindings[linkID]
	m.mu.Unlock()
	if binding == nil || !binding.leaseGated {
		return nil
	}
	if open {
		return binding.openUnixForLease(m, linkID)
	}
	binding.closeUnixForLease()
	return nil
}

// leaseGatedBindings lists the availability members currently registered, for
// the availability-lease coordinator to reconcile against relay gate views.
func (m *sourceLinkManager) leaseGatedBindings() []leaseGatedBinding {
	m.mu.Lock()
	defer m.mu.Unlock()
	bindings := make([]leaseGatedBinding, 0, len(m.bindings))
	for id, binding := range m.bindings {
		policyID, candidateID, gated := binding.leaseGate()
		if !gated {
			continue
		}
		bindings = append(bindings, leaseGatedBinding{LinkID: id, PolicyID: policyID, CandidateID: candidateID})
	}
	return bindings
}
