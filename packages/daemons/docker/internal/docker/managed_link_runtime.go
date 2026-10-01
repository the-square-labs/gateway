package docker

import (
	"sync"

	pb "github.com/wiolett-industries/gateway/daemon-shared/gatewayv1"
)

// managedLinkRuntimeCapability tells Gateway that the health report carries the connections of the node's managed
// links (HealthReport.managed_links): a link the report leaves out has none.
const managedLinkRuntimeCapability = "managed_link_runtime_v1"

// managedLinkDefaultSessions is a link's concurrent connections when its grant names no session limit (an older
// Gateway); Gateway signs its link capacity (MANAGED_LINK_RELAY_MAX_CONCURRENT_SESSIONS) into the grant.
const managedLinkDefaultSessions = 64

// linkConnectionCounts holds the links that reach the relay without a host listener (a storage link's connector, a
// database binding's legacy sidecar) at their limit: the node is the link's single gate, whichever relay of the pool
// carries a connection. The zero value is ready to use.
type linkConnectionCounts struct {
	mu     sync.Mutex
	active map[linkKey]int
}

// acquire takes one of the link's limit connections; false when it carries them all.
func (c *linkConnectionCounts) acquire(link linkKey, limit int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.active[link] >= limit {
		return false
	}
	if c.active == nil {
		c.active = map[linkKey]int{}
	}
	c.active[link]++
	return true
}

func (c *linkConnectionCounts) release(link linkKey) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.active[link] <= 1 {
		delete(c.active, link)
		return
	}
	c.active[link]--
}

func (c *linkConnectionCounts) count(link linkKey) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.active[link]
}

// managedLinkRuntime reports every managed database and storage link this node serves workloads of (a connect grant
// in the bundle): its open connections, its limit and what it refused.
func (p *DockerPlugin) managedLinkRuntime() []*pb.ManagedLinkRuntime {
	if p.relayGrants == nil {
		return nil
	}
	var listenerConnections map[string]int
	if p.databaseListeners != nil {
		listenerConnections = p.databaseListeners.activeConnections()
	}
	type reportedLink struct {
		key   linkKey
		limit uint32
	}
	var links []reportedLink
	keep := map[linkKey]struct{}{}
	p.relayGrants.withCurrent(func(bundle *pb.SyncRelayGrantsCommand) {
		for _, assignment := range bundle.GetGrants() {
			kind := assignment.GetOwnerKind()
			if assignment.GetRole() != "connect" || (kind != linkKindManagedDatabaseBinding && kind != linkKindManagedStorageBinding) {
				continue
			}
			key := linkKey{kind: kind, id: assignment.GetOwnerId()}
			if _, seen := keep[key]; seen {
				continue
			}
			keep[key] = struct{}{}
			links = append(links, reportedLink{key: key, limit: relayGrantSessionLimit(assignment, managedLinkDefaultSessions)})
		}
	})
	rejections := p.linkRejections.counts(keep)
	reports := make([]*pb.ManagedLinkRuntime, 0, len(links))
	for _, link := range links {
		active := p.linkConnections.count(link.key)
		if link.key.kind == linkKindManagedDatabaseBinding {
			active += listenerConnections[link.key.id]
		}
		counts := rejections[link.key]
		report := &pb.ManagedLinkRuntime{
			OwnerKind: link.key.kind, OwnerId: link.key.id, ActiveConnections: uint32(active),
			ConnectionLimit: link.limit, RejectedTotal: counts.atCapacity, LastRejectionReason: counts.lastReason,
		}
		if !counts.lastAt.IsZero() {
			report.LastRejectedAtUnixMs = counts.lastAt.UnixMilli()
		}
		reports = append(reports, report)
	}
	return reports
}
