---
{
  "id": "adzvqx6l",
  "file_name": "adzvqx6l_gwca_permission_boundary",
  "tags": [
    "authorization",
    "docker",
    "gateway",
    "security"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1785532665862,
  "updated_at": 1786221125572
}
---
# Gateway Docker Context

## Container Archive Export Permissions

- Gateway container archive export requires the resource-scoped `docker:containers:export` permission as an additional gate; it does not replace protected-data access.
- Source-container export also requires:
  - `docker:containers:files`
  - `docker:containers:environment`
- `docker:containers:secrets` is optional. It controls:
  - Visibility of the **Include secrets** switch.
  - Whether secret values can be included in the export.
- Export scope defaults:
  - Granted to `system-admin` and `admin`.
  - Excluded from `operator`.
  - Requires manual OAuth approval.

## Volume Archive Export Permissions

- Docker volume archive download requires the separate resource-scopable `docker:volumes:export` permission; `docker:volumes:view` and `docker:volumes:files:read` do not grant an export.
- The export action is visible only with the broad permission or a matching `docker:volumes:export:<node-id>` grant.
- The scope defaults to `system-admin` and `admin`, is excluded from `operator`, and requires manual OAuth approval. Existing custom roles and delegated tokens need an explicit grant.

## Security Boundaries

- Docker webhook environment-corruption prevention is distinct from repairing existing data; prevention requires a safe container-config edit permission boundary.
- AI conversations are user-owned. Preserve ordinary history and search usefulness; protect one-time raw secrets and explicitly secret-returning results that must not remain recoverable.
- Installation/bootstrap hardening should remain non-breaking unless stricter migration is approved:
  - Prefer removing silent mutable/latest fallback where safe.
  - Preserve checksum verification.
  - Use warnings or explicit opt-in.
  - Test shell syntax.
- Keep Docker lockfile hardening concrete.
- Non-expiring MCP OAuth access tokens are accepted; expiry/refresh applies to standard API OAuth, not MCP-resource grants.
- Durable policy boundaries belong in memory; implementation status and task ordering belong in `.workflow` artifacts.

## Private Docker Registry Selection

- Multiple saved `docker_registries` records may share a host but have different credentials or scopes. Example: `DFK Registry` and `DFK Stazion Registry` both use `https://registry.dfk-algotrade.com`.
- Inferred single-host lookup can select credentials lacking access to the target image and fail with `insufficient_scope`.
- Every Docker image-pull surface should support explicit registry selection.
- MCP/AI tools:
  - `create_docker_container` and `pull_docker_image` expose optional `registryId`.
  - `create_docker_container` passes `registryId` through `ContainerCreateSchema` to `DockerManagementService.createContainer`.
  - `pull_docker_image` calls `DockerRegistryService.resolveAuthForImagePull(nodeId, imageRef, registryId)`, prefixes the registry host for short image references, and calls `DockerManagementService.pullImage` with `authJson` and the resolved `registryId`.
- Recreate/deployment flows should continue trying `resolveAuthCandidatesForImagePull` candidates when no explicit registry is supplied.

## Docker Environment Persistence and Rollback

- Container environment variables are persisted in the backend `docker_env_vars` table, separate from `docker_secrets`, using the same `CryptoService` envelope-encryption pattern.
- `DockerManagementService`:
  - Reads DB-backed environment variables first.
  - Seeds existing runtime environment variables into the database on first read.
  - Persists environment updates after the daemon accepts the update.
  - Merges stored environment variables and secrets into recreate/update flows.
- Docker daemon recreate accepts `env` and `removeEnv`.
- If replacement creation or startup fails after the old container is removed, the daemon attempts rollback by recreating the original container snapshot.

## Local Gateway Workflow

- To deploy frontend changes without recreating the running local gateway container:
  1. Run `pnpm --filter frontend build`.
  2. Copy `packages/frontend/dist/.` to `gateway_app_local-app-1:/app/public/`.
  3. Hard-refresh the browser with `Cmd+Shift+R`.
  4. Verify the asset bundle and `/health` endpoint.
- `docker compose -p gateway_app_local up -d --build app` recreates containers and re-reads `.env`; missing `DB_PASSWORD` previously caused migration-time database-auth failures.
- Ensure `DB_PASSWORD` exists in `.env` and matches the PostgreSQL role password.
- Compose project name is `gateway_app_local`; services include `app`, `postgres`, `redis`, and `clickhouse`, with data in named volumes.
- Docker commands require `dangerouslyDisableSandbox` because the command sandbox blocks Docker socket access.

## Local Daemon Startup

- Standalone `daemon-nginx` and `daemon-docker` containers use `ubuntu:24.04` with `sleep infinity`; daemon processes do not start automatically.
- `daemon-nginx`:
  - Contains `nginx-daemon`.
  - Valid configuration: `/etc/nginx-daemon/config.yaml`.
  - Start with `nginx-daemon run`.
- `daemon-docker`:
  - Privileged and contains `dockerd` plus `docker-daemon`.
  - Start `dockerd` on `/var/run/docker.sock` first.
  - Then run `docker-daemon run`.
  - Once started, it connects successfully to the gateway.
