# Gateway Capabilities

[Back to README](../README.md)

Gateway is a self-hosted infrastructure control plane. It is built around a central web app and host daemons that connect outbound to the app, so operators can manage common infrastructure workflows without direct shell access to every server.

## Reverse Proxy

Gateway manages nginx through the `nginx-daemon` installed on each proxy node.

Core proxy workflows:

- Create, edit, order, and delete proxy hosts.
- Manage proxy hosts across multiple nginx nodes.
- Configure SSL termination, manual upstream targets, or managed Docker container/deployment upstreams with published-port validation.
- Put an enabled managed proxy host into maintenance mode to return HTTP 503, pause managed health checks, preserve its TLS paths, and expose maintenance state to alerts and status pages.
- Configure WebSocket support, custom headers, rewrites, and proxy behavior.
- Create redirect hosts and 404 hosts.
- Group proxy hosts into folders and reorder them with drag-and-drop.
- Configure access lists with IP rules and basic authentication.
- Use nginx config templates with variables for repeatable host configuration.
- View real-time nginx logs and node stats.

Health checks:

- Configure expected status codes.
- Configure expected response body matching.
- Track health state and history.
- Surface failures in the UI and notification workflows.

Nginx integration:

- `managed` mode lets Gateway own a known-good base nginx config.
- `integrate` mode keeps an existing host nginx config and injects Gateway-managed includes.
- ACME HTTP-01 challenge paths can be managed for proxy hosts.

## Docker

Gateway manages Docker through the `docker-daemon` installed on container hosts.

Container workflows:

- List containers across managed Docker nodes.
- Grant container permissions for an entire Docker node or narrow them to one standalone container or blue/green deployment.
- Start, stop, restart, recreate, duplicate, rename, and remove containers.
- Create, inspect, and remove images, volumes, and networks across managed nodes.
- Run durable cross-node migrations for containers and blue/green deployments, including image and volume transfer, capacity preflight, verification, cutover, cancellation, and cleanup recovery.
- Move resource-scoped grants with a container or deployment during migration. Recreates preserve the stable access identity; explicit deletion removes its grants so a later same-name resource starts without inherited access.
- Edit image, command, environment variables, secrets, labels, ports, restart policy, and runtime limits.
- Edit mounts only with the dedicated `docker:containers:mounts` scope. Existing mounts are preserved during normal image, environment, and webhook updates.
- Browse container logs with search and follow mode.
- Open an interactive container console.
- Browse and edit container files when permitted.
- Keep sanitized inventory snapshots so read views can show the last synchronized Docker state while a node is offline or refreshing; mutations remain unavailable until the node reconnects.
- Manage Docker images and cleanup old images.
- Manage private registry credentials and image registry mappings.
- Configure a trusted HTTPS token-service origin only for registries whose Bearer auth service is intentionally hosted on a separate origin.
- Track long-running Docker operations in the Tasks view.

Deployment workflows:

- Create deployment definitions separate from running containers.
- Use deployment slots for rollout and rollback.
- Deploy, switch, rollback, stop slots, and monitor deployment health.
- Trigger image pull and recreate/deploy workflows from CI/CD webhooks.
- Store deployment secrets encrypted and reveal them only with explicit permission.

Safety controls:

- Mount editing is separated from normal container editing because host bind mounts can expose sensitive host data or control surfaces.
- Secrets are masked by default.
- Dangerous operations are permission-scoped and audited.

## Certificates And PKI

Gateway includes SSL certificate management and internal PKI.

ACME SSL:

- Issue Let's Encrypt certificates.
- Use HTTP-01 and DNS-01 challenge flows.
- Renew certificates on a configurable schedule.
- Attach certificates to proxy hosts.

Uploaded SSL:

- Upload existing certificates.
- Track expiration.
- Use uploaded certificates for proxy hosts.

Internal PKI:

- Create root and intermediate certificate authorities.
- Issue TLS server, TLS client, code-signing, and email certificates.
- Use certificate templates with custom extensions and policies.
- Generate and publish CRLs.
- Export certificates as PEM, PKCS#12, or JKS when the user has export scopes.

Private key material is encrypted at rest with the configured `PKI_MASTER_KEY`. Export and reveal operations are controlled by explicit scopes.

## Domains

Gateway keeps a central registry of domains used by the system.

Domain workflows:

- Track domains independently from proxy hosts and certificates.
- Validate DNS records such as A, AAAA, CNAME, CAA, MX, and TXT.
- Track domain usage across proxy hosts and SSL certificates.
- Surface DNS status in the UI.
- Use scheduled DNS checks for ongoing validation.

## Databases

Gateway can store PostgreSQL and Redis connections with encrypted credentials.

PostgreSQL:

- Test saved connections.
- Track connection health and history.
- Browse schemas and tables.
- Browse rows.
- Insert, update, and delete rows when permitted.
- Run SQL through a scoped console.

Redis:

- Test saved connections.
- Track health and history.
- Scan keys.
- Inspect values.
- Set, delete, and expire keys when permitted.
- Run Redis commands through a scoped console.

Credential reveal and query execution are intentionally separate permissions. Users can be allowed to monitor a database without being allowed to reveal credentials or run arbitrary commands.

## Nodes And Monitoring

Gateway supports three daemon types:

| Type | Daemon | Purpose |
|------|--------|---------|
| nginx | `nginx-daemon` | Reverse proxy management. |
| docker | `docker-daemon` | Docker container and deployment management. |
| monitoring | `monitoring-daemon` | Host metrics without nginx or Docker control. |

Node features:

- Enroll nodes with one-time tokens.
- Communicate over outbound gRPC with mTLS.
- Reconnect automatically with exponential backoff.
- Show version compatibility state.
- Stream node logs.
- Open scoped host consoles and browse or edit node files when explicitly permitted.
- Collect CPU, memory, disk, and network metrics.
- Report local/public IP addresses and allow an explicit Docker service address for cross-node and proxy-upstream traffic.
- Remotely update daemon binaries with SHA256 verification and atomic replacement.

Managed services keep running if Gateway is offline. You lose central control until Gateway returns, but nginx and Docker continue using the last applied host state.

## Structured Logging

Gateway can ingest external service logs into ClickHouse.

Logging features:

- UI-managed environments.
- Per-environment schemas.
- Retention settings.
- Write-only `gwl_` ingest tokens.
- Single-event and batch ingestion APIs.
- Severity validation.
- Payload, token, environment, and global rate limits.
- Partial batch acceptance.
- Search UI with filters and event detail inspection.
- Official TypeScript SDK published as [`@wiolett/gateway-logger`](https://www.npmjs.com/package/@wiolett/gateway-logger), with source in `packages/logging-sdk`.

Logging is optional. If `CLICKHOUSE_URL` is not configured, logging routes report that logging is disabled and the frontend hides the Logging section.

## Integrations, Notifications, And Status Pages

Gateway includes connector and operational communication surfaces:

- Cloudflare connectors for managed A/AAAA records, DNS inspection, and automated DNS-01 certificate workflows.
- GitLab connectors with project/group allowlists, scheduled synchronization, repository and CI operations, variables, webhooks, registry access, and sandbox clone support.
- Webhook notification targets with custom headers, templates, HMAC signing, retries, and delivery history.
- Threshold and event alert rules for nodes, containers, proxies, certificates, PostgreSQL, and Redis resources.
- Public status pages with managed services, incidents, incident updates, proxy templates, and preview.

Connector credentials are encrypted at rest. GitLab access is split between connector administration and per-user credentials unless the caller has the explicit system credential scope.

## Gateway Inference

Gateway Inference is an optional model gateway that is separate from the internal AI Assistant and remote MCP server.

Inference features:

- Connect multiple API-key, local, device-code, and supported subscription providers.
- Publish logical models with access rules, reasoning mappings, pricing, context limits, and one or more compatible account sources.
- Route requests across healthy accounts while keeping continuation and conversation affinity.
- Enforce default and per-user five-hour, weekly, monthly, and API-spend budgets.
- Expose a base OpenAI-compatible API plus optional Codex- and Anthropic-specific adapters.
- Issue dedicated `gwi_` runtime tokens that are accepted only by inference data-plane routes.
- Configure Codex CLI/Desktop and Claude Code through the interactive [`@wiolett/gateway-inference`](../packages/gateway-inference) companion.

Inference and its harness-specific endpoints are disabled by default. See the [inference guide](inference.md) for provider, model, limit, token, and client setup.

## Programmatic Access

Gateway has four token families:

| Prefix | Purpose |
|--------|---------|
| `gw_` | Gateway REST API tokens. |
| `gwo_` | OAuth access tokens for Gateway API or Gateway MCP resources. |
| `gwl_` | Write-only logging ingest tokens. |
| `gwi_` | Dedicated Gateway Inference runtime tokens. |

OAuth uses public-client Authorization Code + PKCE and resource-bound access tokens:

- Gateway API resource: `https://<gateway>/api`
- Gateway MCP resource: `https://<gateway>/api/mcp`

REST API routes accept browser sessions, `gw_` API tokens, and `gwo_` OAuth tokens issued for the Gateway API resource. The MCP endpoint accepts only `gwo_` OAuth tokens issued for the Gateway MCP resource. Inference data-plane routes accept only `gwi_` tokens and never accept REST, OAuth, logging, or browser credentials.

For scope rules and delegation details, see [SCOPES.md](../SCOPES.md).

## Administration

Administration features:

- OIDC authentication.
- Built-in and custom permission groups.
- Per-user additional scope grants, bounded by the permissions of the administrator assigning them.
- Granular scopes for users, groups, API tokens, OAuth grants, and MCP access.
- Write-capable scopes imply matching read/view checks while preserving resource boundaries.
- Audit log for user, token, OAuth, and AI-initiated actions.
- Setup state and first-run configuration.
- Update checks and in-app Gateway updates.
- Daemon runtime version tracking and daemon updates.
- License state and edition display.

## Optional AI Assistant

The AI assistant is disabled by default.

When enabled by an admin, it can:

- Use a configured OpenAI-compatible provider or an accessible published Gateway Inference model.
- Call Gateway tools through permission-gated operations.
- Ask clarifying questions before acting.
- Continue backend-owned chat runs independently of an open browser panel.
- Use backend approval and question flows over WebSocket for active chat turns.
- Use a system-specific knowledge base.
- Save and restore conversations.
- Pin the selected model and reasoning effort to each conversation and warn before changing the model mid-chat.
- Attach and preview supported images and generated artifacts.
- Surface Gateway Inference quota warnings and stop new turns only when the applicable budget is exhausted.
- Respect per-user tool access and AI approval mode preferences.

OpenAI-compatible settings remain preserved while Gateway Inference is selected. If Inference is later disabled, the assistant returns to the previous OpenAI-compatible configuration or disables itself when none was configured. No data is sent to an AI provider until an admin enables the assistant and configures a provider.
