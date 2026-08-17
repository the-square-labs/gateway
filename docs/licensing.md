# Plans And Licensing

[Back to README](../README.md)

Gateway is offered in four product plans: Community, Personal, Business, and Enterprise. Plans apply to one self-hosted Gateway installation. Paid plans do not add per-node, per-user, or per-permission-group charges.

The plan limits and feature availability below define the product access granted by each plan.

The source-code license remains defined by [LICENSE.md](../LICENSE.md). This document describes product plans, feature availability, pricing, and product-license activation. Product plan names do not change the permissions granted by the source-code license. If a legal-use summary conflicts with `LICENSE.md`, the license text controls.

## Plan Positioning

| Plan | Best fit | Scale | Support |
|---|---|---|---|
| **Community** | Personal infrastructure, evaluation, and small self-hosted environments | Up to 100 managed nodes, 10 users, and 5 custom permission groups | Community |
| **Personal** | Operators and production teams that need unlimited scale and workload lifecycle features | Unlimited nodes, users, and custom permission groups | Standard |
| **Business** | Teams that need Secure Runtime isolation, security scanning, structured logging, audit export, and guided onboarding | Unlimited | Priority |
| **Enterprise** | Organizations that need Internal PKI, SIEM export, dedicated technical ownership, or assisted migration | Unlimited | Priority + Dedicated |

## Feature Availability

| Feature | Status | Community | Personal | Business | Enterprise |
|---|---|:---:|:---:|:---:|:---:|
| Infrastructure Node Management | Ready | ✅ | ✅ | ✅ | ✅ |
| Multi-Node Nginx Ingress Management | Ready | ✅ | ✅ | ✅ | ✅ |
| Docker Container Management — Default Runtime (`runc`) | Ready | ✅ | ✅ | ✅ | ✅ |
| Docker ↔ Nginx Secure Links | Ready | ✅ | ✅ | ✅ | ✅ |
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
| Automatic GitLab Container Registry Discovery | Ready | — | ✅ | ✅ | ✅ |
| Managed Database Backup and Restore | Coming soon, after Storage | — | ✅ | ✅ | ✅ |
| Managed Storages with Secure Links | Coming soon | — | ✅ | ✅ | ✅ |
| Docker Secure Runtime (`runsc`/gVisor) | Ready | — | — | ✅ | ✅ |
| Structured Logging | Ready, opt-in | — | — | ✅ | ✅ |
| Audit Log Export | Ready | — | — | ✅ | ✅ |
| Vulnerability and Security Scanning | In development | — | — | ✅ | ✅ |
| Guided Onboarding and Configuration Review | Plan benefit | — | — | ✅ | ✅ |
| Internal PKI | Ready | — | — | — | ✅ |
| SIEM Audit Export | Ready, opt-in | — | — | — | ✅ |
| OIDC Group Mapping and SCIM Provisioning | In development | — | — | — | ✅ |
| Dedicated Technical Contact | Plan benefit | — | — | — | ✅ |
| Assisted Deployment and Migration | Plan benefit | — | — | — | ✅ |

`Coming soon` and `In development` identify product availability separately from plan entitlement. A checkmark on such a row means the feature is included in that plan when released.

AI Workspace and the separate multi-provider Gateway Inference are available in every plan. Both are opt-in and use administrator-configured providers, published models, access rules, and limits. Neither is required to operate Gateway through the Operations Console, REST API, OAuth, or MCP.

AI Workspace includes guided operational Scenarios and Plan Mode. Plan Mode researches the requested outcome with read-only planning tools, validates a structured plan, and waits for explicit user confirmation before implementation. Confirmed plans expose progress controls and finish with a separate verification pass.

## Pricing

> [!IMPORTANT]
> Pricing in this document is preliminary, does not constitute an offer, and is subject to change until commercial terms are finalized. Confirm the current price and applicable terms before purchase.

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

Gateway sends paid heartbeats every 15 minutes and Community heartbeats every 30 minutes. If the
license server is unreachable, a previously valid paid installation uses its cached state for a
30-day offline grace period. An authoritative `expired`, `revoked`, `replaced`, or `deactivated`
response immediately returns the installation to Community entitlements.

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
| `valid_with_warning` | The key was previously valid, but the license server is unreachable and Gateway remains within grace. |
| `unreachable_grace_expired` | Gateway cannot validate the key and the offline grace period expired. |
| `invalid` | The license key is not valid. |
| `expired` | The license key expired. |
| `revoked` | The license key was revoked. |
| `replaced` | The license activation moved to another installation. |
| `deactivated` | The paid license was explicitly detached from this installation. |

## Storage And Security

Gateway stores a generated installation ID, an encrypted registration nonce, an encrypted
installation token, the encrypted paid key when one is installed, and the cached state returned by
the license server. Administrators can deactivate a paid license from **Settings > General >
License**; the server binding is released before the local key is removed.

## Source License

The source license lives in [LICENSE.md](../LICENSE.md). It defines permitted personal, noncommercial, small-business, and separately licensed commercial use. Product plan packaging and feature availability do not replace or modify those legal terms.
