package docker

import (
	"errors"
	"log/slog"
	"sync"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// linkRejectionLogInterval is how often one link logs the same rejection reason again; the line carries the count of
// the rejections in between.
const linkRejectionLogInterval = time.Minute

// Owner kinds of the links whose rejected connections are logged.
const (
	linkKindManagedDatabaseBinding = "managed_database_binding"
	linkKindManagedStorageBinding  = storageBindingOwnerKind
)

// Rejection reasons. The reason keys the rate limit, so it stays a short fixed label; the detail goes into "error".
const (
	// linkRejectedLinkLimit: the link already carries the concurrent connections its grant allows.
	linkRejectedLinkLimit         = "link_limit"
	linkRejectedNodeLimit         = "node_limit"
	linkRejectedNetworkUnverified = "network_unverified"
	linkRejectedNetworkChanged    = "network_changed"
	linkRejectedUnknownPeer       = "unknown_peer"
	linkRejectedSourceNotAllowed  = "source_not_allowed"
	linkRejectedGrantUnavailable  = "grant_unavailable"
	linkRejectedRouteChanged      = "route_changed"
	linkRejectedRelayCapacity     = "relay_capacity"
	linkRejectedRelayRefused      = "relay_refused"
	linkRejectedRelayUnavailable  = "relay_unavailable"
)

// linkRejectedAtCapacity reports the reasons this node refuses a connection for capacity: they are the link's
// admission rejects next to the relays' own (relay_capacity is counted by the relay that refused).
func linkRejectedAtCapacity(reason string) bool {
	return reason == linkRejectedLinkLimit || reason == linkRejectedNodeLimit
}

// linkRejectionLog writes the WARN for connections a managed link (database binding, storage link) turns away
// instead of a silent close: the first rejection of a link and reason at once, then at most one line per
// linkRejectionLogInterval with the number of rejections since the previous line. It also keeps each link's
// counters for the health report (managedLinkRuntime). The zero value is ready to use.
type linkRejectionLog struct {
	// now overrides the clock (tests).
	now     func() time.Time
	mu      sync.Mutex
	entries map[linkRejectionKey]*linkRejectionEntry
	links   map[linkKey]*linkRejectionCounts
}

type linkRejectionKey struct{ kind, id, reason string }

type linkRejectionEntry struct {
	logged     time.Time
	suppressed int
}

// linkKey names one managed link: its owner kind and binding (or placement) id.
type linkKey struct{ kind, id string }

// linkRejectionCounts are one link's rejections since the daemon started.
type linkRejectionCounts struct {
	// atCapacity counts the connections refused at the link's or the node's limit.
	atCapacity uint64
	lastReason string
	lastAt     time.Time
}

func (l *linkRejectionLog) rejected(logger *slog.Logger, kind, bindingID, reason string, attrs ...any) {
	now := time.Now()
	if l.now != nil {
		now = l.now()
	}
	key := linkRejectionKey{kind: kind, id: bindingID, reason: reason}
	l.mu.Lock()
	l.countLocked(linkKey{kind: kind, id: bindingID}, reason, now)
	entry := l.entries[key]
	if entry != nil && now.Sub(entry.logged) < linkRejectionLogInterval {
		entry.suppressed++
		l.mu.Unlock()
		return
	}
	if entry == nil {
		if l.entries == nil {
			l.entries = map[linkRejectionKey]*linkRejectionEntry{}
		}
		// Links that stopped rejecting (or were deleted) leave the map.
		for staleKey, stale := range l.entries {
			if now.Sub(stale.logged) >= 10*linkRejectionLogInterval {
				delete(l.entries, staleKey)
			}
		}
		entry = &linkRejectionEntry{}
		l.entries[key] = entry
	}
	suppressed := entry.suppressed
	entry.logged, entry.suppressed = now, 0
	l.mu.Unlock()
	if logger == nil {
		return
	}
	args := []any{"owner_kind", kind, "binding_id", bindingID, "reason", reason}
	if suppressed > 0 {
		args = append(args, "rejected_since_last_log", suppressed)
	}
	logger.Warn("managed link connection rejected", append(args, attrs...)...)
}

func (l *linkRejectionLog) countLocked(link linkKey, reason string, now time.Time) {
	if l.links == nil {
		l.links = map[linkKey]*linkRejectionCounts{}
	}
	counts := l.links[link]
	if counts == nil {
		counts = &linkRejectionCounts{}
		l.links[link] = counts
	}
	if linkRejectedAtCapacity(reason) {
		counts.atCapacity++
	}
	counts.lastReason, counts.lastAt = reason, now
}

// counts returns the rejections of the links in keep and forgets every other link (a link that left the node).
func (l *linkRejectionLog) counts(keep map[linkKey]struct{}) map[linkKey]linkRejectionCounts {
	l.mu.Lock()
	defer l.mu.Unlock()
	result := make(map[linkKey]linkRejectionCounts, len(l.links))
	for link, counts := range l.links {
		if _, present := keep[link]; !present {
			delete(l.links, link)
			continue
		}
		result[link] = *counts
	}
	return result
}

// errRelayLaneUnavailable is the refusal when no relay transport of the link's candidates is connected.
var errRelayLaneUnavailable = errors.New("no relay transport of the link is connected")

// relayRefusalReason classifies why no relay candidate opened a source tunnel.
func relayRefusalReason(err error) string {
	if errors.Is(err, errRelayLaneUnavailable) {
		return linkRejectedRelayUnavailable
	}
	switch status.Code(err) {
	case codes.ResourceExhausted:
		return linkRejectedRelayCapacity
	case codes.Unavailable, codes.Canceled, codes.DeadlineExceeded:
		return linkRejectedRelayUnavailable
	default:
		return linkRejectedRelayRefused
	}
}

// relayRefusalMessage is the relay's own reason ("relay route session capacity reached"), or the error as is.
func relayRefusalMessage(err error) string {
	if current, ok := status.FromError(err); ok && current.Message() != "" {
		return current.Message()
	}
	return err.Error()
}
