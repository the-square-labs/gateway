# Operations Guide

[Back to README](../README.md)

This guide covers day-two operation: updates, configuration, programmatic access, structured logging, AI Workspace, backups, and security notes.

## Updates

### Gateway Updates

From the UI:

1. Go to **Settings > General > About**.
2. Click **Check for updates** and review the available version.
3. Click **Update**.

Gateway verifies the signed release manifest, pulls the selected image by its immutable digest, runs the target image's foundation migrator, updates `GATEWAY_IMAGE_REF`, and recreates its own container. Relay has an independent immutable `GATEWAY_RELAY_IMAGE_REF`; Compose leaves it running when the digest is unchanged and replaces it when the signed `relayImageRef` changes. Automatic gateway updates fail closed when the signed manifest is missing, invalid, or does not match the requested version and running image repository.

App-only updates leave established managed-database binding streams on the relay running. Updating the relay itself is an explicit data-plane maintenance event and may interrupt those streams. The one-time migration from a pre-relay deployment also has an expected interruption while public `9443/tcp` ownership moves from `app` to `relay`.

Relay Pool updates are durable and one-at-a-time. With at least two ready physical fault domains, Gateway drains a remote instance, updates and verifies its signed worker and supervisor artifacts, returns it to service, and then continues. The local Compose relay is updated last. Drain waits up to 30 minutes and pauses instead of killing long-lived streams; the operator may wait again or use the explicitly confirmed **Force disconnect** action. A failed worker health/version check restores the previous binary, and a supervisor update is committed only after it reconnects at the expected version. Connector image references are promoted only after the whole pool succeeds.

Manual update:

```bash
# Edit .env first, for example:
# GATEWAY_IMAGE_REF=registry.gitlab.wiolett.net/wiolett/gateway:v2.0.0
docker compose pull
docker compose up -d
```

### Daemon Updates

From a node detail page, click **Update** when an update is available.

The update flow:

1. Gateway fetches and verifies the signed daemon update manifest.
2. Gateway dispatches the signed manifest, download URL, and verified SHA256 checksum to the daemon.
3. New daemons verify the signed manifest locally before downloading.
4. The daemon verifies the downloaded binary checksum, replaces the binary atomically, and exits for systemd restart.
5. The daemon reconnects and reports its new version.

Existing daemons from before signed-manifest support can perform one transition update. In that case Gateway verifies the signed manifest before dispatch, and the old daemon enforces the verified SHA256 checksum. After that transition, daemon-side signature verification is enforced for future updates.

## Configuration Reference

The installer writes infrastructure/bootstrap values to `.env`. Product settings are stored in Gateway: canonical public URL and internal web TLS are edited in **Settings > General**, while OIDC, SMTP, authentication methods, and ClickHouse are edited in **Settings > Advanced**.

| Variable | Purpose |
|----------|---------|
| `PORT` | HTTP port inside the app container. |
| `DATABASE_URL` | PostgreSQL connection URL. |
| `REDIS_URL` | Redis connection URL. |
| `GATEWAY_IMAGE_REF` | Gateway image reference used by Compose. The installer writes the selected release tag; signed self-updates replace it with `image@sha256:<digest>`. |
| `GATEWAY_RELAY_IMAGE_REF` | Independently pinned immutable image reference used by relay. Only a digest change updates relay. |
| `GATEWAY_RELAY_BUILD_VERSION` | Expected build version reported by the pinned relay image. |
| `GATEWAY_RELAY_PROTOCOL_MAJOR` | Supported relay wire-protocol major. |
| `SETUP_BOOTSTRAP` | Installer-only flag that permits a fresh empty database to enter first-run setup. |
| `WEB_TLS_BOOTSTRAP_MODE` | Seeds `http` or `https` only when no persisted web-transport choice exists. |
| `WEB_TLS_AUTO_DIR` | Persistent directory for the native web TLS leaf and private key. |
| `SESSION_EXPIRY` | Browser session lifetime in seconds. Browser sessions are opaque Redis-backed session IDs. |
| `GITHUB_OAUTH_CLIENT_ID` | Optional override for the built-in product-wide GitHub OAuth App client ID used for connector Device Flow. Gateway does not use a client secret or redirect users through the app's callback URL. |
| `PKI_MASTER_KEY` | 64-character hex key for encrypted PKI material. |
| `RATE_LIMIT_WINDOW_MS` | Default rate-limit window. |
| `RATE_LIMIT_MAX_REQUESTS` | Default request limit. |
| `GRPC_PORT` | TLS-only gRPC port for daemon connections. |
| `GRPC_TLS_AUTO_DIR` | Directory for Gateway's auto-issued internal gRPC TLS certificate and key. |
| `GRPC_TLS_EXTRA_SANS` | Extra comma-separated DNS names or IP addresses for the auto-issued gRPC server certificate. Gateway also includes the persisted canonical public host and discovered host IP addresses automatically. |
| `GRPC_TLS_CERT` | Optional custom gRPC TLS certificate issued by Gateway's system CA. |
| `GRPC_TLS_KEY` | Optional custom gRPC TLS private key paired with `GRPC_TLS_CERT`. |
| `ACME_EMAIL` | Let's Encrypt account email. |
| `ACME_STAGING` | Use Let's Encrypt staging. |
| `HEALTH_CHECK_INTERVAL_SECONDS` | Proxy health check interval. |
| `ACME_RENEWAL_CRON` | ACME renewal schedule. |
| `EXPIRY_CHECK_CRON` | Certificate expiry check schedule. |

See [.env.example](../.env.example) for the full development reference.

Redis is required infrastructure. Gateway uses it for sessions, cache, and rate limiting; if Redis is unavailable, `/health` returns `503` and Redis-backed rate-limited API/auth/public surfaces fail closed with `RATE_LIMIT_UNAVAILABLE`.

OIDC scopes should normally include `openid email profile`. The `email` scope requests `email` and `email_verified`, but providers differ in whether `email_verified` is present in the ID token and whether it is true by default. Leave **Require verified OIDC email** disabled unless your IdP emits reliable verified-email claims.

### GitHub connector OAuth

GitHub connector OAuth works out of the box with Gateway's built-in product-wide OAuth App client ID. No environment configuration, client secret, or per-instance callback is required.

Set `GITHUB_OAUTH_CLIENT_ID` only to override the built-in client with a custom organization-owned **GitHub OAuth App**, for example for a fork or white-label deployment. Do not create a separate OAuth App per Gateway instance.

1. In GitHub, open **Settings > Developer settings > OAuth apps > New OAuth App**.
2. Set an operator-facing application name such as `Square Gateway` and use the product's public website as the homepage URL.
3. GitHub requires an authorization callback URL when registering the app. Use a stable HTTPS page controlled by the product, such as `https://gateway.thesquarelabs.com/`. Gateway's Device Flow does not redirect to this URL.
4. Enable **Device Flow**, then register the app.
5. Copy the app's **Client ID**. Gateway does not need a client secret; do not generate or distribute one for this integration.
6. Set the override on the installations that should use this custom app:

   ```dotenv
   GITHUB_OAUTH_CLIENT_ID=Ov23li...
   ```

7. Recreate the app container so it receives the environment variable:

   ```bash
   docker compose up -d --no-deps --force-recreate app
   ```

In Gateway, verify the setup under **Settings > Integrations > GitHub**. The user first clicks **Start GitHub authorization** so the device code is visible, then explicitly opens GitHub and approves access. The resulting user token is encrypted by Gateway and stored in the created connector.

The shared OAuth App currently requests `repo`, `workflow`, `read:org`, and `read:packages`. These scopes allow repository and CI operations, organization discovery, and package reads within the authorizing user's own GitHub access. GitHub Enterprise connectors remain token-based because the shared OAuth App is registered on `github.com`.

## Local authentication operations

Email/password and email-OTP sign-in require a verified SMTP configuration in **Settings > Advanced**. Do not enable either method until a test message succeeds. Gateway encrypts SMTP credentials using `PKI_MASTER_KEY`; losing or rotating that key without re-entering the SMTP password prevents delivery.

For local accounts, group MFA policy is enforced after the primary credential. TOTP recovery codes are one-use. If an account loses all MFA factors, a system administrator must reset MFA from the user administration screen; that action also revokes its browser sessions. Users and administrators can independently view and revoke browser sessions, but session cookies themselves are never exposed.

## Update Signing Operations

Gateway and daemon automatic updates require signed release manifests. Release CI must have `UPDATE_SIGNING_PRIVATE_KEY_PEM_B64` set to a base64-encoded Ed25519 private key PEM. The corresponding public key is compiled into Gateway and daemon binaries.

If `UPDATE_SIGNING_PRIVATE_KEY_PEM_B64` is missing, gateway and daemon release jobs fail instead of publishing unsigned automatic-update artifacts. To rotate the update signing key, generate a new key pair, update `config/update-trust/update-signing-public-key.pem`, deploy that release, then switch CI to the new private key.

## Programmatic Access

Gateway supports browser sessions, REST API tokens, OAuth access tokens, MCP access, logging ingest tokens, and inference runtime tokens. These are intentionally separate.

| Prefix | Token family | Purpose |
|--------|--------------|---------|
| `gw_` | API token | REST API automation. |
| `gwo_` | OAuth access token | Gateway API or Gateway MCP resource. |
| `gwl_` | Logging ingest token | Write-only structured log ingestion. |
| `gwi_` | Inference runtime token | Gateway Inference data-plane requests. |

### API Tokens

API tokens are created in Gateway settings and are scoped. They can call REST API routes according to their scopes and the owning user's current effective permissions.

Important behavior:

- Token scopes cannot exceed the owning user's permissions.
- Effective scopes are bounded by the owner at request time.
- Write-capable scopes satisfy matching read/view checks, but resource-scoped grants stay limited to the same resource.
- Create-only and destructive-only scopes do not imply browse access.
- Sensitive reveal or export operations require explicit scopes.
- API tokens are not accepted by the MCP endpoint.

### OAuth

Gateway supports OAuth 2.0 Authorization Code + PKCE for public clients.

Dynamic OAuth client registration is intended for public local clients such as CLIs and MCP clients. By default, newly registered clients may use only loopback callback URLs (`localhost`, `127.0.0.1`, or `::1`). This keeps automatic CLI login working without allowing arbitrary external callback origins.

Admins can enable OAuth extended callback compatibility in Gateway settings when a client requires an external HTTPS callback URL. When enabled, unverified OAuth clients may register HTTPS callback URLs outside loopback. The consent screen warns users whenever an authorization result will be sent to an external callback origin.

OAuth access tokens are resource-bound:

| Resource | URL | Accepted by |
|----------|-----|-------------|
| Gateway API | `https://<gateway>/api` | REST API routes. |
| Gateway MCP | `https://<gateway>/api/mcp` | Remote MCP endpoint. |

An OAuth access token for the API resource cannot call MCP. An OAuth access token for the MCP resource cannot call normal REST API routes.

Gateway intentionally treats the two OAuth resources differently:

- Gateway API OAuth keeps expiring access tokens and refresh-token renewal.
- Gateway MCP OAuth is intended for long-lived MCP and AI clients. MCP authorizations issue a long-lived access token and do not depend on refresh-token renewal during normal use.

MCP authorizations should be removed explicitly when access is no longer needed; revocation immediately stops the corresponding MCP token from being accepted.

OAuth authorizations are managed in **Profile > Authorizations > OAuth Applications**. If the same client has grants for both API and MCP resources, Gateway displays them as separate rows.

### MCP

The remote MCP endpoint is intended for AI and MCP clients.

MCP accepts only OAuth access tokens issued for the Gateway MCP resource. It rejects:

- Browser cookies.
- `gw_` API tokens.
- `gwl_` logging tokens.
- `gwi_` inference tokens.
- OAuth tokens issued for the Gateway API resource.

The `mcp:use` scope is a user-account capability gate. The owning user must have it for MCP access.

By default, Extended MCP compatibility is enabled and the first `tools/list` response includes every tool allowed by the OAuth grant. Administrators can disable it for clients that support dynamic discovery; in that mode MCP starts with a compact core toolset, clients call `discover_tools`, Gateway sends `notifications/tools/list_changed`, and the client refreshes `tools/list` so the activated tools become callable.

The `Ingress` toolset covers Domains, Routes, route folders, nginx templates, access lists, and raw route configuration. For compatibility, callable tool names, resource URIs, OAuth scopes, and REST paths still use `proxy_host`, `proxy`, or `/api/proxy-hosts`; those identifiers refer to the Routes shown in the Operations Console.

The same scoped automation surface includes managed database provisioning and container/deployment/Compose-service bindings; first-class Compose discovery, revisions, lifecycle operations, secrets, activity and Git-source builds; Page Projects, Deployments, Tags, deploy tokens, runtime configuration and Git-source builds; Build Worker-filtered job history with logs/cancel/retry; path-based Additional Routes; and independent Additional Secure Link Bindings. Remote MCP clients can also upload Pages artifact bytes with the authenticated `upload_pages_artifact` begin/chunk/finalize tool, while ordinary API clients can use the resumable deploy API.

MCP clients can read the same permission-filtered internal operator documentation used by AI Workspace through `read_gateway_documentation` or the `gateway://docs` resource tree. General topics are available to any valid MCP authorization; subsystem topics are listed and readable only when the delegated OAuth scopes grant that subsystem.

Extended compatibility can expose hundreds of schemas. Disable it only for clients that correctly handle `notifications/tools/list_changed` and need the smaller discovery-driven context.

### Scope Rules

Write-capable scopes satisfy matching read/view checks so users can operate on resources they are allowed to modify. Resource-scoped grants stay bounded to the same resource, and create-only or destructive-only scopes do not grant browse access by themselves.

For the complete scope list, implication behavior, delegability, and manual OAuth opt-in scopes, see [SCOPES.md](../SCOPES.md).

## Structured Logging

Logging is optional and is configured in **Settings > Advanced** as disabled, managed local, or external. Connection secrets are encrypted in Gateway settings. Legacy `CLICKHOUSE_*` env values are accepted only for migration and are removed by managed updates after a successful import.

### ClickHouse Image Upgrades

Gateway pins its managed local ClickHouse container to an explicit `clickhouse/clickhouse-server` release tag instead of using `latest`. Upgrade the pinned runtime intentionally and verify it against a copy of existing ClickHouse data.

An always-on guard monitors disk, structured logs, and ClickHouse internal logs. Enable **ClickHouse Internals** in **Settings → Housekeeping** to allow the five-minute guard and manual Housekeeping runs to trim supported system-log tables; enable it only when the entire ClickHouse instance is dedicated to Gateway.

Settings > Housekeeping can additionally cap the shared structured-log table by row count and approximate on-disk size. Cleanup drops only complete oldest daily partitions and preserves the current partition. Per-environment `retentionDays` TTL remains active independently. Internal cleanup is best effort and does not make ingest unavailable merely because maintenance privileges are absent.

If logging is disabled:

- Logging actions return `LOGGING_DISABLED`.
- The frontend hides the Logging section.

If ClickHouse is configured but unavailable:

- Environment metadata remains manageable.
- Ingest and search return `LOGGING_UNAVAILABLE`.

Authenticated users with `housekeeping:view` can inspect `GET /api/logging/health`. Confirmed disk or configured structured-log capacity exhaustion pauses ingest with `LOGGING_CAPACITY_EXHAUSTED` while existing log search remains available. The Dashboard shows storage pressure, degraded maintenance, exhaustion, and unavailability warnings.

### Logging Schemas

Gateway stores logs in one shared ClickHouse table. Each logging environment can define schema behavior:

| Mode | Behavior |
|------|----------|
| `reject` | Reject invalid log entries when unknown or invalid keys are present. |
| `strip` | Remove unknown custom labels/fields and accept the remaining event. |
| `loose` | Keep sanitized unknown custom labels/fields. |

### Ingest Examples

Single event:

```bash
curl -H "Authorization: Bearer gwl_xxx" \
  -H "Content-Type: application/json" \
  -X POST https://gw.example.com/api/logging/ingest \
  -d '{"severity":"info","message":"hello from curl","service":"demo"}'
```

Batch:

```bash
curl -H "Authorization: Bearer gwl_xxx" \
  -H "Content-Type: application/json" \
  -X POST https://gw.example.com/api/logging/ingest/batch \
  -d '{"logs":[{"severity":"info","message":"started","service":"api"},{"severity":"error","message":"failed","service":"api","fields":{"statusCode":500}}]}'
```

Search:

```bash
curl -H "Content-Type: application/json" \
  -H "Authorization: Bearer gw_xxx" \
  -X POST https://gw.example.com/api/logging/environments/<environment-id>/search \
  -d '{"from":"2026-04-27T00:00:00.000Z","to":"2026-04-27T23:59:59.999Z","severities":["error","fatal"],"message":"failed","limit":100}'
```

### TypeScript SDK

Gateway publishes the official TypeScript logging SDK as [`@wiolett/gateway-logger`](https://www.npmjs.com/package/@wiolett/gateway-logger). Install it in Node services that need structured log delivery with batching, retries, fallback handling, and trace/span context:

```bash
pnpm add @wiolett/gateway-logger
```

```ts
import { GatewayLogger } from "@wiolett/gateway-logger";

const logger = new GatewayLogger({
  endpoint: "https://gw.example.com",
  token: process.env.GATEWAY_LOGGING_TOKEN!,
  service: "billing-api",
  source: "worker-1",
  labels: { app: "billing", region: "eu" },
  fields: { version: "2.4.1" },
});

const trace = logger.createTrace({ requestId: "req_123" });
trace.info("Payment started");
trace.error("Payment capture failed", {
  labels: { provider: "stripe" },
  fields: { statusCode: 502, durationMs: 1834 },
});

await logger.flush();
await logger.close();
```

`gwl_` tokens are server-side write-only secrets. Do not expose them in browser code.

## AI Workspace

AI Workspace is the recommended intent-driven operating surface, but it is optional and disabled by default. The Operations Console remains fully usable without it.

To use it:

1. Go to **Settings > AI Workspace**.
2. Enable AI Workspace.
3. Choose **OpenAI-compatible** or, when the Inference feature is enabled, **Gateway Inference** as the provider type.
4. For OpenAI-compatible mode, configure the provider URL, endpoint family, model, and API key.
5. For Gateway Inference mode, choose a published default model and whether users may select another model they can access.
6. Review tool access and approval behavior.

AI Workspace offers two structured starting points in addition to free-form requests:

- **Scenarios** provide guided operational workflows while preserving the same permissions, approvals, and audit logging as a free-form request.
- **Plan Mode** researches and validates a multi-step change without performing mutations. Select Plan manually for any request; AI Workspace can also enter it automatically for complex, research-heavy, or materially risky work.

Plan Mode publishes a structured Plan Block for review. Choose **Implement** to begin, **Refine** to request another planning pass, or provide a custom instruction. Nothing mutates before **Implement** is explicitly confirmed. During execution, the progress block shows the active step and supports pause, resume, and cancel. A separate verification run completes the plan after implementation.

Operational notes:

- No data is sent to an AI provider until an administrator enables AI Workspace.
- Chat execution is backend-owned. Closing AI Workspace or reconnecting the browser does not make an active run depend on that WebSocket connection.
- Saved conversation history is loaded over REST, while active chat turns, approvals, questions, stops, and live snapshots use the AI WebSocket.
- Tool calls are permission-gated and scopes are checked by the backend before execution.
- Destructive operations require approval unless the user's AI approval mode allows the backend to auto-approve that class of tool.
- AI-initiated actions are flagged in audit logs.
- AI Workspace can use Gateway-specific context from its knowledge base.
- The selected model and reasoning effort are stored with each conversation. Changing a model after the conversation starts requires confirmation and adds a model-change marker to history.
- Gateway Inference mode uses the user's Inference limits instead of the AI Workspace request-limit block. The composer warns when an applicable quota window has 10% or less remaining and blocks new turns only when the budget is effectively exhausted.
- If a user's API budget is disabled, models backed only by API-provider connections are hidden from that user in both AI Workspace and Inference model catalogs.
- OpenAI-compatible provider values are preserved while Gateway Inference is selected. Disabling Inference restores the previous OpenAI-compatible configuration; if none exists, AI Workspace is disabled.
- Supported image attachments and generated artifacts are stored and previewed through Gateway-managed artifact routes.
- Each Work Session can have one active plan. Plans in separate Work Sessions can execute independently.

## Notifications And Status Pages

Gateway supports operational notification workflows:

- Webhook notification targets.
- Delivery history.
- Built-in templates for common integrations.
- Alert rules.
- Status-page incident workflows.
- Certificate, domain, health, and runtime alerts.

Use status pages for externally visible service health and incidents. Use notifications for internal operational alerts.

### SIEM Audit Export

Configure SIEM collectors in **Notifications → SIEM**. Gateway keeps delivery in the main app process: no separate Compose service or worker container is required. A scheduler claims durable outbox rows every 30 seconds with database leases, so duplicate scheduler execution is safe if more than one app process is present. This lease safety applies only to SIEM delivery; horizontal Gateway application clustering is not currently a supported deployment mode.

The feature flag is enabled by default where the Enterprise `siem-export` entitlement is available. Use **Settings > General > General settings > SIEM audit export** to turn it off installation-wide: this hides the SIEM screens, makes the SIEM API and AI tools unavailable, stops new outbox rows, and pauses delivery without restarting Gateway. Existing destinations, terminal history, and queued records stay in PostgreSQL; queued records resume after re-enabling the feature. Entitlement loss disables SIEM while preserving its configuration and stored data.

Each request sends `{ "schemaVersion": 1, "events": [...] }` to an HTTPS endpoint using either `Authorization: Bearer <token>`, one validated custom request header, or HMAC headers `X-Gateway-Timestamp` and `X-Gateway-Signature-256`. The HMAC is `sha256=<hex>` over `timestamp + "." + exact raw JSON request body`; the collector should reject stale timestamps and use constant-time comparison. A successful `2xx` completes the batch. Network errors, `408`, `429`, and `5xx` retry after 30 seconds, 2 minutes, 8 minutes, 30 minutes, 2 hours, 6 hours, and 12 hours, with at most eight attempts. Other `4xx` responses are terminal failures.

Use **Send test event** after configuring a collector. It sends a synthetic event only and creates neither an audit-log record nor a queued delivery. The delivery log intentionally shows safe status, timing, retry information, error text, and the reduced event only; it never stores or displays collector response bodies. Terminal delivery history follows the Audit Log retention setting in **Settings → Housekeeping**.

When troubleshooting, verify the endpoint against Gateway's outbound-webhook network policy, confirm the expected bearer, custom-header, or HMAC verification at the collector, and inspect the SIEM Delivery Log. Do not paste a token, header value, or HMAC secret into tickets, audit notes, chat, or collector URLs. Disabling an individual destination pauses its outstanding rows; re-enabling resumes them. Deleting a destination discards outstanding rows, while historical terminal rows remain until retention cleanup.

## Backups

Back up:

- PostgreSQL data.
- Redis data if preserving sessions and cache matters.
- ClickHouse data if structured logging is enabled.
- `.env`.
- Custom TLS certificate and key files.
- Any external volume paths you configured manually.

Critical secrets:

- `PKI_MASTER_KEY` is required to decrypt PKI private key material and encrypted provider/infrastructure credentials stored in PostgreSQL.
- Redis session data controls browser session validity; preserve Redis data only when session continuity matters.
- OIDC client secret is needed for login.
- ClickHouse and database credentials are needed for service startup.

Store backups separately from the Gateway server and test restore procedures before relying on them.

## Security Notes

For the full security model, including daemon PKI, mTLS enrollment, token boundaries, and hardening guidance, see [Security model](security.md).

- Prefer OIDC with MFA enforced at the identity provider.
- Grant users only the groups and scopes they need.
- Separate read, write, reveal, export, and destructive scopes.
- Treat API tokens, OAuth access tokens, OAuth refresh tokens, logging tokens, and inference runtime tokens as secrets.
- Use OAuth resource separation for API and MCP clients.
- Review audit logs after sensitive operations.
- Keep daemon update capability limited to trusted admins.
- Protect `.env` because it contains database, OIDC, session, and PKI secrets.

## Troubleshooting Pointers

If Gateway cannot start:

- Check `docker compose ps`.
- Check app logs with `docker compose logs app`.
- Verify `.env` values.
- Verify PostgreSQL, Redis, and ClickHouse health. Redis outages intentionally make `/health` fail and API/auth/public rate-limited endpoints return `503` until rate limiting is enforceable again.

If a node does not connect:

- Verify the node can reach `gw.example.com:9443`.
- Confirm the enrollment token was copied before it expired or was used.
- If logs mention a Gateway certificate fingerprint mismatch, delete the pending node and create a new node in Gateway, then rerun the generated command. You may change `--gateway` to a direct `9443/tcp` endpoint, but keep the generated `--gateway-cert-sha256` value.
- Check the daemon systemd logs.
- Confirm system time is sane on both Gateway and the node.

If Dashboard shows the red **Gateway relay is unavailable** state:

- Allow the bounded automatic recovery attempts to finish or use **View details** to inspect the safe diagnostic reason.
- If recovery remains critical, verify the `relay` Compose service, its identity volume, PostgreSQL reachability, and the independently pinned relay image. Do not bypass the relay by publishing another port or moving `9443/tcp` back to `app`.
- The red state means managed-node and private managed-database tunnel traffic is unavailable. Existing database sessions survive a PostgreSQL outage after establishment, but new opens fail closed until authorization can be checked.

If OAuth or OIDC fails:

- Verify redirect URI exact match.
- Verify the canonical public URL in **Settings > General** and the OIDC redirect URI in **Settings > Advanced**.
- Verify the provider exposes discovery metadata.
- Check Gateway app logs for callback errors.
