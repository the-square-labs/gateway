English | [Русский](README.ru.md) | [中文](README.cn.md)

# Gateway

AI-first but not AI-dependent self-hosted infrastructure control plane for nginx ingress, Docker workloads, certificates, databases, logs, monitoring, status pages, and automation.

## Why Gateway

Gateway gives small infrastructure teams one product for the daily work that usually lives across nginx configs, shell scripts, Docker hosts, certificate folders, database clients, dashboards, and alert tools.

AI Workspace is the recommended intent-driven interface: start from a complete Scenario or describe the desired outcome, review a proposed plan, and decide whether to execute it. The Operations Console remains a complete independent interface for the same infrastructure, so installing, operating, automating, and recovering Gateway does not depend on AI.

Use it when you want to:

- Operate multiple proxy, Docker, and monitoring nodes without opening inbound management ports on those nodes.
- Give operators a focused UI and API for production tasks without giving them root shell access.
- Centralize TLS, internal PKI, ACME certificates, domains, status pages, notifications, and audit history.
- Manage Docker containers, deployments, portable or registry-backed `.gwca` archives, logs, files, consoles, secrets, and registry workflows from one place.
- Expose controlled automation through API tokens, OAuth, CI/CD webhooks, and MCP clients.
- Start from an AI Workspace Scenario or use Plan Mode to research and validate a multi-step change before explicitly confirming execution.

## Fastest Install

Install Gateway on a Linux server with Docker:

```bash
curl -sSL https://raw.githubusercontent.com/the-square-labs/gateway/main/scripts/install.sh | bash
```

> [!IMPORTANT]
> **Production deployment note:** Gateway is a privileged infrastructure control plane. For internal operations such as self-updates and local housekeeping, the Gateway app mounts the host Docker socket. Run Gateway in an isolated VM or dedicated host, and do not place unrelated workloads on the same Docker host.

The installer starts Gateway and prints a one-time setup code. The browser wizard then configures the canonical URL, selectable public and local node-network endpoints, one or more sign-in methods (OIDC, password, or email code), the first system administrator, optional structured logging, and optional AI Workspace. Gateway Inference is configured inside the AI Workspace flow rather than as a separate onboarding product.

Expose the ports that match your deployment:

| Port | Purpose |
|------|---------|
| `3000/tcp` | Gateway app UI/API port. For behind-NAT installs, expose this on the local network and point your external reverse proxy to it. |
| `443/tcp` | Optional public HTTPS endpoint supplied by your own reverse proxy. Gateway itself listens on `3000/tcp`. |
| `80/tcp` | HTTP and ACME HTTP-01 challenge, only if that challenge mode is used. |
| `9443/tcp` | Public relay-backed gRPC endpoint for managed daemon control and tunnel connections. The Gateway app's gRPC listener is internal. |

Behind NAT or an existing external reverse proxy, publish `3000/tcp` only on the local network and configure the external proxy to forward the public Gateway domain to the selected native HTTP or HTTPS transport on `<gateway-lan-ip>:3000`. Managed nodes still connect outbound to Gateway on `9443/tcp`; they do not need inbound management ports.

On a fresh interactive install, the only shell prompt selects native HTTPS or HTTP for port `3000`. All product configuration happens in the browser wizard; updates are non-interactive and preserve persisted settings.

For flags, non-interactive installs, custom SSL, OIDC details, updates, and node setup, read the [installation guide](docs/installation.md).

## Start Here

| Goal | Read |
|------|------|
| Understand what Gateway can manage | [Capabilities](docs/capabilities.md) |
| Install Gateway | [Installation guide](docs/installation.md) |
| Add nginx, Docker, database, or monitoring nodes | [Nodes and daemons](docs/nodes.md) |
| Export or import Docker containers with or without an embedded image | [GWCA container archives](docs/docker-container-archives.md) |
| Configure tokens, OAuth, MCP, logging, updates, and AI | [Operations guide](docs/operations.md) |
| Configure the multi-provider inference proxy | [Inference proxy](docs/inference.md) |
| Review the security model | [Security model](docs/security.md) |
| Understand license tiers and activation | [Licensing](docs/licensing.md) |
| Run the project locally or contribute | [Development guide](docs/development.md) |
| Review permission scopes | [SCOPES.md](SCOPES.md) |

## Product Tour

<table>
<tr>
<td align="center"><strong>Dashboard</strong></td>
<td align="center"><strong>Nginx Monitoring</strong></td>
</tr>
<tr>
<td><img src="docs/screenshots/dashboard.png" width="450" alt="Dashboard"></td>
<td><img src="docs/screenshots/nginx-monitoring.png" width="450" alt="Nginx Monitoring"></td>
</tr>
<tr>
<td align="center"><strong>Ingress Route Config</strong></td>
<td align="center"><strong>Settings</strong></td>
</tr>
<tr>
<td><img src="docs/screenshots/proxy-host.png" width="450" alt="Ingress Route Config"></td>
<td><img src="docs/screenshots/settings.png" width="450" alt="Settings"></td>
</tr>
</table>

## What Gateway Covers

| Area | Summary |
|------|---------|
| Ingress | Domains select a public nginx ingress node; routes forward traffic to addresses, Docker containers, deployments, or Pages Tags. Managed Additional Routes add path-prefix targets inside one route, while Additional Secure Link Bindings expose Docker upstreams to advanced nginx config. Includes maintenance mode, redirects, WebSockets, access lists, health checks, route folders, templates, logs, and stats. The REST API keeps `proxy-host` identifiers for compatibility. |
| Pages | Project-based static-site hosting with immutable Deployments, mutable Tags (including system-managed `latest`), custom Routes that target Tags, optional wildcard previews, no-store runtime configuration, per-project node placement, and migration. Available on Personal and higher; Business+ adds Git source builds on isolated Build Workers. Project/source metadata, build control, and publication are available through AI Workspace and MCP, while remote MCP clients can also upload artifacts through an authenticated resumable tool without passing credentials as arguments. |
| Docker | Container lifecycle, first-class single-node Compose Projects, Business+ direct Git repository/branch push-to-deploy for containers, blue/green deployments, and Compose projects, isolated Build Workers, a private-by-default Gateway-managed registry in every plan with optional Business+ external access, the Default (`runc`) runtime profile in every plan and the Secure (`runsc`/gVisor) profile in Business and Enterprise, Gateway-managed volumes, rollout/rollback, shared physical NVIDIA/AMD/Intel GPU attachment, eligible cross-node container and volume migrations, offline inventory snapshots, registries, images, networks, tasks, webhooks, logs, console, file browser, secrets, env vars, ports, and cleanup. Secure workloads cannot use GPU, migration, or export; GPU-attached workloads cannot migrate or export in v1. |
| Certificates | ACME SSL, uploaded certificates, internal root/intermediate CAs, certificate templates, CRLs, exports, and route binding. |
| Domains | Central hostname registry, nginx ingress placement, external or Cloudflare-managed DNS, validation, usage tracking, and explicit ingress migration. |
| Databases | Saved PostgreSQL, Redis, and ClickHouse connections with encrypted credentials, health history, browsing, scoped query consoles, and capability-aware write operations; private-by-default managed Postgres, Redis, and ClickHouse instances can bind securely to Docker workloads through the Console, AI Workspace, or MCP. |
| Monitoring | Node CPU, memory, disk, network, service status, capability-aware physical GPU telemetry, daemon runtime details, log streaming, and update checks. |
| Logging | Optional ClickHouse-backed structured log ingestion with schemas, retention, ingest tokens, rate limits, search, storage caps, and health safeguards. |
| Automation | API tokens, OAuth 2.0 PKCE, remote MCP endpoint with scoped Ingress, Pages, Databases, Docker/Compose, source-build, and Build Worker operations, readable internal Gateway documentation, CI/CD webhooks, webhook notifications, and status pages. |
| Integrations | GitLab project, repository, CI/CD, variable, webhook, registry, and sandbox workflows; GitHub repository and Actions workflows; generic Git connectors; external SSH connectors; and Cloudflare DNS/ACME automation. Connector credentials are encrypted and access is scope-gated. |
| Relay | A long-lived local relay owns public `9443/tcp` for daemon control and managed tunnel traffic. Relay Pool can add remote supervisor/worker pairs, explicit placement and rebalancing, draining, and rolling signed updates while preserving one logical Secure Link. |
| AI Workspace | Opt-in intent-driven operations with guided Scenarios, Plan Mode, permission-aware tools, approvals, sandboxed execution, progress tracking, and final verification. Planning never performs mutations before explicit confirmation. |
| Inference | Optional multi-provider model gateway with dedicated tokens, usage controls, capability-compatible cross-provider fallback before output begins, OpenAI- and Anthropic-compatible APIs, and managed Codex or Claude Code setup with optional user-session auto-start through `@sqgateway/inference`. |
| Administration | OIDC, password, email-code and passkey login, group-based and per-user additional permissions, scoped programmatic access, audit logs, setup state, updates, and license controls. |

## How It Works

Gateway runs as a Docker stack on the control-plane server. Managed hosts run small Go daemons that connect outbound to Gateway over gRPC with mTLS.

```text
                Gateway server
        +-----------------------------+
        | app + relay + redis         |
        | postgres local or remote    |
        | clickhouse local/remote/off |
        | relay gRPC :9443            |
        +-------------+---------------+
                      |
                outbound mTLS
                      |
        +-------------+-------------------+
        |             |                   |
 nginx-daemon   docker-daemon     database profile     monitoring-daemon
 ingress route  container host    managed databases    metrics-only host
```

The relay is a separate long-lived container and is the only public owner of `9443/tcp`. Ordinary app-only updates keep the relay container and established managed-database binding streams running; a relay update remains an explicit data-plane maintenance event.

Gateway can extend that local relay into one logical Relay Pool from **Settings > Relay**. Additional relay nodes are enrolled with a dedicated supervisor, keep management outbound-only to Gateway, and expose only their configured relay data endpoint (TCP `9443` by default) to participating managed hosts. Gateway does not open firewalls, provide NAT traversal, or create an overlay network. Adding a node does not move traffic until an administrator explicitly rebalances; new connections then spread across the workload's pre-verified active relay set while the UI continues to show one logical Secure Link.

Nodes do not need inbound management ports. Public traffic ports, such as `80` and `443` on nginx nodes, are still required for the services you expose.

## Security Model

Gateway is designed to be secure by default for a self-hosted infrastructure control plane:

- User login supports OIDC, password, email codes, and passkeys. Local authentication requires verified SMTP delivery, and group MFA policy is enforced after the primary credential.
- Managed nodes connect outbound to Gateway over gRPC with mTLS. First enrollment requires a one-time token plus the generated Gateway gRPC certificate fingerprint, and the daemon verifies the Gateway TLS leaf before sending the token. After enrollment, daemon commands require a client certificate issued by Gateway's internal node CA.
- Each node certificate is bound to a node identity. Gateway checks the mTLS certificate identity before accepting control streams, log streams, and certificate renewal requests.
- Nodes do not need inbound management ports. Losing Gateway access does not stop existing nginx configs or Docker containers; it only pauses centralized control.
- API tokens, OAuth grants, MCP access, database credentials, certificate exports, and secret reveal operations are scope-gated, bounded by the owning user's current permissions, and audited.
- Private key material and stored infrastructure credentials are encrypted at rest with the configured `PKI_MASTER_KEY`.

The result is a PKI-backed trust model: short-lived enrollment tokens get a node into the system only after the daemon confirms it is talking to the pinned Gateway certificate, and long-term trust is based on certificate identity rather than reusable shared secrets. This gives Gateway a strong default posture against token interception during setup and node hijacking after enrollment. Read the [security model](docs/security.md) for the full explanation and deployment hardening checklist.

## Roadmap

Gateway is already focused on production operations rather than a narrow MVP. The active direction is to make it safer, easier to operate, and more useful across medium and small infrastructure fleets.

Completed foundations:

- [x] Multi-node nginx ingress management with domain affinity, routes, and TLS deployment over outbound gRPC with mTLS.
- [x] Docker host management with deployments, webhooks, registries, logs, files, consoles, and secrets.
- [x] Monitoring daemon for host metrics, runtime state, and log streaming.
- [x] Internal PKI, ACME SSL, certificate templates, domain tracking, and expiry alerts.
- [x] PostgreSQL, Redis, and ClickHouse database explorer with encrypted saved credentials, plus private-by-default managed Postgres, Redis, and ClickHouse database nodes with secure application bindings.
- [x] Status pages, notifications, audit logs, RBAC, API tokens, OAuth PKCE, and remote MCP access.
- [x] SIEM audit export, enabled in Gateway settings, with encrypted bearer, HMAC-SHA256, or custom-header authentication.
- [x] Optional ClickHouse-backed structured logging and optional AI Workspace.
- [x] AI Workspace Scenarios and Plan Mode with validated plans, explicit execution confirmation, progress controls, and final verification.
- [x] Optional multi-provider inference gateway with OpenAI- and Anthropic-compatible APIs.
- [x] View-based, resource-scoped permission model with filtered list visibility.
- [x] Hardened OIDC/OAuth flows, setup lockout, fail-closed public endpoints, and signed update trust.
- [x] Gateway and daemon update workflows with signature-verified artifacts.
- [x] Settings workspace organized around preferences, gateway configuration, and feature controls.
- [x] Docker-to-nginx Secure Links.
- [x] First-class single-node Docker Compose Projects: Community discovery, inventory, monitoring, and logs; Personal-or-higher deployment and lifecycle management with immutable revisions, adoption, folders, drift reporting, and protected child resources.
- [x] Business+ Git push-to-deploy with isolated Build Workers, immutable internal-registry artifacts, vulnerability policy, and optional external registry access.

Planned work:

- [ ] Storage connections for S3, R2, MinIO, FTP, FTPS, SFTP, and SMB.
- [ ] Managed storages with Secure Links and managed-database backup/restore after the Storage foundation.
- [ ] Vulnerability and security scanning for Business and Enterprise.
- [ ] Horizontal application scaling for Business and Enterprise: group multiple Docker nodes into a cluster and deploy an application to that cluster. **In development.**
- [ ] Vertical workload scaling for Business and Enterprise: run multiple managed instances of one workload on the same machine. **In development.**
- [ ] Bastion and SSH management daemon for controlled host access.
- [ ] CLI for scriptable programmatic control from terminals and CI/CD jobs.
- [ ] Plugin system for extending Gateway with new integrations and operational modules.
- [ ] Broader operational documentation and examples for common deployment patterns.

## FAQ

<details>
<summary><strong>Is Gateway a Kubernetes replacement?</strong></summary>

No. Gateway is for direct infrastructure operations: nginx hosts, Docker hosts, certificates, domains, databases, logs, monitoring, and automation. It can live beside Kubernetes, but it does not try to be a Kubernetes control plane.
</details>

<details>
<summary><strong>Do nodes need inbound management ports?</strong></summary>

No. Daemons connect outbound to Gateway over gRPC with mTLS. Nginx nodes still need normal public traffic ports such as `80` and `443` if they serve public sites.
</details>

<details>
<summary><strong>Can Gateway manage an existing nginx host?</strong></summary>

Yes. Install the nginx daemon in `integrate` mode. Gateway keeps your existing `nginx.conf` and injects managed includes plus a local stats endpoint. See [nginx node modes](docs/nodes.md#nginx-node-modes).
</details>

<details>
<summary><strong>Can Gateway run without ClickHouse?</strong></summary>

Yes. Choose **Disabled** for structured logging in the first-run wizard or **Settings > Advanced**. The rest of Gateway continues to work. Managed local ClickHouse can be disabled without deleting its data volume.
</details>

<details>
<summary><strong>Can API or OAuth tokens expose secrets?</strong></summary>

Only when the owning user already has the required scopes. Sensitive OAuth scopes require explicit opt-in during consent, API/OAuth tokens cannot exceed the user's current effective permissions, and resource-scoped write-capable scopes stay bounded to the same resource when they imply read/view checks. See [SCOPES.md](SCOPES.md).
</details>

<details>
<summary><strong>How does Gateway prevent managed nodes from being hijacked?</strong></summary>

Gateway uses its own internal PKI for daemon identity. A node setup command includes a one-time enrollment token and the Gateway gRPC certificate fingerprint. The daemon verifies the presented Gateway TLS leaf certificate before it sends the token, receives an mTLS client certificate from Gateway's node CA, deletes the token from local config, and reconnects with the certificate. Gateway then verifies the certificate identity on control streams, log streams, and renewal requests. See the [security model](docs/security.md).
</details>

<details>
<summary><strong>What happens if Gateway is offline?</strong></summary>

Managed services keep running. Existing nginx configs continue serving traffic, Docker containers continue running, and daemons reconnect when Gateway returns. Centralized UI/API control is unavailable until the app is back.
</details>

<details>
<summary><strong>Is AI Workspace required?</strong></summary>

No. AI Workspace is optional. The Operations Console, REST API, OAuth, and MCP remain independently usable, and Gateway does not send data to an AI provider until an administrator enables AI Workspace and configures a provider. Operators can start from guided Scenarios or select Plan Mode for a validated, readable plan; no mutating action runs until the user explicitly confirms implementation.
</details>

## Plans And Licensing

Gateway has four product plans. Paid plans apply to one self-hosted installation and do not add per-node, per-user, or per-permission-group charges.

Community is for noncommercial use under the [PolyForm Strict License 1.0.0](LICENSE.md). A Personal, Business, or Enterprise key issued by Square Labs automatically grants the named licensee limited commercial-use rights for one official, unmodified installation under the [Commercial Key License](COMMERCIAL-LICENSE.md), including 30 calendar days after the key expires. Neither license permits modification or redistribution.

> [!NOTE]
> Pricing is preliminary, does not constitute an offer, and is subject to change. Confirm current pricing and terms before purchase.

| Plan | Monthly | Annual | Scale and focus |
|------|---------|--------|-----------------|
| ![Community](docs/assets/license/wiolett-gw-community-24.png)<br>Community | $0 | $0 | Noncommercial use of the core platform, AI Workspace, and Gateway Inference; up to 100 managed nodes, 10 users, and 5 custom permission groups; read-only Compose discovery, inventory, monitoring, and logs. Pages unavailable. |
| ![Personal](docs/assets/license/wiolett-gw-personal-24.png)<br>Personal | $29 | $290 | Commercial-use grant, unlimited managed-node/user/group plan quotas, Compose deployment and lifecycle management, container archive import/export, blue/green deployments, cross-node migration, managed databases, public status pages, Pages static-site hosting, and registry discovery. This does not include the in-development application-cluster features. |
| ![Business](docs/assets/license/wiolett-gw-business-24.png)<br>Business | $189 | $1,890 | Personal (including Compose management and Pages) plus Git push-to-deploy for containers, blue/green deployments, Compose Projects, and Pages with isolated Build Workers and build vulnerability policy, optional external access to the private internal registry, Docker Secure Runtime, structured logging, audit export, guided onboarding, security scanning when released, and the in-development application cluster and same-node multi-instance features. |
| ![Enterprise](docs/assets/license/wiolett-gw-enterprise-24.png)<br>Enterprise | On request | On request | Business (including Pages) plus Internal PKI, SIEM export, a dedicated technical contact, and assisted deployment and migration. |

See [Plans and licensing](docs/licensing.md) for the complete feature matrix, availability states, license verification, and source-license boundary.

After a paid key expires, technical entitlements remain active for 24 hours on Personal, 3 days on Business, or 7 days on Enterprise. This product grace is separate from both offline validation and the 30-day commercial-use grant described above.

Copyright (c) 2021-2026 [Square Labs](https://thesquarelabs.com)
