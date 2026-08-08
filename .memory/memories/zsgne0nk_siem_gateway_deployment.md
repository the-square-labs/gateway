---
{
  "id": "zsgne0nk",
  "file_name": "zsgne0nk_siem_gateway_deployment",
  "tags": [
    "deployment",
    "docker-compose",
    "gateway",
    "siem",
    "test-stand",
    "ui"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.94,
  "created_at": 1786139242396,
  "updated_at": 1786150233627
}
---
# Gateway SIEM and Relay Deployment Context

## Latest Test Stand

- **Date:** 2026-08-08
- **Host:** `172.20.0.134` (`test-gw-siem`)
- **Compose directory:** `/opt/gateway`
- **Services:** Gateway app `:3000`, standalone relay `:9443`, PostgreSQL, Redis
- **Current image:** `gateway:siem-20260808-172-20-0-134-r5` for app and relay
- **Immediate rollback image:** `gateway:siem-20260808-172-20-0-134-r4`; older `r3` and SIEM baseline `r2` remain available.
- App and relay are healthy; internal and external `/health` return `ok`.
- r5 includes:
  - A local spacer between the animated SIEM authentication fields and the Delivery enabled control.
  - SIEM Delivery Details aligned to the Audit Entry Details dialog: audit-style width, metadata cards, bordered exported-event JSON, and standard requeue footer.
- The r5 UI was checked in an authenticated browser session on the test stand; no form values were saved or changed.
- r4 includes the installation-wide SIEM enable/disable setting and SIEM destination endpoint-table width correction.
- r3 added the compact, full-width, centered `End of logs` footer to SIEM and ordinary notification delivery logs.
- Only app and relay were forcibly recreated with `--no-deps`; PostgreSQL and Redis were not restarted and their state/volumes were preserved.
- Host Nginx fallback on port `80` was unchanged.

## Safe App/Relay Replacement

Inspect port ownership first; never stop unrelated containers using port `3000`.

```bash
docker compose up -d --no-build --no-deps --force-recreate app relay
```

Verify:

- Image tags
- App and relay health
- Internal `/health`
- External `http://172.20.0.134:3000/health`

Preserve root-owned mode-600 `/opt/gateway/.env`; do not print or retrieve credentials, secrets, initial setup state, or generated values. Do not alter PostgreSQL, Redis, Nginx fallback, relay public port ownership, or local daemon containers. Build and distribute images as `linux/amd64`.

## SIEM Feature Flag

- Setting: `generalSettings.features.siemEnabled`
- Installation-wide; defaults to `true` for backwards-compatible upgrades.
- UI path: **Settings → Gateway → General settings → SIEM audit export**
- Uses the existing Switch and Save workflow.
- When disabled:
  - SIEM tabs and preloads disappear.
  - SIEM-only users lose Notifications navigation.
  - `/api/audit/siem` returns `FEATURE_DISABLED`.
  - SIEM AI tools fail closed.
  - Local audit records continue.
  - New SIEM outbox records are not created.
  - In-process SIEM delivery pauses.
- Destinations, history, and queued records remain and resume when re-enabled.
- Existing `system.config.changed` invalidation refreshes UI shell/config cache; no restart, worker, or extra Compose service is required.

## SIEM Authentication and Schema

Supported modes:

- Bearer
- HMAC-SHA256
- `custom_header`

Custom-header requirements:

- Store the validated header name separately from the encrypted one-time header value.
- Reject malformed names and CR/LF in authentication values.
- Reject names overriding `Host`, `Content-Type`, or `X-Gateway-*`.
- `Authorization` is valid for collectors using a non-Bearer scheme.

HMAC delivery:

- `X-Gateway-Timestamp`
- `X-Gateway-Signature-256: sha256=<hex>`
- Sign `${timestamp}.${rawJsonBody}`.
- Collectors verify exact raw bytes with constant-time comparison and reject stale timestamps.

Other SIEM details:

- V1 uses additive migration `0095_light_jean_grey`.
- `siem_destinations.custom_header_name` stores the custom header name.
- Auth-field changes use `AnimatedHeight` with `AnimatePresence`; only the destination dialog adds its local spacer.
- Destination rows show only last-delivery status.
- Log sentinel/footer remains compact.
- SIEM Delivery Details reuses the Audit Entry Details layout rather than a custom modal.
- SIEM UI/schema changes are additive after the SIEM base migration.

## Relay Architecture

- `gateway-relay` owns public `:9443`.
- Gateway app owns public `:3000`; do not add another public relay port.
- Each daemon maintains one additional process-lifetime multiplexed data-plane tunnel; binding streams remain multiplexed.
- Control-plane monitoring remains on the existing app session.
- Gateway supervises relay health with bounded recovery.
- Failed recovery creates a critical Dashboard notice with a CTA to shared-shell details.
- Both participating Docker daemon endpoints must be upgraded for standalone relay v2.
- Stable daemon tunnel v1 is incompatible with standalone relay v2; temporary tunnel interruption during upgrade is expected.

## Main Test Host

- **Host:** `172.20.0.131` (`test-gw-main`)
- **Compose files:** `/opt/gateway/docker-compose.yml`, `/opt/gateway/.env`
- **App image:** `gateway:current-worktree-amd64`
- PostgreSQL and Redis are stateful foundation services and remain running during app-only deployments.

Current-worktree deployment:

1. Sync source to `/opt/gateway-test-source`, excluding `.git`, `node_modules`, `dist`, and `.env`.
2. Build `gateway:current-worktree-amd64-next`.
3. Inspect the candidate image ID.
4. Retag as `gateway:current-worktree-amd64`.
5. Recreate only the app with Compose, then verify candidate image, healthy container, and `/health`.

## Port-Conflict, State, and Release Constraints

- If another container owns port `3000`, do not stop or replace it; use a temporary named `docker compose run --no-deps` smoke container without published ports.
- Preserve PostgreSQL and Redis container identities, state, and volumes across app deployments.
- Compose recreation rereads `.env`; `DB_PASSWORD` must match the PostgreSQL `gateway` role password.
- Managed database storage remains a fixed-size loop-backed ext4 image; do not replace it with Docker volumes or soft quotas.
- Connector sidecars mount the dedicated `database-tunnel/tunnel.sock` directory read-only at `/run/gateway-db`; direct socket-file mounts are prohibited.
- Long-lived PostgreSQL sessions, persisted data, binding queries, node reconnect, and relay identity must survive app stop and force-recreate.
- Gateway releases use annotated `vX.Y.Z` tags; daemons release independently.
- Signed update manifests require the top-level OCI image digest from `docker buildx imagetools inspect`.
- Docker JSON logs are capped at `10M` with one retained file; a systemd timer truncates existing oversized logs every five minutes.
