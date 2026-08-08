---
{
  "id": "43cdn720",
  "file_name": "43cdn720_siem_hmac_contract",
  "tags": [
    "authentication",
    "delivery-log",
    "gateway",
    "siem",
    "ui"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.9,
  "created_at": 1786140832137,
  "updated_at": 1786149756028
}
---
# Gateway SIEM Context

## Deployment

- Latest test-stand deployment: **2026-08-08**
- Host: `172.20.0.134` (`test-gw-siem`)
- Compose directory: `/opt/gateway`
- Services:
  - Gateway app: `:3000`
  - Standalone relay: `:9443`
  - PostgreSQL
  - Redis
- Current image: `gateway:siem-20260808-172-20-0-134-r4` for app and relay
- Rollback images: `r3`, with earlier SIEM baseline `r2` retained
- App and relay are healthy; internal and external `/health` checks return `ok`
- PostgreSQL and Redis were preserved without restart; host Nginx fallback on port `80` was unchanged
- Build and distribute images as `linux/amd64`
- Preserve root-owned mode-600 `/opt/gateway/.env`; never expose credentials or generated secrets

Safe app/relay replacement:

```bash
docker compose up -d --no-build --no-deps --force-recreate app relay
```

Verify image tags, container health, internal health, and `http://172.20.0.134:3000/health`. Inspect port ownership first and do not stop unrelated containers using port `3000`.

## SIEM Feature Flag

- `generalSettings.features.siemEnabled` is installation-wide and defaults to `true`
- Configured through **Settings → Gateway → General settings → SIEM audit export**
- When disabled:
  - SIEM tabs and preloads disappear
  - SIEM-only users lose Notifications navigation
  - `/api/audit/siem` returns `FEATURE_DISABLED`
  - SIEM AI tools fail closed
  - Local audit records continue
  - New SIEM outbox records are not created
  - In-process SIEM delivery pauses
- Destinations, history, and queued records remain and resume when re-enabled
- Existing `system.config.changed` invalidation refreshes UI/config caches; no restart, worker, or extra Compose service is required

## Authentication Contract

Supported modes:

- Bearer
- HMAC-SHA256
- `custom_header`

Custom-header requirements:

- Store the validated header name separately from the encrypted one-time value
- Reject malformed header names
- Reject CR/LF in authentication values
- Reject names overriding `Host`, `Content-Type`, or `X-Gateway-*`
- `Authorization` is valid when collectors use a non-Bearer scheme

HMAC delivery:

- Send `X-Gateway-Timestamp`
- Send `X-Gateway-Signature-256: sha256=<hex>`
- Sign `${timestamp}.${rawJsonBody}`
- Collectors must verify the exact raw body bytes using constant-time comparison
- Reject stale timestamps

## Schema and UI

- SIEM V1 includes custom-header authentication
- Additive migration `0095_light_jean_grey` follows the SIEM base migration
- `siem_destinations.custom_header_name` stores the validated header name
- Auth-field changes use `AnimatedHeight` with `AnimatePresence`
- Keep the delivery-enabled control separated from the animated authentication fields with a local `pt-4` spacer in `SiemDestinationDialog`; do not change global `AnimatedHeight` spacing for this.
- Destination rows show only last-delivery status
- SIEM and ordinary notification logs use a compact, full-width, centered `End of logs` sentinel
- SIEM Delivery Details follows **Audit Entry Details**: `max-w-[calc(100vw-2rem)] sm:max-w-3xl`, six-column metadata cards, and a bordered `Exported event` JSON section. Keep requeue in the standard `DialogFooter`; do not introduce a separate custom modal layout.

## Relay and Related Deployment

- Main test host: `172.20.0.131` (`test-gw-main`)
- Compose files: `/opt/gateway/docker-compose.yml` and `/opt/gateway/.env`
- `gateway-relay` owns public `:9443`; Gateway owns public `:3000`
- Do not add another public relay port
- Standalone relay v2 requires both Docker daemon endpoints to be upgraded; temporary tunnel interruption is expected
- Stable daemon tunnel v1 is incompatible with standalone relay v2
- Each daemon uses one additional process-lifetime multiplexed data-plane tunnel; binding streams remain multiplexed
- Control-plane monitoring remains on the existing app session
- Gateway supervises relay health with bounded recovery
- Failed recovery creates a critical Dashboard notice with a CTA to shared-shell details
