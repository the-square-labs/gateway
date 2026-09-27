package daemon

import (
	"sync"
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
	relayv1 "github.com/wiolett-industries/gateway/daemon-shared/relayv1"
)

// leaseGateMaxTTL bounds every relay gate view regardless of what the relay
// reports, so nginx never trusts a broadcast older than one lease term (D8,
// A8).
const leaseGateMaxTTL = availabilitylease.LeaseTerm

// leaseGateKey identifies one lease key's gate, independent of which relay
// reported it: several relays may report the same (policy, slot).
type leaseGateKey struct {
	policyID string
	slot     uint32
}

// leaseGateEntry is one relay's most recent view of one key's gate, aged out
// locally instead of waiting for that relay to say the view is gone.
type leaseGateEntry struct {
	leaseMode bool
	open      bool
	holderID  string
	expiresAt time.Time
}

// leaseGateTracker holds the most recent gate view every connected relay
// reported for every lease key, each aged out on its own (ha-t2-report.md
// section 3): "T5 rule (A8): a member socket for (policy, candidate node N)
// is open iff some relay's latest view has lease_mode && open && holder_id ==
// N, and that view is younger than min(remaining_ms, 30000) ms since receipt
// on the nginx node's own monotonic clock. When the stream breaks, views age
// out by that TTL; do not extend them."
type leaseGateTracker struct {
	mu      sync.Mutex
	entries map[leaseGateKey]map[string]leaseGateEntry // key -> relay member id -> entry
}

func newLeaseGateTracker() *leaseGateTracker {
	return &leaseGateTracker{entries: map[leaseGateKey]map[string]leaseGateEntry{}}
}

// apply records one relay's gate snapshot, timestamped at receipt.
func (t *leaseGateTracker) apply(relayID string, snapshot *relayv1.LeaseGateSnapshot, now time.Time) {
	if snapshot == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for _, gate := range snapshot.GetGates() {
		key := leaseGateKey{policyID: gate.GetPolicyId(), slot: gate.GetSlot()}
		ttlMs := gate.GetRemainingMs()
		if maxMs := uint64(leaseGateMaxTTL.Milliseconds()); ttlMs > maxMs {
			ttlMs = maxMs
		}
		byRelay := t.entries[key]
		if byRelay == nil {
			byRelay = map[string]leaseGateEntry{}
			t.entries[key] = byRelay
		}
		byRelay[relayID] = leaseGateEntry{
			leaseMode: gate.GetLeaseMode(),
			open:      gate.GetOpen(),
			holderID:  gate.GetHolderId(),
			expiresAt: now.Add(time.Duration(ttlMs) * time.Millisecond),
		}
	}
}

// openFor reports whether some relay's latest, unexpired view admits
// candidateID for policyID in any slot (D8, A8). A stale view never counts:
// the caller does not wait for a broadcast to say so.
func (t *leaseGateTracker) openFor(policyID, candidateID string, now time.Time) bool {
	if policyID == "" || candidateID == "" {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	for key, byRelay := range t.entries {
		if key.policyID != policyID {
			continue
		}
		for _, entry := range byRelay {
			if entry.leaseMode && entry.open && entry.holderID == candidateID && now.Before(entry.expiresAt) {
				return true
			}
		}
	}
	return false
}
