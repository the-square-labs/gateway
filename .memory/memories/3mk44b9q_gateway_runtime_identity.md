---
{
  "id": "3mk44b9q",
  "file_name": "3mk44b9q_gateway_runtime_identity",
  "tags": [
    "containers",
    "docker",
    "gateway",
    "monitoring",
    "recreate",
    "restart",
    "snapshots"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1787594299433,
  "updated_at": 1787594299433
}
---
# Gateway container monitoring runtime identity contract

- Container monitoring state belongs to one runtime generation, identified by Docker runtime container ID plus inspect State.StartedAt. Recreate changes the ID; restart can keep the ID but changes StartedAt.
- Stats history must be filtered to samples whose timestamp is at or after the current runtime StartedAt. Late history, process-list, or SSE responses from a previous monitoring identity must be ignored.
- When a recreate event adopts a replacement runtime ID, DockerContainerDetail must immediately fetch the replacement inspect even when the route resolver still holds a truthy old resolvedContainer.
- StatsTab resets cards, histories, counter baselines, GPU samples, and process state when the monitoring identity changes. Repeated process polling keeps the existing PanelShell mounted and renders loading, temporary-error, or empty copy instead of making the process section disappear.
- DockerSnapshotReconciler tracks active container transitions. While restart/recreate is active, health events that expose the old runtime as transiently exited must refresh inventory but must not replace the durable container-detail snapshot. Recreate completion refreshes the new runtime ID urgently.
- Cached container detail decoration reconciles State.Status and State.Running from the latest daemon health report, including by stable container name when the cached runtime ID was replaced. This repairs already-stale Redis inspect snapshots without substituting cached configuration.
- Verification: focused reconciler and transition tests, StatsTab identity/race tests, DockerContainerDetail identity test, backend typecheck, frontend production build, scoped Biome, and git diff --check.
