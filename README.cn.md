[English](README.md) | [Русский](README.ru.md) | 中文

# Gateway

自托管基础设施控制平面，用于反向代理、Docker 工作负载、证书、数据库、日志、监控、状态页和自动化。

> [!NOTE]
> 主要开发在 [Wiolett Industries GitLab](https://gitlab.wiolett.net/wiolett/gateway) 进行。[GitHub 仓库](https://github.com/wiolett-industries/gateway) 是公开镜像。Issues 和功能请求可以提交到 [GitHub](https://github.com/wiolett-industries/gateway/issues)。

## 为什么需要 Gateway

Gateway 为小型基础设施团队提供一个产品，用来处理日常工作中通常分散在 nginx 配置、shell 脚本、Docker 主机、证书目录、数据库客户端、仪表盘和告警工具里的任务。

当你希望做到以下事情时，可以使用 Gateway：

- 管理多个 proxy、Docker 和 monitoring 节点，而不需要在这些节点上开放入站 management 端口。
- 给运维人员一个聚焦的 UI 和 API 来处理 production 任务，而不需要给他们 root shell access。
- 集中管理 TLS、内部 PKI、ACME 证书、域名、状态页、通知和审计历史。
- 在一个地方管理 Docker containers、deployments、logs、files、consoles、secrets 和 registry workflows。
- 通过 API tokens、OAuth、CI/CD webhooks 和 MCP clients 提供受控自动化。

## 最快安装

在带 Docker 的 Linux 服务器上安装 Gateway：

```bash
curl -sSL https://gitlab.wiolett.net/wiolett/gateway/-/raw/main/scripts/install.sh | bash
```

> [!IMPORTANT]
> **Production 部署说明：** Gateway 是一个高权限的基础设施控制平面。为了执行 self-updates 和本地维护等内部操作，Gateway app 会挂载宿主机 Docker socket。请在隔离 VM 或专用主机上运行 Gateway，不要在同一 Docker 主机上放置无关 workloads。

> [!WARNING]
> **必须使用 OIDC：** 出于安全原因，Gateway 目前只支持通过 OpenID Connect provider 进行 SSO 登录。没有内置 username/password authentication，因此用户登录前需要先配置 OIDC provider。

根据你的部署方式开放对应端口：

| 端口 | 用途 |
|------|------|
| `3000/tcp` | Gateway app UI/API 端口。对于 behind-NAT installs，请只在本地网络开放，并让外部 reverse proxy 指向它。 |
| `443/tcp` | 当 Gateway installer 在 Gateway 旁配置 nginx 并设置域名时，用于公开 HTTPS UI/API 访问。 |
| `80/tcp` | HTTP 和 ACME HTTP-01 challenge，仅在使用该 challenge mode 时需要。 |
| `9443/tcp` | managed daemon connections 使用的 gRPC control plane。 |

在 NAT 或已有外部 reverse proxy 后面时，只在本地网络发布 `3000/tcp`，并配置外部 proxy 将 Gateway 公共域名转发到 `http://<gateway-lan-ip>:3000`。如果让 Gateway installer 为 Gateway 域名配置同机 nginx，那么 UI/API 访问只需要 `443/tcp`。Managed nodes 仍会 outbound 连接 Gateway 的 `9443/tcp`；它们不需要入站 management ports。

安装器会询问 domain、OIDC provider、SSL mode、resource profile 和 log rotation 设置。完成后，打开 Gateway，登录并添加第一个节点。

关于 flags、non-interactive installs、custom SSL、OIDC details、updates 和 node setup，请阅读 [installation guide](docs/installation.md)。

## 从这里开始

| 目标 | 阅读 |
|------|------|
| 了解 Gateway 可以管理什么 | [Capabilities](docs/capabilities.md) |
| 安装 Gateway | [Installation guide](docs/installation.md) |
| 添加 nginx、Docker 或 monitoring 节点 | [Nodes and daemons](docs/nodes.md) |
| 配置 tokens、OAuth、MCP、logging、updates 和 AI | [Operations guide](docs/operations.md) |
| 配置 multi-provider inference proxy | [Inference proxy](docs/inference.md) |
| 查看 security model | [Security model](docs/security.md) |
| 了解 license tiers 和 activation | [Licensing](docs/licensing.md) |
| 本地运行项目或参与贡献 | [Development guide](docs/development.md) |
| 查看 permission scopes | [SCOPES.md](SCOPES.md) |

## 配置 AI Harnesses

[`@wiolett/gateway-inference`](packages/gateway-inference) companion 可以配置受支持的 AI harnesses，而不会把 Gateway inference token 写入它们的配置文件。先在 **Settings > Gateway settings > General settings** 中启用 **Inference**，再在 **Settings > Inference** 中启用 **Harness-specific endpoints**，然后运行：

```bash
npx -y @wiolett/gateway-inference@latest setup codex
npx -y @wiolett/gateway-inference@latest setup claude-code
```

如果没有活动连接，CLI 会询问 Gateway URL 并完成 OAuth。Codex Desktop 还必须通过 Codex 的正常流程登录 OpenAI account，并在配置后完全退出并重新打开。Claude Code 需要 2.1.129 或更高版本；这里只配置 CLI，不配置 Claude Desktop 或 VS Code extension。完整 lifecycle 和手动 API 配置请参见[包 README](packages/gateway-inference/README.md)和 [inference guide](docs/inference.md)。

## 产品导览

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

## Gateway 覆盖范围

| 领域 | 摘要 |
|------|------|
| Reverse proxy | Multi-node nginx management, proxy hosts, Docker container/deployment upstreams, maintenance mode, redirects, WebSockets, access lists, health checks, host folders, templates, logs 和 stats。 |
| Docker | Container lifecycle, deployments, rollout/rollback, cross-node container 和 volume migrations, offline inventory snapshots, registries, images, networks, volumes, tasks, webhooks, logs, console, file browser, secrets, env vars, ports, mounts 和 cleanup。 |
| Certificates | ACME SSL, uploaded certificates, internal root/intermediate CAs, certificate templates, CRLs, exports 和 proxy binding。 |
| Domains | Central domain registry, DNS checks, record validation 和 usage tracking。 |
| Databases | Saved PostgreSQL 和 Redis connections, encrypted credentials, health history, schema/key browsing, query consoles 和 write operations。 |
| Monitoring | Node CPU, memory, disk, network, service status, daemon runtime details, log streaming 和 update checks。 |
| Logging | 可选的 ClickHouse-backed structured log ingestion，包含 schemas、retention、ingest tokens、rate limits 和 search。 |
| Automation | API tokens, OAuth 2.0 PKCE, remote MCP endpoint, CI/CD webhooks, webhook notifications, status pages 和 optional AI assistant。 |
| Inference | 可选的 multi-provider model gateway，包含独立 tokens、usage controls、OpenAI-compatible APIs，以及通过 `@wiolett/gateway-inference` 管理的 Codex 或 Claude Code 配置。 |
| Administration | OIDC login, group-based 和 per-user additional permissions, scoped programmatic access, audit logs, setup state, updates 和 license controls。 |

## 工作方式

Gateway 作为 Docker stack 运行在 control-plane server 上。Managed hosts 运行小型 Go daemons，它们通过 outbound gRPC 和 mTLS 连接到 Gateway。

```text
                Gateway server
        +-----------------------------+
        | app + postgres + redis      |
        | optional clickhouse         |
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

节点不需要入站 management 端口。你对外提供服务时仍然需要 public traffic ports，例如 nginx nodes 上的 `80` 和 `443`。

## Security Model

Gateway 的设计目标是让自托管基础设施控制平面默认更安全：

- 用户登录只通过 OIDC SSO，因此 password policy、MFA、device posture 和 identity lifecycle 都留在你的 identity provider 中。
- Managed nodes 通过 gRPC 和 mTLS outbound 连接 Gateway。首次 enrollment 需要一次性 token 和生成的 Gateway gRPC certificate fingerprint，daemon 会在发送 token 前验证 Gateway TLS leaf。Enrollment 完成后，daemon commands 需要由 Gateway internal node CA 签发的 client certificate。
- 每个 node certificate 都绑定到一个 node identity。Gateway 在接受 control streams、log streams 和 certificate renewal requests 前会检查 mTLS certificate identity。
- 节点不需要入站 management 端口。失去 Gateway 访问不会停止现有 nginx configs 或 Docker containers；它只会暂停 centralized control。
- API tokens、OAuth grants、MCP access、database credentials、certificate exports 和 secret reveal operations 都受 scope 限制，不能超过拥有者当前 permissions，并且会被审计。
- Private key material 和保存的 infrastructure credentials 使用配置的 `PKI_MASTER_KEY` 进行 at rest 加密。

最终形成的是 PKI-backed trust model：short-lived enrollment tokens 只有在 daemon 确认自己正在与 pinned Gateway certificate 通信后才会让节点进入系统，长期信任则基于 certificate identity，而不是 reusable shared secrets。这让 Gateway 对 setup 期间的 token interception 和 enrollment 后的 node hijacking 都具备更强的默认防护。完整说明和 hardening checklist 见 [security model](docs/security.md)。

## Roadmap

Gateway 已经面向 production operations，而不是狭窄的 MVP。当前方向是让它对中小型 infrastructure fleets 更安全、更容易运维、更有用。

已完成的基础：

- [x] Multi-node nginx reverse proxy management over outbound gRPC with mTLS.
- [x] Docker host management with deployments, webhooks, registries, logs, files, consoles, and secrets.
- [x] Monitoring daemon for host metrics, runtime state, and log streaming.
- [x] Internal PKI, ACME SSL, certificate templates, domain tracking, and expiry alerts.
- [x] PostgreSQL and Redis database explorer with encrypted saved credentials.
- [x] Status pages, notifications, audit logs, RBAC, API tokens, OAuth PKCE, and remote MCP access.
- [x] Optional ClickHouse-backed structured logging and optional AI assistant.
- [x] 可选的 multi-provider inference gateway，提供 OpenAI-compatible 和 harness-specific APIs。
- [x] View-based, resource-scoped permission model with filtered list visibility.
- [x] Hardened OIDC/OAuth flows, setup lockout, fail-closed public endpoints, and signed update trust.
- [x] Gateway and daemon update workflows with signature-verified artifacts.
- [x] Settings workspace organized around preferences, gateway configuration, and feature controls.

计划中的工作：

- [ ] Bastion and SSH management daemon for controlled host access.
- [ ] CLI for scriptable programmatic control from terminals and CI/CD jobs.
- [ ] Plugin system for extending Gateway with new integrations and operational modules.
- [ ] Per-user AI assistant quotas and richer usage reporting.
- [ ] Local username/password authentication as an OIDC alternative.
- [ ] More guided onboarding for first-time installs and first-node setup.
- [ ] Broader operational documentation and examples for common deployment patterns.

## FAQ

<details>
<summary><strong>Gateway 是 Kubernetes 的替代品吗？</strong></summary>

不是。Gateway 面向直接的基础设施操作：nginx hosts、Docker hosts、certificates、domains、databases、logs、monitoring 和 automation。它可以与 Kubernetes 并存，但并不试图成为 Kubernetes control plane。
</details>

<details>
<summary><strong>节点需要入站 management 端口吗？</strong></summary>

不需要。Daemons 通过 outbound gRPC 和 mTLS 连接到 Gateway。如果 nginx nodes 提供公开站点，它们仍然需要普通的 public traffic ports，例如 `80` 和 `443`。
</details>

<details>
<summary><strong>Gateway 可以管理现有 nginx host 吗？</strong></summary>

可以。以 `integrate` 模式安装 nginx daemon。Gateway 会保留现有 `nginx.conf`，并注入 managed includes 和本地 stats endpoint。参见 [nginx node modes](docs/nodes.md#nginx-node-modes)。
</details>

<details>
<summary><strong>Gateway 可以不使用 ClickHouse 吗？</strong></summary>

可以。如果 `CLICKHOUSE_URL` 为空，structured logging UI 和 ingest API 会被禁用。Gateway 的其他部分会继续工作。
</details>

<details>
<summary><strong>API 或 OAuth tokens 会暴露 secrets 吗？</strong></summary>

只有当拥有者已经具备所需 scopes 时才可以。Sensitive OAuth scopes 在 consent 时需要显式 opt-in，API/OAuth tokens 不能超过用户当前的 effective permissions，并且 resource-scoped write-capable scopes 在隐含 read/view checks 时仍然限制在同一 resource 内。参见 [SCOPES.md](SCOPES.md)。
</details>

<details>
<summary><strong>Gateway 如何防止 managed nodes 被劫持？</strong></summary>

Gateway 使用自己的 internal PKI 作为 daemon identity。节点 setup command 包含 one-time enrollment token 和 Gateway gRPC certificate fingerprint。Daemon 会在发送 token 前验证 Gateway TLS leaf certificate，然后从 Gateway node CA 接收 mTLS client certificate，从本地 config 删除 token，并使用 certificate 重新连接。随后 Gateway 会在 control streams、log streams 和 renewal requests 上验证 certificate identity。参见 [security model](docs/security.md)。
</details>

<details>
<summary><strong>如果 Gateway offline 会怎样？</strong></summary>

Managed services 会继续运行。Existing nginx configs 会继续服务 traffic，Docker containers 会继续运行，daemons 会在 Gateway 恢复后重新连接。在应用恢复前，centralized UI/API control 不可用。
</details>

<details>
<summary><strong>AI assistant 是必须的吗？</strong></summary>

不是。它是可选功能，默认关闭。只有 admin 启用 assistant 并配置 provider 后，Gateway 才会向 AI provider 发送数据。
</details>

## License

Gateway 使用 source-available licensing 和可选 product license keys。当前 license tiers 只在应用中显示信息，暂时不会限制 features。

| Tier | 适用对象 | Key | 当前行为 |
|------|----------|-----|----------|
| ![Community](docs/assets/license/wiolett-gw-community-24.png)<br>Community | Personal use, noncommercial use, and permitted source-license use under [LICENSE.md](LICENSE.md). | 不需要。 | Full product access today. |
| ![Homelab](docs/assets/license/wiolett-gw-homelab-24.png)<br>Homelab | Homelab operators and eligible small businesses under $100K revenue and fewer than 10 people. | Free renewable key by request. | Full product access today; planned Homelab-and-up perks include Status Pages, PKI, and Logging. |
| ![Enterprise](docs/assets/license/wiolett-gw-enterprise-24.png)<br>Enterprise | Organizations above the small-business threshold or teams that want a paid commercial license. | $290/year. | Full product access today; planned Enterprise tier remains the paid commercial/support path. |

Homelab keys 可通过 [contact@wiolett.net](mailto:contact@wiolett.net) 或 [Wiolett Industries on Telegram](https://t.me/WiolettIndustries) 申请。关于 license verification、future tier perks 和 renewal details，请参见 [Licensing](docs/licensing.md)。

Copyright (c) 2021-2026 [Wiolett Industries](https://wiolett.net)
