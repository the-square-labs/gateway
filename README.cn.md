[English](README.md) | [Русский](README.ru.md) | 中文

# Gateway

AI-first 但不依赖 AI 的自托管基础设施控制平面，用于 nginx ingress、Docker 工作负载、证书、数据库、日志、监控、状态页和自动化。

> [!NOTE]
> 主要开发在 [GitHub](https://github.com/the-square-labs/gateway) 进行。Issues 和功能请求可以提交到 [GitHub issue tracker](https://github.com/the-square-labs/gateway/issues)。

## 为什么需要 Gateway

Gateway 为小型基础设施团队提供一个产品，用来处理日常工作中通常分散在 nginx 配置、shell 脚本、Docker 主机、证书目录、数据库客户端、仪表盘和告警工具里的任务。

AI Workspace 是推荐的 intent-driven 界面：从完整 Scenario 开始或描述期望结果，查看建议计划，然后决定是否执行。Operations Console 仍然是管理同一基础设施的完整独立界面，因此 Gateway 的安装、运维、自动化和恢复都不依赖 AI。

当你希望做到以下事情时，可以使用 Gateway：

- 管理多个 proxy、Docker 和 monitoring 节点，而不需要在这些节点上开放入站 management 端口。
- 给运维人员一个聚焦的 UI 和 API 来处理 production 任务，而不需要给他们 root shell access。
- 集中管理 TLS、内部 PKI、ACME 证书、域名、状态页、通知和审计历史。
- 在一个地方管理 Docker containers、deployments、portable 或 registry-backed `.gwca` archives、logs、files、consoles、secrets 和 registry workflows。
- 通过 API tokens、OAuth、CI/CD webhooks 和 MCP clients 提供受控自动化。
- 从 AI Workspace Scenario 开始，或使用 Plan Mode 在明确确认执行之前研究并验证多步骤变更。

## 最快安装

在带 Docker 的 Linux 服务器上安装 Gateway：

```bash
curl -sSL https://raw.githubusercontent.com/the-square-labs/gateway/main/scripts/install.sh | bash
```

> [!IMPORTANT]
> **Production 部署说明：** Gateway 是一个高权限的基础设施控制平面。为了执行 self-updates 和本地维护等内部操作，Gateway app 会挂载宿主机 Docker socket。请在隔离 VM 或专用主机上运行 Gateway，不要在同一 Docker 主机上放置无关 workloads。

安装器会启动 Gateway 并输出一次性设置代码。随后浏览器向导会配置规范 URL、可选择的节点 public/local network endpoints、一个或多个登录方式（OIDC、密码或 email code）、首个系统管理员、可选的 structured logging 和可选的 AI Workspace。Gateway Inference 在 AI Workspace 流程内配置，而不是作为单独的 onboarding 产品。

根据你的部署方式开放对应端口：

| 端口 | 用途 |
|------|------|
| `3000/tcp` | Gateway app UI/API 端口。对于 behind-NAT installs，请只在本地网络开放，并让外部 reverse proxy 指向它。 |
| `443/tcp` | 由你自己的 reverse proxy 提供的可选 public HTTPS endpoint。Gateway 本身监听 `3000/tcp`。 |
| `80/tcp` | HTTP 和 ACME HTTP-01 challenge，仅在使用该 challenge mode 时需要。 |
| `9443/tcp` | managed daemon control 与 tunnel connections 使用的公开 relay-backed gRPC endpoint。Gateway app 的 gRPC listener 仅在内部使用。 |

在 NAT 或已有外部 reverse proxy 后面时，只在本地网络发布 `3000/tcp`，并配置外部 proxy 将 Gateway 公共域名转发到选定的 HTTP 或 HTTPS transport（`<gateway-lan-ip>:3000`）。Managed nodes 仍会 outbound 连接 Gateway 的 `9443/tcp`；它们不需要入站 management ports。

新的交互式安装在 shell 中只询问一个问题：端口 `3000` 使用 native HTTPS 还是 HTTP。所有产品配置都在 browser wizard 中完成；更新是非交互式的，并保留现有设置。

关于 flags、non-interactive installs、custom SSL、OIDC details、updates 和 node setup，请阅读 [installation guide](docs/installation.md)。

## 从这里开始

| 目标 | 阅读 |
|------|------|
| 了解 Gateway 可以管理什么 | [Capabilities](docs/capabilities.md) |
| 安装 Gateway | [Installation guide](docs/installation.md) |
| 添加 nginx、Docker、database 或 monitoring 节点 | [Nodes and daemons](docs/nodes.md) |
| 导出或导入包含或不包含内嵌 image 的 Docker containers | [GWCA container archives](docs/docker-container-archives.md) |
| 配置 tokens、OAuth、MCP、logging、updates 和 AI | [Operations guide](docs/operations.md) |
| 配置 multi-provider inference proxy | [Inference proxy](docs/inference.md) |
| 查看 security model | [Security model](docs/security.md) |
| 了解 license tiers 和 activation | [Licensing](docs/licensing.md) |
| 本地运行项目或参与贡献 | [Development guide](docs/development.md) |
| 查看 permission scopes | [SCOPES.md](SCOPES.md) |

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
<td align="center"><strong>Ingress Route Config</strong></td>
<td align="center"><strong>Settings</strong></td>
</tr>
<tr>
<td><img src="docs/screenshots/proxy-host.png" width="450" alt="Ingress Route Config"></td>
<td><img src="docs/screenshots/settings.png" width="450" alt="Settings"></td>
</tr>
</table>

## Gateway 覆盖范围

| 领域 | 摘要 |
|------|------|
| Ingress | Domain 选择 public nginx ingress node；route 将流量转发到 address、Docker container、deployment 或 Pages Tag。Managed Additional Routes 可在同一 route 内添加 path-prefix targets，Additional Secure Link Bindings 则让 advanced nginx config 使用 Docker upstreams。还包括 maintenance mode、redirects、WebSockets、access lists、health checks、route folders、templates、logs 和 stats。REST API 为兼容性保留 `proxy-host` identifiers。 |
| Pages | 基于项目的静态站点托管，支持不可变 Deployments、可变 Tags（包括系统管理的 `latest`）、指向 Tags 的自定义 Routes、可选 wildcard previews、no-store runtime configuration、per-project node placement 和 migration。Personal 及以上计划可用；Business+ 增加在隔离 Build Workers 上运行的 Git source builds。项目/源 metadata、build control 与 publication 可通过 AI Workspace 和 MCP 管理，remote MCP clients 还可通过 authenticated resumable tool 上传 artifacts，无需在参数中传递 credentials。 |
| Docker | Container lifecycle、first-class single-node Compose Projects、Business+ 可用的面向 container、blue/green deployment 和 Compose project 的直接 Git repository/branch push-to-deploy、隔离的 Build Worker、所有计划均可使用的默认私有 Gateway-managed internal registry（Business+ 可选 external access）、所有计划均可使用的 Default (`runc`) runtime profile，以及 Business 和 Enterprise 可使用的 Secure (`runsc`/gVisor) profile、Gateway-managed volumes、rollout/rollback、shared physical NVIDIA/AMD/Intel GPU attachment、eligible cross-node container 和 volume migrations、offline inventory snapshots、registries、images、networks、tasks、webhooks、logs、console、file browser、secrets、env vars、ports 和 cleanup。Secure workloads 不支持 GPU、migration 或 export；GPU-attached workloads 在 v1 中也不能迁移或导出。 |
| Certificates | ACME SSL, uploaded certificates, internal root/intermediate CAs, certificate templates, CRLs, exports 和 route binding。 |
| Domains | Central hostname registry、nginx ingress placement、external 或 Cloudflare-managed DNS、validation、usage tracking 和 explicit ingress migration。 |
| Databases | Saved PostgreSQL、Redis 和 ClickHouse connections，含 encrypted credentials、health history、browsing、scoped query consoles 和 capability-aware write operations；private-by-default managed Postgres、Redis 和 ClickHouse instances 可通过 Console、AI Workspace 或 MCP 安全绑定到 Docker workloads。 |
| Monitoring | Node CPU, memory, disk, network, service status, capability-aware physical GPU telemetry, daemon runtime details, log streaming 和 update checks。 |
| Logging | 可选的 ClickHouse-backed structured log ingestion，包含 schemas、retention、ingest tokens、rate limits、search、storage caps 和 health safeguards。 |
| Automation | API tokens、OAuth 2.0 PKCE、提供 Ingress、Pages、Databases、Docker/Compose、source build 与 Build Worker scoped operations 及 internal Gateway documentation 读取能力的 remote MCP endpoint、CI/CD webhooks、webhook notifications 和 status pages。 |
| Integrations | GitLab project、repository、CI/CD、variable、webhook、registry 和 sandbox workflows；GitHub repository 与 Actions workflows；generic Git connectors；external SSH connectors；以及 Cloudflare DNS/ACME automation。Connector credentials 会加密保存，访问受 scopes 限制。 |
| Relay | Long-lived local relay 负责公开 `9443/tcp` 上的 daemon control 与 managed tunnel traffic。Relay Pool 可增加 remote supervisor/worker pairs、显式 placement/rebalancing、drain 与 rolling signed updates，同时保持一个逻辑 Secure Link。 |
| AI Workspace | 可选的 intent-driven operations，包含引导式 Scenarios、Plan Mode、permission-aware tools、approvals、sandboxed execution、进度跟踪和最终验证。在明确确认之前，规划不会执行任何变更。 |
| Inference | 可选的 multi-provider model gateway，包含独立 tokens、usage controls、仅在 output 开始前进行的 capability-compatible cross-provider fallback、OpenAI/Anthropic-compatible APIs，以及通过 `@sqgateway/inference` 管理且可选 user-session auto-start 的 Codex 或 Claude Code 配置。 |
| Administration | OIDC、password、email-code 和 passkey login，group-based 和 per-user additional permissions, scoped programmatic access, audit logs, setup state, updates 和 license controls。 |

## 工作方式

Gateway 作为 Docker stack 运行在 control-plane server 上。Managed hosts 运行小型 Go daemons，它们通过 outbound gRPC 和 mTLS 连接到 Gateway。

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

Relay 是一个独立的 long-lived container，也是 `9443/tcp` 唯一的公开监听方。普通 app-only 更新会保留 relay container 和已建立的 managed-database binding streams；更新 relay 仍然是一个单独的 data-plane maintenance event。

可以在 **Settings > Relay** 中把本地 relay 扩展为一个逻辑 Relay Pool。额外的 relay 节点由专用 supervisor 管理，控制连接仍然只需 outbound 到 Gateway，并且只向参与的 managed hosts 暴露配置的 relay data endpoint（默认 TCP `9443`）。Gateway 不修改 firewall、不提供 NAT traversal，也不创建 overlay network。添加节点不会自动迁移流量；管理员明确执行 Rebalance 后，新连接会分散到 workload 预先验证的 active relay 集合中，而用户仍然看到一个逻辑 Secure Link。

节点不需要入站 management 端口。你对外提供服务时仍然需要 public traffic ports，例如 nginx nodes 上的 `80` 和 `443`。

## Security Model

Gateway 的设计目标是让自托管基础设施控制平面默认更安全：

- 用户登录支持 OIDC、password、email code 和 passkeys。Local authentication 需要已验证的 SMTP delivery，group MFA policy 会在 primary credential 后生效。
- Managed nodes 通过 gRPC 和 mTLS outbound 连接 Gateway。首次 enrollment 需要一次性 token 和生成的 Gateway gRPC certificate fingerprint，daemon 会在发送 token 前验证 Gateway TLS leaf。Enrollment 完成后，daemon commands 需要由 Gateway internal node CA 签发的 client certificate。
- 每个 node certificate 都绑定到一个 node identity。Gateway 在接受 control streams、log streams 和 certificate renewal requests 前会检查 mTLS certificate identity。
- 节点不需要入站 management 端口。失去 Gateway 访问不会停止现有 nginx configs 或 Docker containers；它只会暂停 centralized control。
- API tokens、OAuth grants、MCP access、database credentials、certificate exports 和 secret reveal operations 都受 scope 限制，不能超过拥有者当前 permissions，并且会被审计。
- Private key material 和保存的 infrastructure credentials 使用配置的 `PKI_MASTER_KEY` 进行 at rest 加密。

最终形成的是 PKI-backed trust model：short-lived enrollment tokens 只有在 daemon 确认自己正在与 pinned Gateway certificate 通信后才会让节点进入系统，长期信任则基于 certificate identity，而不是 reusable shared secrets。这让 Gateway 对 setup 期间的 token interception 和 enrollment 后的 node hijacking 都具备更强的默认防护。完整说明和 hardening checklist 见 [security model](docs/security.md)。

## Roadmap

Gateway 已经面向 production operations，而不是狭窄的 MVP。当前方向是让它对中小型 infrastructure fleets 更安全、更容易运维、更有用。

已完成的基础：

- [x] Multi-node nginx ingress management，包含 domain affinity、routes 和 TLS deployment over outbound gRPC with mTLS。
- [x] Docker host management with deployments, webhooks, registries, logs, files, consoles, and secrets.
- [x] Monitoring daemon for host metrics, runtime state, and log streaming.
- [x] Internal PKI, ACME SSL, certificate templates, domain tracking, and expiry alerts.
- [x] PostgreSQL、Redis 和 ClickHouse database explorer with encrypted saved credentials，以及 private-by-default managed Postgres、Redis 和 ClickHouse database nodes with secure application bindings。
- [x] Status pages, notifications, audit logs, RBAC, API tokens, OAuth PKCE, and remote MCP access.
- [x] 可在 Gateway 设置中启用的 SIEM 审计导出，支持加密 Bearer、HMAC-SHA256 或自定义请求头认证。
- [x] 可选的 ClickHouse-backed structured logging 和可选的 AI Workspace。
- [x] AI Workspace Scenarios 和 Plan Mode，包含已验证计划、明确的执行确认、进度控制和最终验证。
- [x] 可选的 multi-provider inference gateway，提供 OpenAI-compatible 和 harness-specific APIs。
- [x] View-based, resource-scoped permission model with filtered list visibility.
- [x] Hardened OIDC/OAuth flows, setup lockout, fail-closed public endpoints, and signed update trust.
- [x] Gateway and daemon update workflows with signature-verified artifacts.
- [x] Settings workspace organized around preferences, gateway configuration, and feature controls.
- [x] Docker-to-nginx Secure Links。
- [x] 单节点 first-class Compose Projects：Community 提供外部项目发现、inventory、monitoring 和 logs；Personal 及以上提供 deployment 与 lifecycle management，包括不可变修订、adoption、folders、drift 与子资源保护。
- [x] Business+ Git push-to-deploy，包含隔离的 Build Workers、internal registry immutable artifacts、vulnerability policy 和可选 external registry access。

计划中的工作：

- [ ] S3、R2、MinIO、FTP、FTPS、SFTP 和 SMB storage connections。
- [ ] Storage foundation 完成后的带 Secure Links 的 managed storages 和 managed-database backup/restore。
- [ ] Business 和 Enterprise 的 vulnerability and security scanning。
- [ ] Business 和 Enterprise 的横向应用扩展：把多个 Docker nodes 组成 cluster，并把 application 部署到该 cluster。**In development.**
- [ ] Business 和 Enterprise 的纵向 workload 扩展：在同一台机器上运行同一 workload 的多个 managed instances。**In development.**
- [ ] Bastion and SSH management daemon for controlled host access.
- [ ] CLI for scriptable programmatic control from terminals and CI/CD jobs.
- [ ] Plugin system for extending Gateway with new integrations and operational modules.
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

可以。在 first-run wizard 或 **Settings > Advanced** 中为 structured logging 选择 **Disabled**。Gateway 的其他部分会继续工作；managed local ClickHouse 可以在不删除 data volume 的情况下关闭。
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
<summary><strong>AI Workspace 是必须的吗？</strong></summary>

不是。AI Workspace 是可选功能。Operations Console、REST API、OAuth 和 MCP 都可以独立使用；只有管理员启用 AI Workspace 并配置 provider 后，Gateway 才会向 AI provider 发送数据。运维人员可以从引导式 Scenario 开始，或选择 Plan Mode 生成经过验证且易读的计划；在用户明确确认实施之前，不会执行任何变更。
</details>

## 产品计划与许可

Gateway 提供四个产品计划。付费计划适用于一个 self-hosted 实例，不按 managed node、用户或 custom permission group 额外收费。

Community 仅可依据 [PolyForm Strict License 1.0.0](LICENSE.md) 用于非商业目的。由 Square Labs 签发的 Personal、Business 或 Enterprise 密钥，会依据 [Commercial Key License](COMMERCIAL-LICENSE.md) 自动向许可证记录中的被许可方授予一台官方未修改 Gateway 实例的有限商业使用权，并在密钥到期后继续有效 30 个自然日。两种许可证均不允许修改或再分发。

> [!NOTE]
> 以下价格为初步价格，不构成要约，并可能发生变化。购买前请确认最新价格和条款。

| 计划 | 月付 | 年付 | 规模与重点 |
|------|------|------|------------|
| ![Community](docs/assets/license/wiolett-gw-community-24.png)<br>Community | $0 | $0 | 仅限非商业使用的核心平台、AI Workspace 和 Gateway Inference；最多 100 个 managed nodes、10 个用户和 5 个 custom permission groups；提供只读 Compose 项目发现、inventory、monitoring 和 logs；Pages 不可用。 |
| ![Personal](docs/assets/license/wiolett-gw-personal-24.png)<br>Personal | $29 | $290 | 商业使用权，managed nodes/users/groups 的 plan quotas 不限，并包含 Compose deployment 与 lifecycle management、container archive import/export、blue/green deployments、cross-node migration、managed databases、public status pages、Pages 静态站点托管和 registry discovery；不包含正在开发的 application-cluster 功能。 |
| ![Business](docs/assets/license/wiolett-gw-business-24.png)<br>Business | $189 | $1,890 | 包含 Personal（包括 Compose management 和 Pages）的全部功能，并增加面向 containers、blue/green deployments、Compose Projects 与 Pages、带隔离 Build Workers 和 build vulnerability policy 的 Git push-to-deploy、private internal registry 的可选 external access、Docker Secure Runtime、structured logging、audit export、guided onboarding、发布后的 security scanning，以及正在开发的 application cluster 和 same-node multi-instance 功能。 |
| ![Enterprise](docs/assets/license/wiolett-gw-enterprise-24.png)<br>Enterprise | 询价 | 询价 | 包含 Business（包括 Pages）的全部功能，并增加 Internal PKI、SIEM export、专属技术联系人，以及部署和迁移协助。 |

完整功能矩阵、可用性状态、许可证验证和 source-license 边界请参见[产品计划与许可](docs/licensing.md)。

付费密钥到期后，Personal、Business 和 Enterprise 的技术 entitlements 分别继续有效 24 小时、3 天和 7 天。该产品 grace period 与 offline validation 以及上述 30 天商业使用授权相互独立。

Copyright (c) 2021-2026 [Square Labs](https://thesquarelabs.com)
