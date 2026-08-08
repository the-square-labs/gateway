---
{
  "id": "rzidwe4n",
  "file_name": "rzidwe4n_gateway_deployment",
  "tags": [
    "deployment",
    "docker",
    "gateway",
    "siem",
    "test-stand"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1785951397694,
  "updated_at": 1786135093316
}
---
# Gateway Deployment Context

- **Host:** `172.20.0.131` (`test-gw-main`)
- **Compose files:**
  - `/opt/gateway/docker-compose.yml`
  - `/opt/gateway/.env`
- **App image:** `gateway:current-worktree-amd64`
- PostgreSQL and Redis are stateful foundation services and should remain running during app-only deployments.

## Current-Worktree Deployment

1. Sync source to `/opt/gateway-test-source`, excluding:
   - `.git`
   - `node_modules`
   - `dist`
   - `.env`
2. Build candidate image:
   ```bash
   gateway:current-worktree-amd64-next
   ```
3. Inspect the candidate image ID.
4. Retag it as:
   ```bash
   gateway:current-worktree-amd64
   ```
5. Recreate only the app:
   ```bash
   docker compose \
     --project-directory /opt/gateway \
     -f /opt/gateway/docker-compose.yml \
     --env-file /opt/gateway/.env \
     up -d --force-recreate app
   ```
6. Verify:
   - The container uses the candidate image.
   - Container health is `healthy`.
   - `/health` returns status `ok`.

Last verified candidate image:

```text
sha256:6c66f1ffeb669d8c6e748edd8c7af9fc1cae24def4bb1b7d21ded88adc7b41f4
```

## Test-stand Port Conflict Fallback

- Inspect current port owners before recreating `/opt/gateway` app. On 2026-08-07, an independent `gateway-e2e-app-1` owned host port `3000`; do not stop or replace it just to deploy another candidate.
- For a migration/API smoke test when that collision exists, run the candidate as a named, temporary compose `run` container with `--no-deps` and no published service ports, for example `gateway-siem-smoke` on `gateway_default`.
- Verify its internal `/health`, registered routes, schema migration, and scheduler via `docker exec`; then remove only the temporary smoke container and the failed `gateway-app-1` container. Do not remove PostgreSQL, Redis, `gateway-e2e`, Compose files, or the candidate image.
- A smoke container without the separately managed relay can report relay degradation. Treat that as an expected test-topology limitation only after the core app, migration, and required target checks have passed.

## Deployment Precautions

- Compose recreation rereads `.env`; ensure `DB_PASSWORD` is present and matches the PostgreSQL `gateway` role password.
- For frontend-only changes when recreation is undesirable:
  ```bash
  pnpm --filter frontend build
  docker cp packages/frontend/dist/. <app-container>:/app/public/
  ```
  Then hard-refresh the browser and verify `/health`.
- Do not replace existing local daemon containers; they contain enrollment tokens, state volumes, and node identities.
- Do not add another public relay port. Standalone `gateway-relay` owns public `:9443`; the Gateway app uses public `:3000`.
- Stable daemon tunnel v1 is incompatible with standalone relay v2; upgrade both participating Docker daemon endpoints during migration.
- Explicit Docker registry selection must remain available when multiple credentials share a registry host.

## Stateful and Migration Requirements

- Managed database storage uses a fixed-size loop-backed ext4 image; do not replace it with Docker volumes or soft quotas.
- Unsupported LXC must fail before enrollment with actionable loop-device and mount-passthrough guidance.
- Preflight cleanup must remove image, mount, and loop attachments on success or failure.
- Connector sidecars must mount the dedicated `database-tunnel/tunnel.sock` directory read-only, not the socket file directly.
- Docker daemon initialization reconciles legacy connector socket-file binds to directory binds and fails initialization if required migration fails.
- Preserve PostgreSQL and Redis foundation container identities across app migrations and recreations.
- Long-lived PostgreSQL sessions and relay identity must survive complete app stop and force-recreate.

## Release and Verification

- Gateway releases use annotated `vX.Y.Z` tags; daemons release independently as `vX.Y.Z-nginx`, `vX.Y.Z-docker`, and `vX.Y.Z-monitoring`.
- Signed update manifests must contain the top-level OCI image digest extracted from `docker buildx imagetools inspect`.
- Invalid image digests cause update verification failures such as `UNTRUSTED_UPDATE_ARTIFACT`.
- Verify app health, workload HTTP, proxy HTTP, persisted PostgreSQL data, binding queries, node reconnect, and browser views after stateful migrations.
- Docker JSON logs are capped at `10M` with one retained file; an additional systemd timer truncates existing oversized logs every five minutes.
