---
{
  "id": "7rchqhpz",
  "file_name": "7rchqhpz_frontend_docker_deploy",
  "tags": [
    "deploy",
    "docker",
    "frontend",
    "gotchas",
    "workflow"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1781205724091,
  "updated_at": 1781205724091
}
---
Project workflow: deploying a frontend change to the running LOCAL gateway container without recreating it (recreation re-reads .env and previously broke DB auth).

1. Build: run pnpm --filter frontend build (this executes tsc -b && vite build, outputs to packages/frontend/dist; design-system source is consumed directly via @wiolett/design-system/base.css -> src, so DS edits are picked up).
2. Copy into the running container: docker cp packages/frontend/dist/. gateway_app_local-app-1:/app/public/ (app serves static from /app/public).
3. User hard-refreshes (Cmd+Shift+R) — asset filenames are hashed so the new bundle loads.
4. Verify: curl -s localhost:3000/ | grep -o 'assets/index-[A-Za-z0-9_-]*\\.js' and curl -s -o /dev/null -w '%{http_code}' localhost:3000/health.

Docker socket is blocked by the command sandbox — run docker commands with dangerouslyDisableSandbox.

GOTCHA: docker compose -p gateway_app_local up -d --build app recreates containers and re-reads .env. A missing DB_PASSWORD in .env caused the recreated app to crash during migrations (db auth failed); this was fixed by ensuring DB_PASSWORD is present in .env and by applying the corresponding password change in Postgres (ALTER ROLE gateway PASSWORD '<secure-value>'). The stack runs under compose project name gateway_app_local (not the directory name). Services: app/postgres/redis/clickhouse; data stored in named volumes.
