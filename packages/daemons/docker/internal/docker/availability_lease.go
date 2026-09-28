package docker

import (
	"fmt"
	"time"
)

// Availability state helpers used by the data-plane lease (T4, T6 §3).

// leasePlacement returns this node's current placement of a policy: the
// live placement with the highest generation (D12 mapping for lease reports).
func (m *availabilityManager) leasePlacement(policyID string) (availabilityPlacement, bool) {
	if m == nil {
		return availabilityPlacement{}, false
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	var best availabilityPlacement
	found := false
	for _, placement := range m.state.Placements {
		if placement.PolicyID != policyID || placement.Tombstone {
			continue
		}
		if !found || placement.HighestGeneration > best.HighestGeneration {
			best, found = placement, true
		}
	}
	if found {
		best.RuntimeMetadata = cloneAvailabilityMetadata(best.RuntimeMetadata)
	}
	return best, found
}

// markLeaseLifecycle records what the lease runtime did with this node's
// placement (T6 §3.1): active once the holder started it, stopped after a
// confirmed stop. The generation is unchanged; the cached result is replaced
// so an idempotent replay returns the current state instead of re-applying.
func (m *availabilityManager) markLeaseLifecycle(policyID string, serving bool) error {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	key, found := "", false
	var current availabilityPlacement
	for candidateKey, placement := range m.state.Placements {
		if placement.PolicyID != policyID || placement.Tombstone {
			continue
		}
		if !found || placement.HighestGeneration > current.HighestGeneration {
			key, current, found = candidateKey, placement, true
		}
	}
	if !found {
		return nil
	}
	next := current
	switch {
	case serving && current.LifecycleState != availabilityLifecycleActive:
		next.LifecycleState = availabilityLifecycleActive
	case !serving && (current.LifecycleState == availabilityLifecycleActive || current.LifecycleState == availabilityLifecycleSingle ||
		current.LifecycleState == availabilityLifecycleDraining):
		next.LifecycleState = availabilityLifecycleStopped
	default:
		return nil
	}
	next.RuntimeMetadata = cloneAvailabilityMetadata(current.RuntimeMetadata)
	next.LastAction = "lease"
	next.UpdatedAtUnixMs = time.Now().UTC().UnixMilli()
	detail, err := marshalAvailabilityPlacementDetail(next)
	if err != nil {
		return err
	}
	next.LastResult = detail
	m.state.Placements[key] = next
	if err := m.persistLocked(); err != nil {
		m.state.Placements[key] = current
		return fmt.Errorf("persist availability state: %w", err)
	}
	return nil
}

// policiesForResource lists the policies with a live placement of a resource
// on this node, for the backend lease gate (A5).
func (m *availabilityManager) policiesForResource(kind, resourceID string) []string {
	if m == nil || resourceID == "" {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	seen := map[string]bool{}
	var out []string
	for _, placement := range m.state.Placements {
		if placement.ResourceKind == kind && placement.ResourceID == resourceID && !placement.Tombstone && !seen[placement.PolicyID] {
			seen[placement.PolicyID] = true
			out = append(out, placement.PolicyID)
		}
	}
	return out
}

// leaseComposeProjects maps the Compose project names of live compose
// placements to their policy and placement, so the lease runtime can see
// project containers that carry no availability labels (T6 §3.1).
func (m *availabilityManager) leaseComposeProjects() map[string]availabilityPlacement {
	if m == nil {
		return nil
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	out := map[string]availabilityPlacement{}
	for _, placement := range m.state.Placements {
		if placement.ResourceKind != "compose" || placement.Tombstone {
			continue
		}
		name, _ := availabilityRuntimeIdentity(placement.RuntimeMetadata)["projectName"].(string)
		if name == "" {
			continue
		}
		if current, ok := out[name]; !ok || placement.HighestGeneration > current.HighestGeneration {
			out[name] = placement
		}
	}
	return out
}

// leaseRuntimeIdentities are the runtimes that live container and deployment
// placements recorded with this daemon (their runtime identity from
// activate, or from a standby prepare). An origin workload keeps its own
// name and carries no availability labels (D1): the lease finds it, and the
// start gate maps it to its policy, through this record.
type leaseRuntimeIdentities struct {
	byContainerID map[string]availabilityPlacement
	byName        map[string]leaseNamedRuntime
}

type leaseNamedRuntime struct {
	placement availabilityPlacement
	// deploymentID is set for deployment slot containers: the container must
	// be an app container of that deployment to count.
	deploymentID string
}

func (ids leaseRuntimeIdentities) empty() bool {
	return len(ids.byContainerID) == 0 && len(ids.byName) == 0
}

// match maps a container that carries no availability policy label to the
// placement whose recorded runtime it is. A labeled container belongs to the
// policy its label names; it is never remapped.
func (ids leaseRuntimeIdentities) match(id string, names []string, labels map[string]string) (availabilityPlacement, bool) {
	if labels[availabilityPolicyLabel] != "" {
		return availabilityPlacement{}, false
	}
	if placement, ok := ids.byContainerID[id]; ok {
		return placement, true
	}
	for _, name := range names {
		named, ok := ids.byName[trimContainerName(name)]
		if !ok {
			continue
		}
		if named.deploymentID != "" && (labels[deploymentIDLabel] != named.deploymentID || labels[deploymentRoleLabel] != "app") {
			continue
		}
		return named.placement, true
	}
	return availabilityPlacement{}, false
}

// leaseRuntimeIdentities returns the recorded runtimes of this node's current
// placement of every policy (the live placement with the highest generation).
// A container placement is matched by its recorded container ID, or by its
// recorded name when it recorded none; a deployment placement by the names of
// its blue and green slot containers.
func (m *availabilityManager) leaseRuntimeIdentities() leaseRuntimeIdentities {
	out := leaseRuntimeIdentities{byContainerID: map[string]availabilityPlacement{}, byName: map[string]leaseNamedRuntime{}}
	if m == nil {
		return out
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	current := map[string]availabilityPlacement{}
	for _, placement := range m.state.Placements {
		if placement.Tombstone || (placement.ResourceKind != "container" && placement.ResourceKind != "deployment") {
			continue
		}
		if best, ok := current[placement.PolicyID]; !ok || placement.HighestGeneration > best.HighestGeneration {
			current[placement.PolicyID] = placement
		}
	}
	for _, placement := range current {
		identity := availabilityRuntimeIdentity(placement.RuntimeMetadata)
		if placement.ResourceKind == "container" {
			if id, _ := identity["containerId"].(string); validLeaseContainerID(id) {
				out.byContainerID[id] = placement
			} else if name, _ := identity["containerName"].(string); name != "" {
				out.byName[name] = leaseNamedRuntime{placement: placement}
			}
			continue
		}
		deploymentID, _ := identity["deploymentId"].(string)
		if deploymentID == "" {
			deploymentID = placement.ResourceID
		}
		slots, _ := identity["slots"].(map[string]any)
		for _, slot := range []string{"blue", "green"} {
			if name, _ := slots[slot].(string); name != "" && deploymentID != "" {
				out.byName[name] = leaseNamedRuntime{placement: placement, deploymentID: deploymentID}
			}
		}
	}
	return out
}

func validLeaseContainerID(id string) bool {
	if len(id) != 64 {
		return false
	}
	for _, char := range id {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}
