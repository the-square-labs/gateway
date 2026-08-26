# Plans And Licensing

[Back to README](../README.md)

Gateway is offered in four product plans: Community, Personal, Business, and Enterprise. Plans apply to one self-hosted Gateway installation. Paid plans do not add per-node, per-user, or per-permission-group charges.

The plan limits and feature availability below define the product access granted by each plan.

Community is available only for noncommercial purposes permitted by the [PolyForm Strict License 1.0.0](../LICENSE.md). A Personal, Business, or Enterprise key issued by Wiolett Industries automatically grants the person or organization named in the license record limited commercial-use rights for one official, unmodified Gateway installation under the [Wiolett Gateway Commercial Key License 1.0](../COMMERCIAL-LICENSE.md).

The commercial grant begins when the key is issued, continues through its expiration date, and remains in effect for 30 calendar days afterwards. A key without an expiration date grants commercial use while it remains active. Revocation for breach, fraud, chargeback, or refund ends the grant immediately without grace. Neither license permits modification, derivative works, or redistribution.

Entitlements schema version 4 keeps `pages` on Personal, Business, and Enterprise, adds `compose-applications` to every paid plan, and adds `git-push-to-deploy` to Business and Enterprise. Gateway still accepts legacy version 3 grants, but those grants do not unlock managed Compose lifecycle or Git source builds until the license server reissues version 4 entitlements. Community grants include read-only external Compose discovery through the shared Docker feature but do not include Pages or managed Compose mutations.

## Plan Positioning

| Plan | Best fit | Scale | Support |
|---|---|---|---|
| **Community** | Noncommercial personal, hobby, educational, research, and qualifying noncommercial use | Up to 100 managed nodes, 10 users, and 5 custom permission groups | Community |
| **Personal** | Commercially operated installations that need unlimited node/user/group quotas, Compose deployment and lifecycle management, and current workload lifecycle features, without the in-development application-cluster capabilities | Unlimited nodes, users, and custom permission groups | Standard |
| **Business** | Teams that need Git push-to-deploy for containers, deployments, Compose, and Pages; isolated Build Workers; external access to the internal registry; Secure Runtime isolation; structured logging; audit export; guided onboarding; and planned application scaling/security scanning | Unlimited | Priority |
| **Enterprise** | Organizations that need Internal PKI, SIEM export, dedicated technical ownership, or assisted migration | Unlimited | Priority + Dedicated |

## Feature Availability

| Feature | Status | Community | Personal | Business | Enterprise |
|---|---|:---:|:---:|:---:|:---:|
| Infrastructure Node Management | Ready | ✅ | ✅ | ✅ | ✅ |
| Multi-Node Nginx Ingress Management | Ready | ✅ | ✅ | ✅ | ✅ |
| Docker Container Management — Default Runtime (`runc`) | Ready | ✅ | ✅ | ✅ | ✅ |
| Docker ↔ Nginx Secure Links | Ready | ✅ | ✅ | ✅ | ✅ |
| Private Gateway-Managed Internal Docker Registry | Ready | ✅ | ✅ | ✅ | ✅ |
| SSL/TLS Certificate Management | Ready | ✅ | ✅ | ✅ | ✅ |
| Domain and DNS Management | Ready | ✅ | ✅ | ✅ | ✅ |
| External Database Connections and Explorers | Ready | ✅ | ✅ | ✅ | ✅ |
| Infrastructure Monitoring | Ready | ✅ | ✅ | ✅ | ✅ |
| Physical GPU Discovery, Attachment, and Monitoring | Ready | ✅ | ✅ | ✅ | ✅ |
| Alerts and Webhook Notifications | Ready | ✅ | ✅ | ✅ | ✅ |
| Authentication, OIDC, and MFA | Ready | ✅ | ✅ | ✅ | ✅ |
| Folder- and Resource-Scoped Role-Based Access Control | Ready | ✅ | ✅ | ✅ | ✅ |
| Audit Log | Ready | ✅ | ✅ | ✅ | ✅ |
| REST API, OAuth, and MCP Automation | Ready | ✅ | ✅ | ✅ | ✅ |
| GitLab Integration | Ready | ✅ | ✅ | ✅ | ✅ |
| AI Workspace, Plan Mode, Scenarios, and AI Sandboxes | Ready, opt-in | ✅ | ✅ | ✅ | ✅ |
| Gateway Inference | Ready, opt-in | ✅ | ✅ | ✅ | ✅ |
| Automated Installation and Signed Updates | Ready | ✅ | ✅ | ✅ | ✅ |
| Storage Connections: S3, R2, MinIO, FTP, FTPS, SFTP, and SMB | Coming soon | ✅ | ✅ | ✅ | ✅ |
| Managed Nodes | Plan limit | 100 | Unlimited | Unlimited | Unlimited |
| Users | Plan limit | 10 | Unlimited | Unlimited | Unlimited |
| Custom Permission Groups | Plan limit | 5 | Unlimited | Unlimited | Unlimited |
| Support Level | Service level | Community | Standard | Priority | Priority + Dedicated |
| Container Export and Import | Ready | — | ✅ | ✅ | ✅ |
| Blue/Green Deployments | Ready | — | ✅ | ✅ | ✅ |
| Cross-Node Container and Deployment Migration | Ready | — | ✅ | ✅ | ✅ |
| Managed Databases with Secure Links | Ready | — | ✅ | ✅ | ✅ |
| Public Status Pages | Ready, opt-in | — | ✅ | ✅ | ✅ |
| Pages | Ready | — | ✅ | ✅ | ✅ |
| Automatic GitLab Container Registry Discovery | Ready | — | ✅ | ✅ | ✅ |
| Managed Database Backup and Restore | Coming soon, after Storage | — | ✅ | ✅ | ✅ |
| Managed Storages with Secure Links | Coming soon | — | ✅ | ✅ | ✅ |
| Docker Secure Runtime (`runsc`/gVisor) | Ready | — | — | ✅ | ✅ |
| Git Repository Push-To-Deploy for Containers, Deployments, Compose, and Pages; Isolated Build Workers | Ready | — | — | ✅ | ✅ |
| External Docker-Client Access to the Internal Registry | Ready, opt-in | — | — | ✅ | ✅ |
| Git Build Vulnerability Scanning and Admission Policy | Ready | — | — | ✅ | ✅ |
| Structured Logging | Ready, opt-in | — | — | ✅ | ✅ |
| Audit Log Export | Ready | — | — | ✅ | ✅ |
| Broader Workload Vulnerability and Security Scanning | In development | — | — | ✅ | ✅ |
| Horizontal Application Clusters Across Multiple Nodes | In development | — | — | ✅ | ✅ |
| Multiple Instances of One Workload on One Machine | In development | — | — | ✅ | ✅ |
| External Compose Project Discovery, Monitoring, and Logs | Ready | ✅ | ✅ | ✅ | ✅ |
| Managed Single-node Compose Deployment and Lifecycle | Ready | — | ✅ | ✅ | ✅ |
| Guided Onboarding and Configuration Review | Plan benefit | — | — | ✅ | ✅ |
| Internal PKI | Ready | — | — | — | ✅ |
| SIEM Audit Export | Ready, opt-in | — | — | — | ✅ |
| OIDC Group Mapping and SCIM Provisioning | In development | — | — | — | ✅ |
| Dedicated Technical Contact | Plan benefit | — | — | — | ✅ |
| Assisted Deployment and Migration | Plan benefit | — | — | — | ✅ |

`Coming soon` and `In development` identify product availability separately from plan entitlement. A checkmark on such a row means the feature is included in that plan when released.

Runtime enforcement applies only to features marked ready. Community limits are enforced when creating a managed node, non-deleted user, or custom permission group; existing records are never deleted by a plan change. Database-node enrollment is available on every plan, while creating a managed database requires Personal or higher.

On downgrade, Gateway preserves existing premium resources and their data. New premium resources and one-shot operations such as archive import/export, migration, audit export, and Git build admission are blocked. Existing Git-delivered workloads, source settings, build history, and internal-registry artifacts remain readable; source bindings and Build Secrets can still be removed, but source mutation, manual builds, polling, and webhook-triggered builds stop until Business is restored. Image-based Docker deployment and private internal registry operation remain available. Gateway automatically disables external registry ingress when Business entitlement is lost, clears its persisted external binding, and checks Business again whenever the public token endpoint issues a registry JWT. Existing Secure Runtime workloads and blue/green deployments remain manageable, but selecting Secure Runtime for a new or previously default-runtime workload requires Business. Internal PKI, SIEM export, and structured logging are switchable modules: Gateway disables them when their entitlement is lost while preserving their configuration and stored data, and never automatically re-enables them after an upgrade.

The Operations Console shows plan badges on whole premium modules and uses one shared upgrade dialog for blocked actions. This UI is explanatory only; the backend independently enforces the same entitlements across REST, OAuth/MCP, AI tools, background workers, public PKI routes, and domain services. Missing features return `LICENSE_ENTITLEMENT_REQUIRED` (HTTP 403), reached plan limits return `LICENSE_QUOTA_EXCEEDED` (HTTP 409), and an internally inconsistent protected policy fails closed with a generic `SERVICE_UNAVAILABLE` response.

AI Workspace and the separate multi-provider Gateway Inference are available in every plan. Both are opt-in and use administrator-configured providers, published models, access rules, and limits. Neither is required to operate Gateway through the Operations Console, REST API, OAuth, or MCP.

AI Workspace includes guided operational Scenarios and Plan Mode. Plan Mode researches the requested outcome with read-only planning tools, validates a structured plan, and waits for explicit user confirmation before implementation. Confirmed plans expose progress controls and finish with a separate verification pass.

## Pricing

> [!IMPORTANT]
> Pricing in this document is preliminary, does not constitute an offer, and is subject to change. The current legal-use terms are defined by [LICENSE.md](../LICENSE.md) and [COMMERCIAL-LICENSE.md](../COMMERCIAL-LICENSE.md); confirm current pricing before purchase.

| Plan | Monthly | Annual |
|---|---:|---:|
| Community | $0 | $0 |
| Personal | $29 | $290 |
| Business | $189 | $1,890 |
| Enterprise | On request | On request |

Contact [contact@wiolett.net](mailto:contact@wiolett.net) or [Wiolett Industries on Telegram](https://t.me/WiolettIndustries) for Enterprise terms.

## Product License Verification

Gateway verifies paid product license keys against:

```text
https://license.wiolett.cloud
```

Registration and activation flow:

1. Every installation registers with the license server and receives an installation token. A
   Community installation remains usable while initial registration is pending.
2. During browser installation, an administrator can enter a paid key or explicitly continue with
   Community. The paid-key path requires the license server to be available.
3. Paid activation binds the key to the registered installation. A key can have only one active
   installation. It can be moved after explicit deactivation, or after the previous installation has
   been offline for more than one hour.
4. The server returns the effective plan, license metadata, expiration, activation details, and
   versioned entitlements. Gateway stores credentials encrypted and caches the latest state.

Issuance of a paid key also activates the legal commercial-use grant described in [COMMERCIAL-LICENSE.md](../COMMERCIAL-LICENSE.md). Activation binds that grant to one installation at a time. The legal grant and technical entitlements are related but distinct: paid product features can end when the server reports an authoritative non-valid state even when a 30-day post-expiration commercial-use grace period is still running.

Gateway sends paid heartbeats every 15 minutes and Community heartbeats every 30 minutes. If the
license server is unreachable, a previously valid paid installation uses its cached state for a
30-day technical offline-validation grace period. This is separate from the commercial license's
30-day post-expiration legal-use grace period and cannot extend paid product access beyond a known
expiration deadline.

After `expiresAt`, paid product entitlements remain active for 24 hours on Personal, 3 days on
Business, and 7 days on Enterprise. During this period the server and Gateway report
`expired_grace`, retain the original paid plan, expose `graceUntil`, and show an authenticated
critical Dashboard warning. Gateway evaluates the deadline locally for every protected operation;
at or after `graceUntil` it uses Community entitlements without waiting for another heartbeat.
`revoked`, `replaced`, and `deactivated` remain immediate and receive no entitlement grace.

Data sent to the license server:

- Installation ID.
- Installation name.
- Gateway version.
- A locally generated registration nonce during registration.
- The installation token during heartbeats and license operations.
- The paid license key only during activation.

The installation name is derived from Gateway's persisted canonical public URL when possible, otherwise from the host name. Infrastructure configuration, managed-resource contents, logs, prompts, and model responses are not sent to the license server.

## License Statuses

| Status | Meaning |
|---|---|
| `community` | No paid product key is installed; Gateway is using Community status. |
| `valid` | The installed key is valid. |
| `expired_grace` | The key expired, but its original paid entitlements remain active until the plan-specific `graceUntil` deadline. |
| `valid_with_warning` | The key was previously valid, but the license server is unreachable and Gateway remains within grace. |
| `unreachable_grace_expired` | Gateway cannot validate the key and the offline grace period expired. |
| `invalid` | The license key is not valid. |
| `expired` | The plan-specific expiration grace ended and Gateway is using Community entitlements. |
| `revoked` | The license key was revoked. |
| `replaced` | The license activation moved to another installation. |
| `deactivated` | The paid license was explicitly detached from this installation. |

## Storage And Security

Gateway stores a generated installation ID, an encrypted registration nonce, an encrypted
installation token, the encrypted paid key when one is installed, and the cached state returned by
the license server. Administrators can deactivate a paid license from **Settings > General >
License**; the server binding is released before the local key is removed.

## Legal-use boundary

Wiolett-owned Gateway source is publicly available under the [PolyForm Strict License 1.0.0](../LICENSE.md). It permits noncommercial use, including the personal and qualifying noncommercial-organization purposes stated in that license. It does not permit modification, derivative works, or distribution.

The [Wiolett Gateway Commercial Key License 1.0](../COMMERCIAL-LICENSE.md) is a narrow additional grant attached automatically to a Wiolett-issued Personal, Business, or Enterprise key. It permits commercial use of one official, unmodified installation during the key term and for 30 calendar days after expiration, subject to its revocation rules. It does not permit modifying, redistributing, sublicensing, transferring, or reselling Gateway.

Third-party components remain governed by their own licenses. Already published Gateway releases remain governed by the terms distributed with those releases.
