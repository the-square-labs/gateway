---
{
  "id": "asy6c7bj",
  "file_name": "asy6c7bj_gateway_safe_refactor",
  "tags": [
    "backend",
    "docker",
    "frontend",
    "gateway",
    "proxy",
    "refactor",
    "testing"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1781739683142,
  "updated_at": 1781739683142
}
---
Gateway safe-refactor pattern for oversized detail/service files:
- Before extracting orchestration from DockerContainerDetail, SettingsTab, or ProxyHostDetail, add behavior tests around the existing files first. The useful seams were: container mutation snapshots/settle detection, stopped-container live runtime save callbacks, recreate payload building, and proxy-host null-clearing plus resync after access-list/advanced-config saves.
- Safe frontend extraction split: `docker-detail/mutation-transition.ts`, `docker-detail/useContainerDetailRealtime.ts`, `docker-detail/settings-payload.ts`, plus `proxy-detail/state.ts` and `proxy-detail/mutations.ts`. Keep page-level tests green by re-exporting moved helpers from the original page file when needed.
- Safe backend extraction split: `database-error-mapping.ts`, `postgres-row-sql.ts`, and `docker-recreate-watch.ts`, while keeping existing service-level tests as behavior guards during the move.
- Useful verification sequence for this refactor class: targeted frontend tests for the moved seams, targeted backend DB/docker tests, then `pnpm --filter frontend lint`, `pnpm --filter frontend build`, `pnpm --filter backend lint`, `pnpm --filter backend typecheck`, and `git diff --check`.
