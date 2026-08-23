# Security Model

[Back to README](../README.md)

Gateway is a privileged infrastructure control plane, so its security model is built around strong identity, narrow network exposure, encrypted secrets, auditable actions, and explicit permissions. The goal is not to make infrastructure magic; it is to make the dangerous parts visible, authenticated, scoped, and recoverable.

## Secure-By-Default Principles

Gateway defaults to security controls that reduce the most common self-hosted control-plane risks:

- First-run access is protected by a one-time, 24-hour setup code. Gateway stores only its identifier, expiry, and SHA-256 hash.
- OIDC, password, and email one-time-code sign-in are explicit administrator choices. Password hashes use the local credential store; SMTP and OIDC secrets are envelope-encrypted with `PKI_MASTER_KEY`.
- No inbound management ports on managed nodes. Daemons initiate outbound connections to Gateway.
- No long-lived daemon shared secret. First enrollment uses a one-time token plus a pinned Gateway gRPC TLS leaf fingerprint, then replaces the token with an mTLS client certificate.
- No global trust for programmatic tokens. API/OAuth scopes are bounded by the owning user's current effective permissions.
- No silent secret reveal. Certificate exports, database credential reveal, Docker secret access, and dangerous OAuth scopes require explicit permissions.
- New Gateway-created Docker workloads are non-privileged, add no Linux capabilities, and run with `no-new-privileges`. The optional Secure profile uses gVisor `runsc` for a stronger host-isolation boundary; it is not presented as a full virtual machine or universal syscall compatibility layer.
- New and changed container mounts can reference only Gateway-managed local Docker volumes. Gateway rejects new host bind mounts; unchanged legacy mounts can remain attached until an operator removes or migrates them.
- Managed databases are private by default. Application bindings use Gateway-authenticated tunnels and per-binding engine identities. A published database TCP endpoint is an explicit opt-in; direct TLS is enabled by default and may be deliberately disabled per database.
- Gateway creates a dedicated Database CA at startup, separate from daemon mTLS. Each managed database receives a server certificate containing its database node's reported service IPs. Direct clients receive only the CA certificate and fingerprint; the server private key remains on the database node. Rotate the certificate after changing a node's published IPs.
- A connector sidecar exposes only an ordinary database TCP endpoint on a private Docker network. It has no database credentials and no Gateway mTLS material; a daemon-owned Unix socket admits it by a binding ID and carries traffic on the daemon's existing mTLS session.
- The public daemon endpoint on `9443/tcp` is owned by a separate relay container, not the web application process. The app reaches relay control RPCs over service mTLS, and relay reaches the app's internal gRPC endpoint with its own service identity. The relay accepts forwarded node identity only from that authenticated app/relay boundary and rechecks current authorization in PostgreSQL.
- Relay database access uses a dedicated PostgreSQL role restricted to versioned security-barrier views. It cannot read encrypted credentials or mutate Gateway state. Every new binding open fails closed when the required view contract or PostgreSQL authorization check is unavailable; established streams are not closed merely because PostgreSQL is temporarily unavailable.
- Remote Relay Pool workers receive instance-bound signed policy envelopes over an independently enrolled supervisor identity. Policy revisions are replay-protected and expire after a fixed 15-minute disconnected lease. Worker and supervisor updates use separately scoped signed manifests; a worker is replaced only after local readiness/version verification, and the supervisor update remains rollback-pending until Gateway verifies its reconnect.
- Binding identities are least-privilege: Redis bindings receive ordinary data, connection, transaction, and pub/sub commands plus explicit script execution/load commands; they cannot administer ACLs, flush/kill scripts, or manage Redis Functions. Connector, daemon, and Gateway enforce per-binding/session admission caps and close idle tunnel sessions.
- Managed database lifecycle commands carry durable operation IDs. A lost command response is reconciled against daemon state before Gateway reports a terminal result, so a delayed create, resize, or delete cannot be mistaken for a different operation.
- No anonymous control plane. Administrative and automation actions are permission-gated and audited.

Gateway still needs to be treated as sensitive infrastructure. Run it in an isolated VM or dedicated host, protect `.env`, back up secrets carefully, and limit Docker socket access to trusted operators.

## Identity And Login

Gateway can enable OIDC, password, and email one-time-code sign-in independently. Email-based methods require a verified SMTP configuration. Users may add passkeys after setup; passkeys are not a first-run primary method.

The browser wizard creates exactly one deliberate first administrator in the built-in `system-admin` group. No arbitrary first OIDC login is promoted. Later OIDC users follow the configured auto-provisioning and default-group policy.

The installer prints a random one-time setup code and never writes its plaintext to `.env` or the database. A successful code exchange creates an HTTP-only setup session bounded by the same 24-hour expiry. Product APIs stay locked until the wizard has an explicit public URL, at least one sign-in method, and the first administrator. Completing setup removes the code and setup sessions. The printed reset command reopens setup, invalidates browser/setup sessions, and issues a new code.

Gateway binds OIDC users by the provider subject (`sub`) after first login. Manually pre-created users are initially claimed by matching the email asserted by the configured OIDC provider, so this flow assumes the provider is enterprise-controlled and authoritative for email assignment. Administrators can enable **Require verified OIDC email** to require `email_verified=true` for future auto-created users and pre-created user claims. Existing subject-bound users continue to authenticate by `sub`; when verified-email mode is enabled, Gateway does not replace a stored email with a changed unverified email claim.

## Node Trust Uses PKI And mTLS

Managed hosts run small daemons for nginx, Docker, or monitoring. Those daemons do not expose a management API to the network. Instead, they connect outbound to Gateway's dedicated relay on the gRPC control-plane port, normally `9443/tcp`. Gateway daemon gRPC is always TLS; there is no plaintext development or production mode. The daemon keeps one control connection and one independent long-lived tunnel connection so an app-only restart does not tear down binding traffic.

Relay nodes are the deliberate exception to the no-inbound-service-port rule: their management channel is still outbound-only, but their advertised mTLS data endpoint must accept traffic from participating managed hosts. Gateway neither changes firewall rules nor claims that a public/NATed endpoint is reachable; staged assignments activate only after target registration and source-side probes succeed.

Long-term daemon trust is based on Gateway's internal node PKI:

1. An operator creates a node in Gateway.
2. Gateway creates a one-time enrollment token, stores only a hash, and returns the current Gateway gRPC TLS leaf certificate fingerprint as `gatewayCertSha256`.
3. The setup command writes the token and fingerprint to daemon config as `gateway.token` and `gateway.cert_sha256`.
4. The unenrolled daemon connects to Gateway and verifies the presented TLS leaf certificate matches `gateway.cert_sha256`.
5. Only after that fingerprint check passes, the daemon sends the enrollment token.
6. Gateway validates the token and issues a node client certificate from the internal Gateway Node CA.
7. The daemon writes the CA certificate, client certificate, and private key to its local config path.
8. The daemon clears the enrollment token and reconnects using mTLS.
9. Gateway identifies the node from the verified mTLS client certificate.

After enrollment, the token is not the node's identity. The certificate is.

Gateway normally auto-issues its gRPC server certificate from the internal system CA and stores it under `GRPC_TLS_AUTO_DIR` (`/var/lib/gateway/tls` by default). The auto-issued certificate includes localhost, the Gateway host name, the persisted canonical public host, discovered host IP addresses, and `GRPC_TLS_EXTRA_SANS`. The optional native HTTPS listener receives a separate `gateway-web` leaf from this same CA. Custom `GRPC_TLS_CERT` and `GRPC_TLS_KEY` paths are advanced configuration and must point to a server certificate issued by the Gateway system CA, because enrolled daemons trust that CA for ongoing mTLS connections.

## Why This Prevents Node Hijacking

A reusable shared secret is easy to copy, leak, or leave behind. Gateway avoids that pattern:

- Enrollment tokens are one-time setup material and are removed from daemon config after use.
- Enrollment tokens are sent only after the daemon verifies the pinned Gateway gRPC TLS leaf fingerprint, so a DNS/proxy/path mistake cannot silently disclose the token to a different TLS endpoint.
- Each daemon gets a unique client certificate.
- The client certificate common name is the Gateway node ID.
- Gateway verifies that the certificate identity matches the node claiming the stream.
- Control streams and log streams require a verified client certificate.
- Certificate renewal requires the existing certificate and is checked against the connected node identity.
- Deleting a node revokes its mTLS certificate so the old daemon cannot reconnect as that node.

This gives every node a cryptographic identity anchored in Gateway's internal CA. A random host cannot join the fleet without a valid enrollment token and the matching Gateway certificate endpoint, and an enrolled daemon cannot impersonate a different node without that node's private key.

For best enrollment assurance, run the setup command against a direct Gateway `9443/tcp` endpoint that you control. If the web UI is behind Cloudflare or another proxy, you may replace `--gateway <host>:9443` with the direct Gateway host/IP for daemon enrollment, but keep the generated `--gateway-cert-sha256` value. Replacing the fingerprint defeats the pin and should only happen after creating a new node command from the Gateway UI/API.

## PKI Responsibilities

Gateway maintains separate certificate domains:

- System node CA for daemon mTLS identity.
- Internal PKI for user-managed roots, intermediates, templates, and issued certificates.
- SSL certificate store for ACME, uploaded, or linked certificates used by ingress routes. Gateway keeps canonical encrypted material and distributes node-local replicas only to nginx nodes with active TLS routes.

Private key material is encrypted at rest with `PKI_MASTER_KEY`. That key is critical: without it, Gateway cannot decrypt stored PKI material or private keys. Protect it like a root secret and include it in secure backups.

Gateway also supports certificate lifecycle operations:

- CA and certificate creation.
- Certificate issuance from templates.
- Revocation.
- Expiry tracking and alerts.
- ACME certificate issuance and renewal.
- Daemon mTLS certificate renewal before expiry.

## Authorization And Scopes

Gateway separates authentication from authorization.

Authentication answers who the user or daemon is. Authorization answers what that identity can do.

Authorization uses granular scopes:

- Users receive scopes through permission groups.
- API tokens and OAuth grants cannot exceed the owning user's current effective scopes.
- MCP access requires the owning user to have the `mcp:use` capability.
- Resource-scoped grants can limit access to a specific node, Docker container or deployment, ingress route (`proxy_host` in API identifiers), database, logging environment, schema, or similar resource.
- Write-capable scopes satisfy matching read/view checks, but resource-scoped grants stay bounded to the same resource.
- Create-only and destructive-only scopes do not grant browse access by themselves.

Sensitive operations have dedicated scopes. Examples include Docker mount editing, Docker secret reveal, database credential reveal, certificate export, node console access, container file access, raw nginx validation bypass, and audit log access. Managed databases reuse the database create, edit, delete, and credential-reveal scopes; generated binding secrets are not displayed by default.

Docker mount editing is guarded by `docker:containers:mounts`, but the scope does not bypass the managed-storage policy. New or changed mounts must reference Gateway-managed local volumes, and new host bind mounts are rejected. Existing legacy mounts are preserved by ordinary updates; a legacy local volume can be adopted only when it uses the local driver, local scope, and no driver options.

For the complete scope list and implication rules, see [SCOPES.md](../SCOPES.md).

## Programmatic Access

Gateway intentionally separates token families:

| Token | Purpose |
|-------|---------|
| `gw_` | REST API automation token. |
| `gwo_` | OAuth access token for one resource, either Gateway API or Gateway MCP. |
| `gwl_` | Write-only structured logging ingest token. |
| `gwi_` | Dedicated Gateway Inference runtime token. |

REST API tokens are not accepted by the MCP endpoint. MCP accepts only OAuth access tokens issued for the Gateway MCP resource. Logging ingest tokens can write logs only to their logging environment. Inference data-plane routes accept only `gwi_` tokens and reject browser sessions plus `gw_`, `gwo_`, and `gwl_` credentials.

OAuth consent also treats dangerous scopes differently: high-risk scopes are visible but unchecked by default and must be explicitly selected.

Gateway keeps dynamic OAuth registration enabled for local public-client UX, but defaults registration and authorization to loopback callbacks only. External HTTPS callbacks require the explicit OAuth extended callback compatibility setting, and the consent screen marks those requests with an additional high-risk warning.

## Secret Handling

Gateway stores several kinds of sensitive data:

- PKI private keys.
- SSL private keys.
- Database connection credentials.
- Docker/deployment secrets.
- API, OAuth, and logging token hashes or encrypted values.
- License key material.

Sensitive values are encrypted where the product needs to recover them, and hashed where Gateway only needs to verify them. UI and API responses avoid returning raw secrets unless the caller has the explicit reveal/export scope for that operation.

Docker registry credentials are sent to a Bearer token service only when the challenge realm is on the same HTTPS registry host or matches the registry's explicitly configured trusted HTTPS token-service origin.

## Network Exposure

The intended deployment model is narrow:

- Public users reach Gateway UI/API over HTTPS.
- Daemons connect outbound to Gateway gRPC on `9443/tcp`.
- Managed nodes do not need inbound SSH or daemon management ports for Gateway.
- Nginx nodes still expose normal service traffic ports, typically `80/tcp` and `443/tcp`.

For webhook delivery, Gateway has outbound network policy controls. Loopback, link-local, multicast, reserved outbound ranges, and Gateway self addresses are always blocked. Private destinations are allowed only when private-network delivery is enabled and every resolved address matches an administrator-configured CIDR; the default allowlist is `10.0.0.0/8` and `172.16.0.0/12`. This policy is not gated by the product license tier.

## Auditability

Gateway records administrative and automation actions in the audit log. This matters because a control plane should not only prevent unauthorized work; it should also explain who changed what when something goes wrong.

Examples of audited areas include:

- User and group changes.
- Node enrollment and management.
- API token and OAuth authorization actions.
- Proxy, certificate, Docker, database, notification, logging, and AI-assisted operations.

Use audit log export when you need external retention or compliance workflows.

## SIEM Audit Export

SIEM export is outbound HTTPS push from Gateway to an authenticated collector; it is not an inbound webhook that lets a collector call Gateway. Each exported record is deliberately narrower than an audit-log record: it includes an event id, Gateway installation source, timestamp, action, optional actor id/email, resource type/id, and source IP. Full audit `details`, resource display names, user agents, request payloads, credentials, secrets, and collector response bodies are never exported.

The SIEM feature flag is enabled by default where the Enterprise `siem-export` entitlement is available. In **Settings > General > General settings**, disabling **SIEM audit export** hides the SIEM screens, blocks the SIEM API and AI tools, prevents new audit events from entering the SIEM outbox, and pauses the delivery scheduler. Destination configuration, delivery history, and already queued records are retained; queued records resume when SIEM is enabled again. Entitlement loss disables SIEM while preserving the same stored state.

Destinations require HTTPS without URL credentials, query strings, or fragments. They reuse the outbound-webhook policy: unsafe address ranges are blocked unless explicitly permitted, DNS addresses are pinned for each request, and redirects are not followed. Each destination uses bearer-token, HMAC-SHA256, or validated custom-header authentication; its secret or custom-header value is envelope-encrypted at rest and is never returned through the UI, API, audit log, AI tools, or application logs. Custom header names must be valid HTTP field names and cannot override Gateway transport headers such as `Host`, `Content-Type`, or `X-Gateway-*`; `Authorization` remains available for collectors with a non-Bearer scheme.

For HMAC-SHA256, Gateway sends `X-Gateway-Timestamp` and `X-Gateway-Signature-256: sha256=<hex>`, where the signature is calculated over `timestamp + "." + raw JSON request body`. A collector must verify the exact raw body, compare the HMAC in constant time, and reject stale timestamps to limit replay.

`audit:siem:view` allows destination and delivery-history visibility. `audit:siem:manage` controls configuration, tests, deletion, and replay of failed records; it is an explicit OAuth consent scope. Disabling an individual destination pauses its outstanding work, deletion discards outstanding work, and only terminal failed records may be replayed.

## Operational Hardening Checklist

Use this baseline for production:

- Run Gateway on an isolated VM or dedicated host.
- Do not run unrelated workloads on the same Docker host.
- Use HTTPS for the UI/API.
- Use an OIDC provider with MFA.
- Protect `.env`, `PKI_MASTER_KEY`, database credentials, and OIDC client secret.
- Keep Redis healthy and monitored. Gateway treats Redis as required security infrastructure for sessions and rate limiting; Redis-backed limiter failures fail closed with `503` instead of allowing unchecked traffic.
- Back up PostgreSQL, Redis data if needed, ClickHouse data if logging is enabled, custom TLS files, and `PKI_MASTER_KEY`.
- Limit `admin:system`, update, secret reveal, certificate export, console, and file-access scopes to trusted operators.
- Keep daemon setup tokens and generated fingerprints short-lived operationally: copy once, enroll, and do not store setup commands in tickets or chat.
- Enroll daemons against a direct trusted `9443/tcp` Gateway endpoint, and keep the generated `--gateway-cert-sha256` value when changing only the endpoint host.
- Keep Gateway and daemons updated through signed release manifests. Automatic updates fail closed when the manifest is missing, invalid, or does not match the exact gateway image digest or daemon binary checksum.
- Review audit logs after sensitive changes.

## Threat Model Notes

Gateway reduces the risk of node hijacking by pinning first enrollment to the generated Gateway gRPC TLS leaf fingerprint, replacing setup tokens with per-node mTLS certificates, verifying certificate identity on daemon streams, and revoking node certificates on deletion. This is the security property operators should care about most: initial token submission depends on reaching the expected Gateway certificate, and ongoing control of a managed node depends on possession of that node's private key and a certificate that Gateway issued for that exact node identity.

Gateway and daemon self-updates use a compiled Ed25519 public key to verify signed release manifests. The private update signing key must live only in CI as `UPDATE_SIGNING_PRIVATE_KEY_PEM_B64`; it must not be stored in the repository, `.env`, tickets, or chat. Gateway image updates are installed by signed digest, and daemon binary updates are installed only after signed-manifest and SHA256 verification.

Gateway does not remove the need for host security:

- A root compromise of the Gateway host can compromise the control plane.
- A root compromise of a managed host can access that daemon's local certificate and whatever the host itself can access.
- Losing `PKI_MASTER_KEY` means encrypted PKI and private key material cannot be decrypted.
- Exposing the Docker socket is privileged by nature, so Gateway should run on isolated infrastructure.

These are the normal boundaries for an infrastructure control plane. Gateway's design makes those boundaries explicit and gives operators tools to keep access narrow, observable, and PKI-backed.
