---
{
  "id": "myhj1f8i",
  "file_name": "myhj1f8i_shared_bootstrap_snapshot",
  "tags": [
    "assistant",
    "dashboard",
    "pins",
    "realtime"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.88,
  "created_at": 1785949175721,
  "updated_at": 1785949896540
}
---
Dashboard data is assembled by POST /api/monitoring/dashboard/bootstrap. Sidebar and Dashboard use the same Zustand snapshot key and deduplicate the request; realtime events invalidate the snapshot rather than opening per-node EventSource streams. The response includes attention notices and independent Dashboard/Sidebar pins for nodes, proxies, databases, Docker containers, and deployments. The sidebar Dashboard badge is a 12px square: blue only when every visible notice is informational; yellow when any warning exists, including red unhealthy state.

Assistant contract: internal overview documentation explains the badge and pin semantics. Embedded Gateway Assistant can resolve a resource with find_resource and request set_resource_pin for Dashboard or Sidebar; the tool is intentionally excluded from MCP because pins are browser-local preferences. Tool results emit a one-time client.action WebSocket event, which updates the current browser's persisted pin stores and invalidates the dashboard snapshot. Never replay pin actions from a historic conversation snapshot, or opening an old conversation can overwrite a later manual pin choice. Docker pin actions require nodeId, nodeSlug, and name to keep local metadata resolvable.
