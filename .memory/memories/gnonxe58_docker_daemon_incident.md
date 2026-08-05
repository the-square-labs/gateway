---
{
  "id": "gnonxe58",
  "file_name": "gnonxe58_docker_daemon_incident",
  "tags": [
    "daemon",
    "docker",
    "incident",
    "logs",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.78,
  "importance": 0.8,
  "created_at": 1783110326264,
  "updated_at": 1783608052536
}
---
Docker daemon large-log incidents: huge json-file logs can destabilize daemon log retrieval and make the node appear hung. Keep Docker log access bounded at every layer. Durable hardening pattern: daemon `maxDockerLogReadBytes` is 8 MiB and `maxDockerLogLineBytes` is 1 MiB; follow-mode Docker logs must default to Docker `tail=0` rather than `tail=all`; history pagination with `until` must use bounded `since/until` windows and must not fall back to unbounded `until` without `since`; non-follow Docker log commands should run async in shared lifecycle so a slow Docker read does not block the command stream; send failures from async command results should tear down the session instead of waiting for backend timeouts; backend log websocket initial fetch failures should send an error and close before starting follow; frontend log views should cap retained rows to avoid browser hangs. Useful verification: `go test ./...` in `packages/daemons/docker`, `go test ./...` in `packages/daemons/shared`, `corepack pnpm run lint:daemon`, targeted frontend/backend Biome checks, and frontend/backend typecheck.
