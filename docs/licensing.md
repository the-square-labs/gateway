# Plans And Licensing

[Back to README](../README.md)

Gateway is offered in four product plans: Community, Personal, Business, and Enterprise. Plans apply to one Gateway installation. Paid plans do not add per-node, per-user, or per-permission-group charges.

The plan limits and feature availability below define the product access granted by each plan.

Gateway source published by Square Labs is available under the [PolyForm Perimeter License 1.0.1](../LICENSE.md). It permits use, modification, and redistribution for noncompeting purposes, including ordinary internal business use. A Personal, Business, or Enterprise key unlocks the corresponding paid-plan features and limits for one official Gateway installation under the [Good Gateway Paid Key Terms 1.2](../COMMERCIAL-LICENSE.md).

An ordinary paid key does not waive Perimeter's restriction on providing a product marketed as a substitute for Gateway. Competing hosted/SaaS, OEM, white-label, and resale offerings require a separate written agreement with Square Labs. Key expiration follows the plan-specific technical grace period, after which the same installation may keep operating paid-plan resources configured before expiration; renewal is required to create new paid-plan resources or expand into additional paid-only features. Revocation for breach, fraud, chargeback, or refund ends paid-plan access and continuity immediately.

Every official release includes the [Product Continuity MIT Grant](../CONTINUITY-MIT-GRANT.md), a source-continuity backstop for covered Square Labs code. The grant itself is the authoritative source for its scope, conditions, exclusions, and any MIT transition.

Entitlements schema version 4 keeps `pages` on Personal, Business, and Enterprise, adds `compose-applications` to every paid plan, and adds `git-push-to-deploy` to Business and Enterprise. Gateway still accepts legacy version 3 grants, but those grants do not unlock managed Compose lifecycle or Git source builds until the license server reissues version 4 entitlements. Community grants include read-only external Compose discovery through the shared Docker feature but do not include Pages or managed Compose mutations.

## Plan Positioning

| Plan | Best fit | Scale | Support |
|---|---|---|---|
| **Community** | Internal and other noncompeting use of the core platform, including evaluation, modification, and redistribution under PolyForm Perimeter | Up to 100 managed nodes, 10 users, and 5 custom permission groups | Community |
| **Personal** | Installations that need unlimited node/user/group quotas, Compose deployment and lifecycle management, and current workload lifecycle features, without the in-development application-cluster capabilities | Unlimited nodes, users, and custom permission groups | Standard |
| **Business** | Teams that need Git push-to-deploy for containers, deployments, Compose, and Pages; isolated Build Workers; external access to the internal registry; Secure Runtime isolation; structured logging; audit export; guided onboarding; and planned application scaling/security scanning | Unlimited | Priority |
| **Enterprise** | Organizations that need Internal PKI, SIEM export, dedicated technical ownership, or assisted migration | Unlimited | Priority + Dedicated |

## Feature Availability

| Feature | Status | Community | Personal | Business | Enterprise |
|---|---|:---:|:---:|:---:|:---:|
| Infrastructure Node Management | Ready | ✅ | ✅ | ✅ | ✅ |
| Multi-Node Nginx Ingress Management | Ready | ✅ | ✅ | ✅ | ✅ |
| Docker Container Management — Default Runtime (`runc`) | Ready | ✅ | ✅ | ✅ | ✅ |
| External Compose Project Discovery, Monitoring, and Logs | Ready | ✅ | ✅ | ✅ | ✅ |
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
| Storage Connections: S3, R2, MinIO, FTP, FTPS, SFTP, and SMB | In development | ✅ | ✅ | ✅ | ✅ |
| Managed Nodes | Plan limit | 100 | Unlimited | Unlimited | Unlimited |
| Users | Plan limit | 10 | Unlimited | Unlimited | Unlimited |
| Custom Permission Groups | Plan limit | 5 | Unlimited | Unlimited | Unlimited |
| Support Level | Service level | Community | Standard | Priority | Priority + Dedicated |
| Container Export and Import | Ready | — | ✅ | ✅ | ✅ |
| Blue/Green Deployments | Ready | — | ✅ | ✅ | ✅ |
| Cross-Node Container and Deployment Migration | Ready | — | ✅ | ✅ | ✅ |
| Managed Single-node Compose Deployment and Lifecycle | Ready | — | ✅ | ✅ | ✅ |
| Managed Databases with Secure Links | Ready | — | ✅ | ✅ | ✅ |
| Public Status Pages | Ready, opt-in | — | ✅ | ✅ | ✅ |
| Pages | Ready | — | ✅ | ✅ | ✅ |
| Automatic GitLab Container Registry Discovery | Ready | — | ✅ | ✅ | ✅ |
| Managed Database Backup and Restore | In development, after Storage | — | ✅ | ✅ | ✅ |
| Managed Storages with Secure Links | In development | — | ✅ | ✅ | ✅ |
| Docker Secure Runtime (`runsc`/gVisor) | Ready | — | — | ✅ | ✅ |
| Git Repository Push-To-Deploy for Containers, Deployments, Compose, and Pages; Isolated Build Workers | Ready | — | — | ✅ | ✅ |
| External Docker-Client Access to the Internal Registry | Ready, opt-in | — | — | ✅ | ✅ |
| Git Build Vulnerability Scanning and Admission Policy | Ready | — | — | ✅ | ✅ |
| Structured Logging | Ready, opt-in | — | — | ✅ | ✅ |
| Audit Log Export | Ready | — | — | ✅ | ✅ |
| Broader Workload Vulnerability and Security Scanning | In development | — | — | ✅ | ✅ |
| Horizontal Application Clusters Across Multiple Nodes | In development | — | — | ✅ | ✅ |
| Multiple Instances of One Workload on One Machine | In development | — | — | ✅ | ✅ |
| Guided Onboarding and Configuration Review | Plan benefit | — | — | ✅ | ✅ |
| Internal PKI | Ready | — | — | — | ✅ |
| SIEM Audit Export | Ready, opt-in | — | — | — | ✅ |
| OIDC Group Mapping and SCIM Provisioning | In development | — | — | — | ✅ |
| Dedicated Technical Contact | Plan benefit | — | — | — | ✅ |
| Assisted Deployment and Migration | Plan benefit | — | — | — | ✅ |

`In development` identifies product availability separately from plan entitlement. A checkmark on such a row means the feature is included in that plan when released.

Runtime enforcement applies only to features marked ready. Community limits are enforced when creating a managed node, non-deleted user, or custom permission group; existing records are never deleted by a plan change. Database-node enrollment is available on every plan, while creating a managed database requires Personal or higher.

After an ordinary key expiration—or when the license service remains unreachable beyond cached-validation grace—Gateway preserves existing premium resources, running services, data, and enabled runtime modules. It does not stop workloads, remove routes, unpublish Pages deployments, turn off Internal PKI, SIEM, or structured logging, or close an already configured registry entry point merely because the subscription lapsed. New premium resources and paid-only operations such as archive import/export, migration, audit export, source builds, and paid-feature expansion remain blocked until entitlement is restored. Operations that would create or materially expand paid state can return `LICENSE_ENTITLEMENT_REQUIRED`; this does not affect the data plane already applied to managed hosts.

Authoritative entitlement loss is different. Explicit deactivation, activation replacement, revocation, an invalid key, or a policy violation may disable protected entry points and switchable modules while preserving stored configuration and resource data. Gateway never deletes managed resources solely because a plan changed. Renewing an ordinarily expired key restores full paid operations without rebuilding the existing infrastructure.

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

Contact [contact@thesqlabs.com](mailto:contact@thesqlabs.com) or [Square Labs on Telegram](https://t.me/WiolettIndustries) for Enterprise terms.

## Product License Verification

Gateway verifies paid product license keys against:

```text
https://license.thesqlabs.com
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

Issuance of a paid key activates the paid-plan access described in [COMMERCIAL-LICENSE.md](../COMMERCIAL-LICENSE.md). Activation binds that entitlement to one installation at a time. Rights independently granted by PolyForm Perimeter do not depend on key activation, while paid product features can end when the server reports an authoritative non-valid state.

Gateway sends paid heartbeats every 15 minutes and Community heartbeats every 30 minutes. If the
license server is unreachable, a previously valid paid installation uses its cached state for a
100-day technical offline-validation grace period. This connectivity grace does not extend paid
product access beyond a known expiration deadline.

After `expiresAt`, paid product entitlements remain active for 24 hours on Personal, 3 days on
Business, and 7 days on Enterprise. During this period the server and Gateway report
`expired_grace`, retain the original paid plan, expose `graceUntil`, and show an authenticated
critical Dashboard warning. Gateway evaluates the deadline locally for every protected operation;
at or after `graceUntil` it uses Community entitlements for new protected actions without waiting for another heartbeat. Existing paid resources and runtime modules remain in place and continue operating; Gateway does not reconcile ordinary expiration into service shutdown.
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
| `unreachable_grace_expired` | Gateway cannot validate the key and the offline grace period expired. New paid-only actions are blocked, but existing configured services remain running. |
| `invalid` | The license key is not valid. |
| `expired` | The plan-specific expiration grace ended. Gateway uses Community entitlements for new protected actions while preserving existing configured services. |
| `revoked` | The license key was revoked. |
| `replaced` | The license activation moved to another installation. |
| `deactivated` | The paid license was explicitly detached from this installation. |

## Storage And Security

Gateway stores a generated installation ID, an encrypted registration nonce, an encrypted
installation token, the encrypted paid key when one is installed, and the cached state returned by
the license server. Administrators can deactivate a paid license from **Settings > General >
License**; the server binding is released before the local key is removed.

## Legal-use boundary

Licensor-owned Gateway source is publicly available under the [PolyForm Perimeter License 1.0.1](../LICENSE.md). It permits use, modification, derivative works, and distribution for permitted purposes. The excluded purpose is providing to others a product marketed as a substitute for Gateway, regardless of whether that substitute is software, a hosted service, a port, or a free offering.

The [Good Gateway Paid Key Terms 1.2](../COMMERCIAL-LICENSE.md) govern plan features, limits, grace, and continuity for Personal, Business, and Enterprise keys. A key does not limit rights independently available under Perimeter, and it does not automatically authorize an OEM, white-label, resale, competing hosted, or other substitute product. Those uses require a separate written agreement with the Licensor.

The [Product Continuity MIT Grant](../CONTINUITY-MIT-GRANT.md) defines the complete source-continuity terms for covered Square Labs code. Refer to the grant itself for all triggers, exclusions, succession rules, and any MIT transition.

Third-party components remain governed by their own licenses. Already published Gateway releases remain governed by the terms distributed with those releases.
