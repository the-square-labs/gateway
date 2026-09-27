package lease

import (
	"time"

	"github.com/wiolett-industries/gateway/daemon-shared/availabilitylease"
)

// startupFenceLocked treats every running lease-mode container as unfenced
// when the daemon starts (A2.3). A container keeps running only when every
// running container of its policy has a live watchdog record for one slot:
// the node then recovers that key with the recorded deadline and must renew
// within the remaining budget or fence. Anything else is killed now. The
// named bootstrap holder's legacy copy is exempt while its reservation is
// pending (A5).
func (r *Runtime) startupFenceLocked(now time.Duration, manifests []availabilitylease.ManifestInfo) {
	for _, manifest := range manifests {
		if manifest.Closed || r.bootstrapPendingLocked(manifest) {
			continue
		}
		var running []Container
		for _, c := range r.snapshot.byPolicy[manifest.PolicyID] {
			if c.Running {
				running = append(running, c)
			}
		}
		if len(running) == 0 {
			continue
		}
		wl := r.workloadLocked(manifest.PolicyID)
		key, deadline, ok := r.recoverableLocked(running, now)
		if !ok || !r.hbFresh {
			r.logger.Warn("unfenced lease-mode container found at daemon start; killing it",
				"policy_id", manifest.PolicyID, "containers", len(running), "watchdog_fresh", r.hbFresh)
			none := availabilitylease.HolderStatus{Key: availabilitylease.Key{PolicyID: manifest.PolicyID}}
			r.stopLocked(wl, none, running, purposeKill)
			continue
		}
		r.logger.Info("recovering an unconfirmed lease-mode container after a daemon start",
			"policy_id", key.PolicyID, "slot", key.Slot, "budget", deadline-now)
		r.node.Recover(key, deadline)
	}
}

// recoverableLocked returns the key and earliest deadline shared by the
// records of every running container, when all are live.
func (r *Runtime) recoverableLocked(running []Container, now time.Duration) (availabilitylease.Key, time.Duration, bool) {
	var key availabilitylease.Key
	var deadline time.Duration
	for i, c := range running {
		record, ok := r.records[c.ID]
		if !ok || record.Stale(now) {
			return key, 0, false
		}
		if i == 0 {
			key, deadline = availabilitylease.Key{PolicyID: c.PolicyID, Slot: record.Slot}, record.Deadline()
			continue
		}
		if record.Slot != key.Slot {
			return key, 0, false
		}
		deadline = min(deadline, record.Deadline())
	}
	return key, deadline, true
}
