# Gateway Capabilities

[Back to README](../README.md)

Gateway is an AI-first but not AI-dependent self-hosted infrastructure control plane. Operators can work through AI Workspace or use the complete Operations Console, REST API, OAuth, and MCP surfaces without AI. The product is built around a central web app and host daemons that connect outbound to the app, so operators can manage common infrastructure workflows without direct shell access to every server.

Feature availability and plan limits are documented separately in [Plans and licensing](licensing.md). `Coming soon` and `In development` capabilities are not generally available runtime features until released.

For ready paid capabilities, Gateway enforces plan entitlements at the operation boundary as well as in the Operations Console. Plan changes preserve existing data and resources: creation and one-shot premium operations are blocked after downgrade, Git source automation stops while source history remains readable/removable, and Business-only external registry ingress is disabled. Internal PKI, SIEM export, and structured logging are disabled with their configuration and stored data retained. Personal, Business, and Enterprise expiration grace lasts 24 hours, 3 days, and 7 days respectively; the Dashboard shows a critical warning until the local deadline. See [Plans and licensing](licensing.md) for the ungrouped plan matrix and exact lifecycle rules.

## Ingress

Gateway uses managed nginx nodes as public ingress. The Ingress workspace is split into Domains, Routes, and SSL Certificates so placement, traffic forwarding, and TLS remain independently manageable while their relationship stays explicit.

Core ingress workflows:

- Assign every registered domain to one eligible nginx ingress node with a detected public service address.
- Create, edit, order, and delete routes. The REST API and persisted model retain the `proxy-host` name for compatibility.
- Keep each registered domain and every route using it on the same nginx node; Gateway rejects cross-node combinations.
- Configure SSL termination, manual upstream targets, or managed Docker container/deployment upstreams with published-port validation.
- Connect managed Docker workloads to nginx through Gateway Secure Links without exposing the workload port as a normal public management endpoint.
- Put an enabled managed route into maintenance mode to return HTTP 503, pause managed health checks, preserve its TLS paths, and expose maintenance state to alerts and status pages.
- Configure WebSocket support, custom headers, rewrites, and proxy behavior.
- Create proxy, redirect, and 404 routes.
- Group routes into folders and reorder them with drag-and-drop.
- Configure access lists with IP rules and basic authentication.
- Use nginx config templates with variables for repeatable route configuration.
- View real-time nginx logs and node stats.

Health checks:

- Configure expected status codes.
- Configure expected response body matching.
- Track health state and history.
- Surface failures in the UI and notification workflows.

Nginx integration:

- `managed` mode lets Gateway own a known-good base nginx config.
- `integrate` mode keeps an existing host nginx config and injects Gateway-managed includes.
- ACME HTTP-01 challenges are deployed only to the ingress node assigned to the registered domain. That node must be online, publicly reachable on port 80, and have a public service address.

## Pages

Gateway Pages provides project-based static-site hosting on managed nginx ingress nodes. Pages is available on Personal and higher; Community installations cannot create or manage Pages projects, deployments, or Pages Routes.

Pages workflows:

- Model each site as a Project with immutable Deployments and mutable Tags. `latest` is system-managed, and custom Routes target Tags.
- Store source artifacts in Gateway and materialize replicas on managed nginx nodes through `nginx_pages_v1`.
- Configure one optional wildcard preview profile for immutable deployment hostnames. Its one-label template contains `{hash}` exactly once.
- Enable or disable Pages globally from Settings. Disabled Pages is removed from navigation; Community users can inspect and edit the form, but saving opens the shared Personal upgrade flow.
- Serve public runtime configuration at `/_gateway/pages/config.js` as `window.runtime.config`. It is capped at 64 KiB, served with `no-store`, and does not change Deployment identity or artifact hashes.
- Re-authorize resumable upload append/finalize requests and deploy-token Tag policy; publication verifies generation/status and rollback state before cleanup.
- Integrate Pages with scopes, folders, EventBus/WebSocket, notifications, audit/SIEM, retention, navigation, search, cache, and resource context.
- Operate Projects, Deployments, Tags, runtime configuration, placement migration, and profile settings through the scoped AI Workspace and remote MCP Pages toolset. Remote MCP clients can upload artifact bytes with the authenticated `upload_pages_artifact` begin/chunk/finalize workflow (maximum 1 MiB decoded per chunk, no credential argument); ordinary API clients can keep using the resumable deploy API.

## Route Extensions

Managed Routes can contain Additional Routes for literal path prefixes such as `/api` or `/assets`. Each location can target a manual address, Docker container, Docker deployment, or ready Pages Tag and can carry its own buffering, timeout, WebSocket, prefix-stripping, and advanced location directives. Custom proxy templates support them when they include `{{{renderAdditionalRoutes additionalRoutes id accessList rateLimitEnabled rateLimitBurst connectionsPerIp}}}` inside the intended `server` block. Docker targets own the Secure Link binding created for that location, so retry, edit, and delete follow the Additional Route lifecycle.

The AI Workspace and remote MCP Ingress route tools use the same managed-upstream contract as the Console and REST API: root Routes can target manual addresses, Docker containers, Docker deployments, or ready Pages Tags, and `set_route_maintenance` uses the canonical maintenance lifecycle instead of disabling or rewriting a Route.

Additional Secure Link Bindings are separate user-managed Docker bindings intended for upstreams referenced from advanced nginx config. Route-owned bindings remain visible in the binding list but cannot be deleted independently. Both lifecycles are available through the scoped Operations Console, AI Workspace, REST/OAuth, and remote MCP Ingress toolset.

## Relay And Secure Links

The installed local relay is a long-lived data-plane service and the sole public owner of `9443/tcp`; the Gateway app keeps only an internal gRPC listener. Managed daemons use the relay for authenticated control connections and tunnel traffic, including private managed-database bindings and Docker-to-nginx Secure Links.

Gateway can extend the local relay into a Relay Pool without exposing pool topology to applications. Operators enroll remote supervisor/worker pairs, verify distinct physical fault domains, explicitly rebalance placement, drain members, and apply signed rolling updates one member at a time. Remote supervisor management remains outbound-only, while each worker's advertised data endpoint must be reachable from assigned managed hosts. Gateway does not open firewalls, provide NAT traversal, or create an overlay network; the product continues to present one logical Secure Link.

## Docker

Gateway manages Docker through the `docker-daemon` installed on container hosts.

Container workflows:

- List containers across managed Docker nodes.
- Grant container permissions for an entire Docker node or narrow them to one standalone container or blue/green deployment.
- Start, stop, restart, recreate, duplicate, rename, and remove containers.
- Choose the Default (`runc`) isolation profile in every plan. Business and Enterprise plans can also use the Secure (`runsc` through gVisor) profile when the target node reports a healthy Secure Runtime capability. Secure workloads cannot use GPUs, device attachments, host bind mounts, cross-node migration, or `.gwca` export.
- Attach one or more node-discovered physical NVIDIA, AMD, or Intel GPUs to standalone containers and blue/green deployments. GPU devices are shared rather than reserved; changing a selection recreates the workload, duplicates preserve it, and both blue/green slots receive the same selection.
- Stream `.gwca` exports and imports on Personal and higher in either self-contained portable mode or smaller registry-backed mode. Export is protected by the dedicated, resource-scopable `docker:containers:export` permission in addition to file and environment access. Archives use a Gateway-supported configuration whitelist, always carry ordinary environment values, can optionally carry secrets, and can optionally capture the writable layer without pausing. Registry-backed archives pull and verify an immutable digest. Volume contents are never included; source volumes are restored as empty managed local volumes unless an eligible existing managed local volume is selected. Host bind mounts are not portable. Networks and occupied ports can be remapped for the target node.
- Create, inspect, and remove images, volumes, and networks across managed nodes.
- Run durable cross-node migrations on Personal and higher for eligible containers and blue/green deployments, including image and volume transfer, capacity preflight, verification, cutover, cancellation, and cleanup recovery. GPU-attached workloads are intentionally not portable in v1.
- Move resource-scoped grants with a container or deployment during migration. Recreates preserve the stable access identity; explicit deletion removes its grants so a later same-name resource starts without inherited access.
- Edit image, command, environment variables, secrets, labels, ports, restart policy, and runtime limits.
- Edit mounts only with the dedicated `docker:containers:mounts` scope. New and changed mounts accept only Gateway-managed local volumes; new host bind mounts are rejected. Existing legacy mounts are preserved during normal image, environment, and webhook updates.
- Browse container logs with search and follow mode.
- On Community and every paid plan, discover externally created Docker Compose projects from canonical labels and inspect their inventory, status, monitoring, and logs as read-only Compose Projects. Gateway can adopt a project only after the user supplies its complete single-file YAML; Gateway never reads host Compose files from label paths.
- On Personal and higher, deploy and manage single-node Compose Projects with immutable revisions, validation, explicit Pull & Apply, start/stop/restart/down, aggregated logs, operation history, folders, masked secrets, drift reporting, ordinary non-Swarm CPU/memory/PID limits, managed database links, and Route/Secure Link targeting by project/service identity. Manual YAML revisions remain image-only: `build`, host bind mounts, privileged/device access, and swarm-only fields are rejected before mutation.
- Hide project-owned containers, named volumes, and non-external networks from standalone lists and block their direct mutations. Images and external/shared resources remain global. Compose resources are not eligible for cross-node migration.
- Open an interactive container console.
- Browse and edit container files when permitted.
- Keep sanitized inventory snapshots so read views can show the last synchronized Docker state while a node is offline or refreshing; mutations remain unavailable until the node reconnects.
- Manage Docker images and cleanup old images.
- Manage private registry credentials and image registry mappings.
- On Business and Enterprise, create a container, blue/green deployment, or Compose Project from an allowlisted GitLab, GitHub, or generic Git repository, or attach a repository directly to an existing Docker or Compose resource. Gateway resolves an exact branch commit, queues durable builds, stores approved artifacts by immutable digest, and uses safe container recreate, the existing health-checked blue/green path, or an immutable Compose revision. The UI permits configuring Repository mode before enforcing the plan when **Create and build** or **Connect** is pressed; the backend independently enforces Business at source mutation and build admission.
- A repository Compose file may use the supported single-node `build` subset (`context`, `dockerfile`, and `args`). Gateway creates one child build per service, waits until every expected artifact is approved, then creates one digest-pinned immutable revision and applies it atomically. A failed, rejected, cancelled, or superseded child prevents the project rollout. Repository service networks and managed database overlays are added to the runtime revision without rewriting the authored source file.
- Review global build history, Build Worker assignment, logs, vulnerability findings/policy results, desired and deployed commits, Compose service names, and per-resource source settings. Repository, integration, branch, Dockerfile/Compose-file path, build context, separate automatic-build and automatic-deploy controls, and source-scoped Build Secrets remain part of the Docker or Compose resource rather than a separate application entity.
- Use the Gateway-managed internal Distribution registry on every plan without assigning a domain or publishing a host port. It keeps three successful artifacts plus active, rollback, in-progress, and manually pinned digests. Optional Business+ external Docker-client access is configured under **Settings > Features** and is exposed only through a selected nginx node, domain, TLS certificate, and repository/action-scoped token. Entitlement loss disables that ingress and every public token request rechecks the current plan.
- Configure a trusted HTTPS token-service origin only for registries whose Bearer auth service is intentionally hosted on a separate origin.
- Track long-running Docker operations in the Tasks view.

Deployment workflows:

- Create deployment definitions separate from running containers.
- Use deployment slots for rollout and rollback.
- Deploy, switch, rollback, stop slots, and monitor deployment health.
- Trigger image pull and recreate/deploy workflows from CI/CD webhooks.
- Store deployment secrets encrypted and reveal them only with explicit permission.

Safety controls:

- Mount editing is separated from normal container editing and constrained to Gateway-managed local volumes. Legacy mounts remain visible only where needed for compatibility and cannot be reintroduced after removal.
- Repository builds are admitted only while the internal registry is writable and an online Build Worker advertises BuildKit/containerd execution, dedicated-runtime, and enforced-resource-profile capabilities. A Build Worker is the existing `docker-daemon` in `builder` mode and has no Docker Engine socket.
- The current builder profile accepts one build at a time, uses a dedicated containerd namespace and runc runtime, disables OCI-worker and insecure entitlements, applies fixed CPU/RAM/PID limits, accounts job/runtime disk use, and clears BuildKit cache between jobs. The separate worker host or outer unprivileged container is the security boundary and must not contain unrelated workloads or credentials. Builder egress is installer-selectable and defaults to public internet with metadata/private/control-plane denial. Source-scoped Build Secrets use BuildKit secret mounts and log redaction; scanner SBOM data is ephemeral, and provenance is not published.
- Secrets are masked by default.
- Dangerous operations are permission-scoped and audited.

## Certificates And PKI

Gateway includes SSL certificate management and internal PKI.

ACME SSL:

- Issue Let's Encrypt certificates.
- Use HTTP-01 and DNS-01 challenge flows.
- Renew certificates on a configurable schedule.
- Attach certificates to routes. Gateway keeps the canonical certificate material and deploys node-local replicas only where enabled TLS routes use it.

Uploaded SSL:

- Upload existing certificates.
- Track expiration.
- Use uploaded certificates for routes.

Internal PKI:

Internal PKI is available on Enterprise. Losing the entitlement disables user-facing PKI without deleting authorities, certificates, templates, or audit history. Gateway's hidden system PKI remains available for internal platform transport.

- Create root and intermediate certificate authorities.
- Issue TLS server, TLS client, code-signing, and email certificates.
- Use certificate templates with custom extensions and policies.
- Generate and publish CRLs.
- Export certificates as PEM, PKCS#12, or JKS when the user has export scopes.

Private key material is encrypted at rest with the configured `PKI_MASTER_KEY`. Export and reveal operations are controlled by explicit scopes.

## Domains

Gateway keeps a central registry of public hostnames and their ingress placement.

Domain workflows:

- Track domains independently from routes and certificates.
- Use either external DNS or a Cloudflare connector. External DNS remains operator-managed; Cloudflare-managed domains can have their A/AAAA records created and reconciled automatically.
- Select an eligible nginx ingress node for every domain. Nodes without a detected public service address are not eligible.
- Validate DNS records such as A, AAAA, CNAME, CAA, MX, and TXT.
- Track domain usage across routes and SSL certificates.
- Surface DNS status in the UI.
- Use scheduled DNS checks for ongoing validation.
- Move a domain and its routes between eligible nginx nodes through the explicit ingress migration workflow. Cloudflare-managed DNS is updated during cutover; external DNS requires the operator to update records before completion.

## Databases

Gateway can store external PostgreSQL, Redis, and ClickHouse connections with encrypted credentials, and deploy managed Postgres, Redis, and ClickHouse instances on dedicated database nodes. Enrolling database nodes is available in every plan; creating managed database instances requires Personal or higher.

AI Workspace and the remote MCP Databases toolset can read the managed catalog, provision/retry/delete instances, and create or remove application bindings under the same license and database/Docker scopes as the Operations Console.

Managed instances are private by default. Gateway binds applications through a private connector and authenticated tunnel, with a separate engine identity per binding. Publishing TCP for external infrastructure is an explicit opt-in; it requires database authentication, Gateway does not open host firewalls automatically, and the path is not tunnel-encrypted unless native database TLS is configured.

The managed-database tunnel terminates in a dedicated long-lived relay container on the existing Gateway `9443/tcp` endpoint. Ordinary application updates do not recreate this relay, so established binding sessions and new opens for already-ready bindings can continue while the app is restarting. Relay updates are explicit data-plane maintenance and may interrupt tunnel sessions.

The same logical tunnel can use a Relay Pool without exposing pool topology to the workload. Operators may enroll remote relay supervisors, explicitly rebalance assignments across distinct physical fault domains, drain instances, and roll signed relay updates one member at a time. A global fixed-count or all-ready-relays spread can be overridden per workload. Daemons balance each new connection across the pre-registered active set and exclude draining members without interrupting existing streams; Gateway remains the control plane and does not forward payload bytes.

TCP publication and its host port are fixed at provisioning time because Docker cannot safely change live port bindings; recreate the managed instance to change that endpoint.

Each binding creates a dedicated Postgres role, Redis ACL user, or ClickHouse user; deleting the binding revokes that principal. For normal containers Gateway attaches a private binding network and recreates the workload with the selected connection variables. For blue/green deployments it adds the private network and encrypted variables to the desired configuration, then rolls a slot so future blue and green containers receive the same connector endpoint.

Managed lifecycle actions use durable operation IDs and reconciliation, so a temporary daemon disconnect leaves the instance in a transitional state until Gateway verifies the final daemon state rather than guessing success or failure.

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

ClickHouse:

- Test saved connections and track health history.
- Browse databases, tables, views, dictionaries, and rows.
- Run SQL through a scoped console.
- Insert, update, or delete rows only when the selected table engine, server version, and caller permissions allow the operation; schema mutations are not exposed through the explorer.

Credential reveal and query execution are intentionally separate permissions. Users can be allowed to monitor a database without being allowed to reveal credentials or run arbitrary commands. Binding-injected application credentials are not displayed by default.

## Storage

Storage is the next product capability family and is marked **Coming soon**.

Planned connection types:

- S3-compatible object storage.
- Cloudflare R2.
- MinIO.
- FTP and FTPS.
- SFTP.
- SMB.

Managed storages with Secure Links and managed-database backup and restore are also coming soon. Database backup and restore follows the Storage foundation and should not be described as generally available before that release.

## Nodes And Monitoring

Gateway supports four daemon types:

| Type | Daemon | Purpose |
|------|--------|---------|
| nginx | `nginx-daemon` | Public ingress, routes, TLS termination, access lists, nginx configuration, logs, and stats. |
| docker | `docker-daemon` | Docker container and deployment management. |
| databases | `docker-daemon` | Restricted profile for Gateway-managed Postgres, Redis, and ClickHouse instances. |
| monitoring | `monitoring-daemon` | Host metrics without nginx or Docker control. |

Node features:

- Enroll nodes with one-time tokens.
- Communicate over outbound gRPC with mTLS.
- Reconnect automatically with exponential backoff.
- Show version compatibility state.
- Stream node logs.
- Open scoped host consoles and browse or edit node files when explicitly permitted.
- Collect CPU, memory, disk, and network metrics.
- Report capability-aware physical GPU inventory and telemetry. Container monitoring shows a selected GPU's shared physical metrics, never fabricated per-container usage.
- Report local/public IP addresses and allow an explicit Docker service address for cross-node and proxy-upstream traffic.
- Remotely update daemon binaries with SHA256 verification and atomic replacement.

Managed services keep running if the Gateway app is offline. You lose central control until the app returns, but nginx, Docker, and managed database services continue using the last applied host state. With a healthy relay and PostgreSQL, private managed-database bindings continue independently of an app-only restart.

## Structured Logging

Gateway can ingest external service logs into ClickHouse on Business and Enterprise.

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
- Housekeeping caps by total rows and approximate on-disk size, in addition to per-environment TTL.
- Always-on ClickHouse health and internal-log budget guard with Dashboard warnings.
- Official TypeScript SDK published as [`@wiolett/gateway-logger`](https://www.npmjs.com/package/@wiolett/gateway-logger), with source in `packages/logging-sdk`.

Logging is optional. When structured logging is set to **Disabled** in Gateway settings, logging routes report that logging is disabled and the frontend hides the Logging section.

## Integrations, Notifications, And Status Pages

Gateway includes connector and operational communication surfaces:

- Cloudflare connectors for managed A/AAAA records, DNS inspection, and automated DNS-01 certificate workflows.
- GitLab connectors with project/group allowlists, scheduled project synchronization, repository and CI operations, variables, webhooks, and sandbox clone support. Automatic container-registry discovery and import requires Personal or higher; ordinary Git integration remains available on Community.
- GitHub connectors for repository discovery, tree/file operations, branches, commits, Actions workflows and secrets, using the built-in Device Flow or an explicitly configured token.
- Generic Git connectors for authenticated repository access outside the first-class GitLab and GitHub providers.
- External SSH connectors with encrypted credentials, host-key verification, explicit scopes, and controlled command/file operations against administrator-configured hosts. This is distinct from the future Gateway-managed bastion daemon.
- Webhook notification targets with custom headers, templates, HMAC signing, retries, and delivery history.
- Enterprise SIEM audit export, when enabled in Gateway settings, to up to five active HTTPS collectors, with encrypted bearer, HMAC-SHA256, or validated custom-header authentication, durable batched delivery, retry history, and least-privilege `audit:siem:*` scopes.
- Threshold and event alert rules for nodes, containers, routes, Pages, Gateway/relay health, logging, integrations, certificates, security events, PostgreSQL, ClickHouse, and Redis. GPU node rules evaluate only metrics reported by each physical device and can target a selected GPU on one scoped node.
- Public status pages on Personal and higher with managed services, incidents, incident updates, proxy templates, and preview.

Connector credentials are encrypted at rest. GitLab access is split between connector administration and per-user credentials unless the caller has the explicit system credential scope.

## Application Scaling

The following application-scaling capabilities are **In development** for Business and Enterprise. They are included in those plan positions when released, but they are not generally available runtime features today:

- **Horizontal application scaling:** group multiple Docker nodes as one application cluster and deploy an application to that cluster.
- **Vertical workload scaling:** run multiple managed instances of one workload on the same managed machine.
Existing single-node Compose Projects, multi-node resource management, cross-node migration, and blue/green deployments do not constitute horizontal clustering or same-node replica scaling.

## Vulnerability And Security Scanning

Vulnerability and security scanning is **In development** for Business and Enterprise. It is not a completed capability until the scanning workflow is released.

## Gateway Inference

Gateway Inference is an optional model gateway available in every product plan. It is separate from AI Workspace and the remote MCP server.

Inference features:

- Connect multiple API-key, local, device-code, and supported subscription providers.
- Publish logical models with access rules, reasoning mappings, pricing, context limits, and one or more compatible account sources.
- Order published models and reasoning levels for data-plane catalogs, Codex manifests, and AI Workspace selectors.
- Route requests across healthy accounts while keeping continuation and conversation affinity.
- Group multiple accounts of the same provider in the administration table and reorder them within that provider for Sequential routing.
- Enforce default and per-user five-hour, weekly, monthly, and API-spend budgets.
- Expose a base OpenAI-compatible API plus optional Codex- and Anthropic-specific adapters.
- Issue dedicated `gwi_` runtime tokens that are accepted only by inference data-plane routes.
- Configure Codex CLI/Desktop and Claude Code through the interactive [`@wiolett/gateway-inference`](../packages/gateway-inference) companion.

Inference is disabled by default. See the [inference guide](inference.md) for provider, model, limit, token, and client setup.

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

- OIDC, local password, and email one-time-code authentication; users can add passkeys after setup.
- Built-in and custom permission groups.
- Per-user additional scope grants, bounded by the permissions of the administrator assigning them.
- Granular scopes for users, groups, API tokens, OAuth grants, and MCP access.
- Write-capable scopes imply matching read/view checks while preserving resource boundaries.
- Audit log for user, token, OAuth, and AI-initiated actions.
- SIEM destination management and privacy-reduced external audit export.
- Setup state and first-run configuration.
- Update checks and in-app Gateway updates.
- Daemon runtime version tracking and daemon updates.
- License state and edition display.

## AI Workspace

AI Workspace is the recommended intent-driven operating surface. It is opt-in and disabled by default, while the Operations Console remains a complete independent interface.

When enabled by an admin, it can:

- Start from guided operational Scenarios or a free-form desired outcome.
- Use complete task Scenarios for setup, infrastructure health, nodes, Docker, proxy publication and diagnosis, TLS, logging, notifications, databases, status pages, and access delegation.
- Enter Plan Mode manually or automatically for complex, multi-step, research-heavy, or materially risky work.
- Research with read-only planning tools, validate a structured Plan Block, and wait for explicit confirmation before any mutating action is available.
- Execute a confirmed plan in the background with step progress, pause, resume, cancel, and a separate final-verification run.
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
- Move between AI Workspace and the Operations Console without changing the underlying resource model or permissions.

One plan can be active in each Work Session, while separate Work Sessions can run plans independently. Planning is separate from Approval Mode: planning itself is read-only, and confirmed execution follows the user's current approval settings. Scenarios do not bypass permissions, approvals, or audit logging.

OpenAI-compatible settings remain preserved while Gateway Inference is selected. If Inference is later disabled, AI Workspace returns to the previous OpenAI-compatible configuration or disables itself when none was configured. No data is sent to an AI provider until an administrator enables AI Workspace and configures a provider.
