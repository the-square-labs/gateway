English | [Русский](README.ru.md) | [中文](README.cn.md)

# Gateway

Self-hosted infrastructure control plane for reverse proxies, Docker workloads, certificates, databases, logs, monitoring, status pages, and automation.

> [!NOTE]
> Primary development happens on [Wiolett Industries GitLab](https://gitlab.wiolett.net/wiolett/gateway). The [GitHub repository](https://github.com/wiolett-industries/gateway) is a public mirror. Issues and feature requests are welcome on [GitHub](https://github.com/wiolett-industries/gateway/issues).

## Why Gateway

Gateway gives small infrastructure teams one product for the daily work that usually lives across nginx configs, shell scripts, Docker hosts, certificate folders, database clients, dashboards, and alert tools.

Use it when you want to:

- Operate multiple proxy, Docker, and monitoring nodes without opening inbound management ports on those nodes.
- Give operators a focused UI and API for production tasks without giving them root shell access.
- Centralize TLS, internal PKI, ACME certificates, domains, status pages, notifications, and audit history.
- Manage Docker containers, deployments, logs, files, consoles, secrets, and registry workflows from one place.
- Expose controlled automation through API tokens, OAuth, CI/CD webhooks, and MCP clients.

## Fastest Install

Install Gateway on a Linux server with Docker:

```bash
curl -sSL https://gitlab.wiolett.net/wiolett/gateway/-/raw/main/scripts/install.sh | bash
```

> [!IMPORTANT]
> **Production deployment note:** Gateway is a privileged infrastructure control plane. For internal operations such as self-updates and local housekeeping, the Gateway app mounts the host Docker socket. Run Gateway in an isolated VM or dedicated host, and do not place unrelated workloads on the same Docker host.

> [!WARNING]
> **OIDC required:** For security reasons, Gateway currently supports only SSO login through an OpenID Connect provider. There is no built-in username/password authentication, so you need an OIDC provider configured before users can sign in.

Expose the ports that match your deployment:

| Port | Purpose |
|------|---------|
| `3000/tcp` | Gateway app UI/API port. For behind-NAT installs, expose this on the local network and point your external reverse proxy to it. |
| `443/tcp` | Public HTTPS UI/API access when Gateway's installer configures nginx alongside Gateway and sets up the domain. |
| `80/tcp` | HTTP and ACME HTTP-01 challenge, only if that challenge mode is used. |
| `9443/tcp` | gRPC control plane for managed daemon connections. |

Behind NAT or an existing external reverse proxy, publish `3000/tcp` only on the local network and configure the external proxy to forward the public Gateway domain to `http://<gateway-lan-ip>:3000`. If you let the installer configure nginx alongside Gateway for the Gateway domain, only `443/tcp` is required for UI/API access. Managed nodes still connect outbound to Gateway on `9443/tcp`; they do not need inbound management ports.

The installer asks for your domain, OIDC provider, PostgreSQL location, structured logging mode, SSL mode, resource profile, and log rotation settings. When it finishes, open Gateway, sign in, and add your first node.

For flags, non-interactive installs, custom SSL, OIDC details, updates, and node setup, read the [installation guide](docs/installation.md).

## Start Here

| Goal | Read |
|------|------|
| Understand what Gateway can manage | [Capabilities](docs/capabilities.md) |
| Install Gateway | [Installation guide](docs/installation.md) |
| Add nginx, Docker, or monitoring nodes | [Nodes and daemons](docs/nodes.md) |
| Configure tokens, OAuth, MCP, logging, updates, and AI | [Operations guide](docs/operations.md) |
| Configure the multi-provider inference proxy | [Inference proxy](docs/inference.md) |
| Review the security model | [Security model](docs/security.md) |
| Understand license tiers and activation | [Licensing](docs/licensing.md) |
| Run the project locally or contribute | [Development guide](docs/development.md) |
| Review permission scopes | [SCOPES.md](SCOPES.md) |

## Configure AI Harnesses

The [`@wiolett/gateway-inference`](packages/gateway-inference) companion configures supported AI harnesses without copying a Gateway inference token into their config files. Enable **Inference** under **Settings > Gateway settings > General settings**, then enable **Harness-specific endpoints** under **Settings > Inference** and run one of:

```bash
npx -y @wiolett/gateway-inference@latest setup codex
npx -y @wiolett/gateway-inference@latest setup claude-code
```

The CLI asks for the Gateway URL and completes OAuth when no active connection exists. Codex Desktop must also be signed in through Codex's normal OpenAI account flow and fully restarted after setup. Claude Code setup requires Claude Code 2.1.129 or newer and configures the CLI only, not Claude Desktop or the VS Code extension. See the [package README](packages/gateway-inference/README.md) and [inference guide](docs/inference.md) for the complete lifecycle and manual API setup.

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
<td align="center"><strong>Proxy Host Config</strong></td>
<td align="center"><strong>Settings</strong></td>
</tr>
<tr>
<td><img src="docs/screenshots/proxy-host.png" width="450" alt="Proxy Host Config"></td>
<td><img src="docs/screenshots/settings.png" width="450" alt="Settings"></td>
</tr>
</table>

## What Gateway Covers

| Area | Summary |
|------|---------|
| Reverse proxy | Multi-node nginx management, proxy hosts, Docker container/deployment upstreams, maintenance mode, redirects, WebSockets, access lists, health checks, host folders, templates, logs, and stats. |
| Docker | Container lifecycle, deployments, rollout/rollback, cross-node container and volume migrations, offline inventory snapshots, registries, images, networks, volumes, tasks, webhooks, logs, console, file browser, secrets, env vars, ports, mounts, and cleanup. |
| Certificates | ACME SSL, uploaded certificates, internal root/intermediate CAs, certificate templates, CRLs, exports, and proxy binding. |
| Domains | Central domain registry, DNS checks, record validation, and usage tracking. |
| Databases | Saved PostgreSQL and Redis connections, encrypted credentials, health history, schema/key browsing, query consoles, and write operations. |
| Monitoring | Node CPU, memory, disk, network, service status, daemon runtime details, log streaming, and update checks. |
| Logging | Optional ClickHouse-backed structured log ingestion with schemas, retention, ingest tokens, rate limits, search, storage caps, and health safeguards. |
| Automation | API tokens, OAuth 2.0 PKCE, remote MCP endpoint, CI/CD webhooks, webhook notifications, status pages, and optional AI assistant. |
| Inference | Optional multi-provider model gateway with dedicated tokens, usage controls, OpenAI-compatible APIs, and managed Codex or Claude Code setup through `@wiolett/gateway-inference`. |
| Administration | OIDC login, group-based and per-user additional permissions, scoped programmatic access, audit logs, setup state, updates, and license controls. |

## How It Works

Gateway runs as a Docker stack on the control-plane server. Managed hosts run small Go daemons that connect outbound to Gateway over gRPC with mTLS.

```text
                Gateway server
        +-----------------------------+
        | app + redis                 |
        | postgres local or remote    |
        | clickhouse local/remote/off |
        | gRPC :9443                  |
        +-------------+---------------+
                      |
                outbound mTLS
                      |
        +-------------+-------------------+
        |             |                   |
 nginx-daemon   docker-daemon     monitoring-daemon
 proxy host     container host    metrics-only host
```

Nodes do not need inbound management ports. Public traffic ports, such as `80` and `443` on nginx nodes, are still required for the services you expose.

## Security Model

Gateway is designed to be secure by default for a self-hosted infrastructure control plane:

- User login is SSO-only through OIDC, so password policy, MFA, device posture, and identity lifecycle stay with your identity provider.
- Managed nodes connect outbound to Gateway over gRPC with mTLS. First enrollment requires a one-time token plus the generated Gateway gRPC certificate fingerprint, and the daemon verifies the Gateway TLS leaf before sending the token. After enrollment, daemon commands require a client certificate issued by Gateway's internal node CA.
- Each node certificate is bound to a node identity. Gateway checks the mTLS certificate identity before accepting control streams, log streams, and certificate renewal requests.
- Nodes do not need inbound management ports. Losing Gateway access does not stop existing nginx configs or Docker containers; it only pauses centralized control.
- API tokens, OAuth grants, MCP access, database credentials, certificate exports, and secret reveal operations are scope-gated, bounded by the owning user's current permissions, and audited.
- Private key material and stored infrastructure credentials are encrypted at rest with the configured `PKI_MASTER_KEY`.

The result is a PKI-backed trust model: short-lived enrollment tokens get a node into the system only after the daemon confirms it is talking to the pinned Gateway certificate, and long-term trust is based on certificate identity rather than reusable shared secrets. This gives Gateway a strong default posture against token interception during setup and node hijacking after enrollment. Read the [security model](docs/security.md) for the full explanation and deployment hardening checklist.

## Roadmap

Gateway is already focused on production operations rather than a narrow MVP. The active direction is to make it safer, easier to operate, and more useful across medium and small infrastructure fleets.

Completed foundations:

- [x] Multi-node nginx reverse proxy management over outbound gRPC with mTLS.
- [x] Docker host management with deployments, webhooks, registries, logs, files, consoles, and secrets.
- [x] Monitoring daemon for host metrics, runtime state, and log streaming.
- [x] Internal PKI, ACME SSL, certificate templates, domain tracking, and expiry alerts.
- [x] PostgreSQL and Redis database explorer with encrypted saved credentials.
- [x] Status pages, notifications, audit logs, RBAC, API tokens, OAuth PKCE, and remote MCP access.
- [x] Optional ClickHouse-backed structured logging and optional AI assistant.
- [x] Optional multi-provider inference gateway with OpenAI-compatible and harness-specific APIs.
- [x] View-based, resource-scoped permission model with filtered list visibility.
- [x] Hardened OIDC/OAuth flows, setup lockout, fail-closed public endpoints, and signed update trust.
- [x] Gateway and daemon update workflows with signature-verified artifacts.
- [x] Settings workspace organized around preferences, gateway configuration, and feature controls.

Planned work:

- [ ] Bastion and SSH management daemon for controlled host access.
- [ ] CLI for scriptable programmatic control from terminals and CI/CD jobs.
- [ ] Plugin system for extending Gateway with new integrations and operational modules.
- [ ] Per-user AI assistant quotas and richer usage reporting.
- [ ] Local username/password authentication as an OIDC alternative.
- [ ] More guided onboarding for first-time installs and first-node setup.
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

Yes. If `CLICKHOUSE_URL` is empty, the structured logging UI and ingest API are disabled. The rest of Gateway continues to work.
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
<summary><strong>Is the AI assistant required?</strong></summary>

No. It is optional and disabled by default. Gateway does not send data to an AI provider until an admin enables the assistant and configures a provider.
</details>

## License

Gateway uses source-available licensing plus optional product license keys. Current license tiers are informational in the app and do not gate features yet.

| Tier | Who it is for | Key | Current behavior |
|------|---------------|-----|------------------|
| ![Community](docs/assets/license/wiolett-gw-community-24.png)<br>Community | Personal use, noncommercial use, and permitted source-license use under [LICENSE.md](LICENSE.md). | Not required. | Full product access today. |
| ![Homelab](docs/assets/license/wiolett-gw-homelab-24.png)<br>Homelab | Homelab operators and eligible small businesses under $100K revenue and fewer than 10 people. | Free renewable key by request. | Full product access today; planned Homelab-and-up perks include Status Pages, PKI, and Logging. |
| ![Enterprise](docs/assets/license/wiolett-gw-enterprise-24.png)<br>Enterprise | Organizations above the small-business threshold or teams that want a paid commercial license. | $290/year. | Full product access today; planned Enterprise tier remains the paid commercial/support path. |

Homelab keys are available by contacting [contact@wiolett.net](mailto:contact@wiolett.net) or [Wiolett Industries on Telegram](https://t.me/WiolettIndustries). See [Licensing](docs/licensing.md) for license verification, future tier perks, and renewal details.

Copyright (c) 2021-2026 [Wiolett Industries](https://wiolett.net)
