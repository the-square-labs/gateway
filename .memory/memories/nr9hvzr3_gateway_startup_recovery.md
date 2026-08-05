---
{
  "id": "nr9hvzr3",
  "file_name": "nr9hvzr3_gateway_startup_recovery",
  "tags": [
    "daemons",
    "dev-env",
    "docker",
    "frontend",
    "gateway",
    "local-setup",
    "postgres"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.65,
  "importance": 0.7,
  "created_at": 1782911201956,
  "updated_at": 1782916289372
}
---
Gateway local dev daemon and frontend startup gotchas (project scope):
- Do not create replacement daemon containers when existing local containers are present. Reuse/start the existing containers: gateway-dind, gateway-docker-daemon, gateway-monitoring-daemon, gateway-nginx-daemon. These containers already carry enrollment tokens, state volumes, and node identities.
- If gateway-nginx-daemon or gateway-monitoring-daemon exit with code 127, inspect /tmp/gateway-local-daemons/bin/* because Docker may have created directories at file bind-mount paths. Replace them with executable Linux arm64 binaries from:
  - packages/daemons/nginx/bin/nginx-daemon-linux-arm64
  - packages/daemons/monitoring/bin/monitoring-daemon-linux-arm64
- If gateway-dind exits with the message failed to save daemon pid to disk: process with PID 37 is still running, then:
  1) Start the same container again.
  2) Quickly clear stale runtime directories inside it: /run/docker, /run/containerd, /run/docker.sock, /var/run/docker, /var/run/containerd, and /var/run/docker.sock.
  3) Retry starting/checking within the retry timeout.
- Backend gRPC listener must be up on GRPC_PORT=9443.
  - If another project owns HTTP port 3000, run the Gateway backend with PORT=3001 (example: corepack pnpm dev) in a detached tmux session, while keeping gRPC on 9443.
- Local Postgres for this workspace is mapped to host port 55432 in docker-compose.dev.yml to avoid conflicts.
- The frontend Vite dev proxy must not be hardcoded to http://localhost:3000 when port 3000 is in use by another project. Set GATEWAY_DEV_PROXY_TARGET=http://localhost:3001 in packages/frontend/.env and ensure packages/frontend/vite.config.ts reads that env for the endpoints /api, /auth, /.well-known, /pki, /docs, and /health.
- Smoke check: curl -i http://localhost:5173/auth/me should reflect the target project, i.e., match http://localhost:3001/auth/me (usually 401 unauthenticated). It should not return a 404 from another project.
