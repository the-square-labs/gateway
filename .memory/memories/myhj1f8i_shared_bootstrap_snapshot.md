---
{
  "id": "myhj1f8i",
  "file_name": "myhj1f8i_shared_bootstrap_snapshot",
  "tags": [
    "bootstrap",
    "dashboard",
    "rate-limit",
    "realtime",
    "sidebar"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1785949175721,
  "updated_at": 1786067598014
}
---
# Gateway Dashboard Bootstrap and Sidebar Contract

## Bootstrap, realtime, and invalidation

- Dashboard data loads through `POST /api/monitoring/dashboard/bootstrap`; Dashboard and Sidebar share a Zustand snapshot key and deduplicate requests.
- Bootstrap responses include attention notices and independent Dashboard/Sidebar pins for nodes, proxies, databases, Docker containers, and deployments.
- Realtime events invalidate the shared snapshot; clients do not open per-node `EventSource` streams. After reconnecting an established WebSocket, EventStream revalidates bootstrap to recover missed events.
- Update availability, group MFA policy, audit activity, and Assistant pin actions can invalidate the shared snapshot.
- Bootstrap is a read-only POST and must be excluded from fallback audit logging. Auditing it emits `audit.changed`, invalidates bootstrap, and creates an unbounded request loop that reaches rate limits.
- Initial failures retain request identity, retry with bounded backoff while no snapshot exists, and end in a visible retryable error rather than a permanent spinner.
- Preserve an existing snapshot only while refreshing for the same user, scope, and pin key. Auth-context changes call `resetClientSessionState`, clearing bootstrap and pin stores before publishing new user state.
- Logging-health visibility and its realtime channel require `housekeeping:view`, not `logs:read`.

## Sidebar and Lite mode

- The Dashboard badge is an 8px square (`h-2 w-2`): blue when every visible notice is informational and yellow when any warning exists, including red unhealthy state.
- Lite mode keeps a separate Dashboard link at the top of the sidebar, displays Sidebar-placement resources, then conversations.
- Default and Lite sidebars share `SidebarPinnedResources` for consistent routes, scope filtering, and status colors.
