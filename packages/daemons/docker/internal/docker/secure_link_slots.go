package docker

import (
	"context"
	"fmt"
	"time"

	"github.com/moby/moby/api/types/container"
	mobyclient "github.com/moby/moby/client"
	"github.com/wiolett-industries/gateway/daemon-shared/securelink"
)

// A connector slot (secureLinkConnectorSlots) is free for a new connector when it is empty or holds a connector that
// carries no session: a leftover, or one whose retirement passed its deadline. A connector still finishing its
// sessions keeps its slot (the rc.1 stand lost 4 container link sessions to a second replacement that took the slot of
// the connector still retiring with them).

// secureLinkConnectorSessionsWait bounds the question to a connector about to be removed how many sessions it carries.
const secureLinkConnectorSessionsWait = 2 * time.Second

// carriesSessionsLocked reports a connector that may still carry sessions: one being retired before its deadline, or
// the replaced one that keeps accepting until every egress listens on its replacement (pendingRetire).
func (m *dockerSecureLinkManager) carriesSessionsLocked(id string, now time.Time) bool {
	if m.pendingRetire != nil && m.pendingRetire.id == id {
		return true
	}
	until, ok := m.retiring.deadline(id)
	return ok && now.Before(until)
}

// replacementSlotLocked picks the slot a replacement of the connector serving in slot starts in: the first other slot
// that is free, with the connector to remove from it (nil: empty). free is false when every other slot holds a
// connector finishing its sessions.
func (m *dockerSecureLinkManager) replacementSlotLocked(ctx context.Context, serving int) (int, *container.InspectResponse, bool, error) {
	now := time.Now()
	var refused error
	for slot, candidate := range secureLinkConnectorSlots {
		if slot == serving {
			continue
		}
		inspected, err := m.plugin.client.cli.ContainerInspect(ctx, candidate.name, mobyclient.ContainerInspectOptions{})
		if isNotFoundErr(err) {
			return slot, nil, true, nil
		}
		if err != nil {
			return 0, nil, false, fmt.Errorf("inspect secure-link connector %s: %w", candidate.name, err)
		}
		if !managedSecureLinkConnector(inspected.Container, m.controlDirectory()) {
			refused = fmt.Errorf("refusing to remove non-managed container %s", candidate.name)
			continue
		}
		if m.carriesSessionsLocked(inspected.Container.ID, now) {
			continue
		}
		return slot, &inspected.Container, true, nil
	}
	return 0, nil, false, refused
}

// oldestRetiringSlotLocked returns the slot of the connector among the retiring ones in found whose retirement ends
// first (-1: none of this node's).
func (m *dockerSecureLinkManager) oldestRetiringSlotLocked(found [len(secureLinkConnectorSlots)]*container.InspectResponse, retiring [len(secureLinkConnectorSlots)]bool) int {
	oldest, oldestUntil := -1, time.Time{}
	for slot, inspect := range found {
		if inspect == nil || !retiring[slot] || !ownedSecureLinkConnector(*inspect) {
			continue
		}
		until, ok := m.retiring.deadline(inspect.ID)
		if !ok && m.pendingRetire != nil && m.pendingRetire.id == inspect.ID {
			until = m.pendingRetireSince.Add(secureLinkConnectorRetireLimit)
		}
		if oldest < 0 || until.Before(oldestUntil) {
			oldest, oldestUntil = slot, until
		}
	}
	return oldest
}

// cutConnectorLocked removes the connector in slot to free the slot and returns how many sessions it still carried.
func (m *dockerSecureLinkManager) cutConnectorLocked(ctx context.Context, inspect container.InspectResponse, slot int) (int, error) {
	sessions := m.connectorSessions(inspect.ID, m.adoptedControlSocket(m.slotSocketPath(slot)))
	return sessions, m.dropConnectorLocked(ctx, inspect.ID)
}

// dropConnectorLocked removes a connector container and forgets its retirement.
func (m *dockerSecureLinkManager) dropConnectorLocked(ctx context.Context, id string) error {
	// Its retirement, if any, must not tell the slot's next connector to drain.
	m.retiring.stop(id)
	if err := m.removeConnectorContainer(ctx, id); err != nil {
		return err
	}
	if m.pendingRetire != nil && m.pendingRetire.id == id {
		m.pendingRetire = nil
	}
	if err := m.retiring.forget(id); err != nil && m.plugin.logger != nil {
		m.plugin.logger.Warn("could not record the removal of a retiring secure-link connector", "error", err)
	}
	return nil
}

// settleLeftoverLocked deals with a connector found next to the one to serve that has no retirement record: the one a
// replacement kept accepting until every egress listened on its successor (pendingRetire, which a daemon restart
// forgets), or one an interrupted replacement left. It is told to drain; with sessions it retires in its slot with a
// fresh deadline and finishes them (kept), without any, or when it does not answer, it goes at once.
func (m *dockerSecureLinkManager) settleLeftoverLocked(ctx context.Context, inspect container.InspectResponse, slot int) (kept bool, err error) {
	socketPath := m.adoptedControlSocket(m.slotSocketPath(slot))
	drainCtx, cancel := context.WithTimeout(ctx, secureLinkConnectorSessionsWait)
	active, drainErr := securelink.Drain(drainCtx, socketPath)
	cancel()
	if drainErr == nil && active > 0 {
		if m.plugin.logger != nil {
			m.plugin.logger.Info("a secure-link connector found next to the serving one finishes its sessions before it goes",
				"connector", inspect.ID, "sessions", active)
		}
		m.retireConnector(connectorRuntime{id: inspect.ID, slot: slot, socketPath: socketPath})
		return true, nil
	}
	if drainErr != nil && inspect.State != nil && inspect.State.Running && m.plugin.logger != nil {
		m.plugin.logger.Info("a leftover secure-link connector did not answer its drain request and is removed", "connector", inspect.ID, "error", drainErr)
	}
	return false, m.dropConnectorLocked(ctx, inspect.ID)
}

// connectorSessions is how many sessions a connector carries: its own count (a drain request answers it; the
// connector drains already or is removed next), else the tunnels this daemon tracks through it.
func (m *dockerSecureLinkManager) connectorSessions(id, socketPath string) int {
	tracked := m.plugin.proxyTunnels.count(func(connection *drainConn) bool { return connectionConnector(connection) == id })
	ctx, cancel := context.WithTimeout(context.Background(), secureLinkConnectorSessionsWait)
	defer cancel()
	if active, err := securelink.Drain(ctx, socketPath); err == nil {
		return max(active, tracked)
	}
	return tracked
}

// deferReplacementLocked keeps the serving connector on its image while no slot is free for its replacement.
func (m *dockerSecureLinkManager) deferReplacementLocked(image string) {
	if !m.replacementDeferred && m.plugin.logger != nil {
		m.plugin.logger.Warn("the secure-link connector is replaced once a replaced connector finished its sessions: every other slot holds one",
			"image", image, "slots", len(secureLinkConnectorSlots))
	}
	m.replacementDeferred = true
}

// retryDeferredReplacement applies the committed connector image again once a retirement freed a slot: the links'
// restore replaces the connector of a node with ingress bindings, an egress sync the connector of one without.
func (m *dockerSecureLinkManager) retryDeferredReplacement() {
	m.mu.Lock()
	deferred := m.replacementDeferred
	m.replacementDeferred = false
	ingress := deferred && m.ingressWantedLocked()
	m.mu.Unlock()
	switch {
	case !deferred:
	case ingress:
		if err := m.restoreBindingsCoalesced(true); err != nil && m.plugin.logger != nil {
			m.plugin.logger.Warn("the waiting secure-link connector replacement failed; the next sync retries it", "error", err)
		}
	default:
		m.resyncEgress()
	}
}
