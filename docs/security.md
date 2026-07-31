# Security Model

[Back to README](../README.md)

Gateway is a privileged infrastructure control plane, so its security model is built around strong identity, narrow network exposure, encrypted secrets, auditable actions, and explicit permissions. The goal is not to make infrastructure magic; it is to make the dangerous parts visible, authenticated, scoped, and recoverable.

## Secure-By-Default Principles

Gateway defaults to security controls that reduce the most common self-hosted control-plane risks:

- No internal password database. User login currently requires OIDC SSO, so MFA, account lifecycle, password policy, and device controls stay with the identity provider.
- No inbound management ports on managed nodes. Daemons initiate outbound connections to Gateway.
- No long-lived daemon shared secret. First enrollment uses a one-time token plus a pinned Gateway gRPC TLS leaf fingerprint, then replaces the token with an mTLS client certificate.
- No global trust for programmatic tokens. API/OAuth scopes are bounded by the owning user's current effective permissions.
- No silent secret reveal. Certificate exports, database credential reveal, Docker secret access, and dangerous OAuth scopes require explicit permissions.
- No anonymous control plane. Administrative and automation actions are permission-gated and audited.

Gateway still needs to be treated as sensitive infrastructure. Run it in an isolated VM or dedicated host, protect `.env`, back up secrets carefully, and limit Docker socket access to trusted operators.

## Identity And Login

Gateway uses OpenID Connect for user login. There is no built-in username/password authentication today.

This is intentional:

- Gateway does not need to store password hashes or implement password reset flows.
- MFA and conditional access can be enforced centrally in the OIDC provider.
- Offboarding happens by removing or disabling the user in the identity provider or changing their Gateway group assignment.
- Gateway can focus on authorization: which infrastructure actions an authenticated identity may perform.

The first-run setup creates Gateway groups and maps users to permissions. OIDC identities then receive Gateway capabilities through those groups.

`SETUP_TOKEN` is only accepted by `/api/setup/*` during the bootstrap window opened by the installer-written `SETUP_BOOTSTRAP=true` flag. The installer marks setup complete when it finishes; if setup is abandoned, the bootstrap window closes automatically one hour after first start. After that, the setup API returns 404 and bootstrap actions must use the authenticated UI/API. Keep the token out of tickets and chat because it is privileged during that bootstrap window.

Gateway binds OIDC users by the provider subject (`sub`) after first login. Manually pre-created users are initially claimed by matching the email asserted by the configured OIDC provider, so this flow assumes the provider is enterprise-controlled and authoritative for email assignment. Administrators can enable **Require verified OIDC email** to require `email_verified=true` for future auto-created users and pre-created user claims. Existing subject-bound users continue to authenticate by `sub`; when verified-email mode is enabled, Gateway does not replace a stored email with a changed unverified email claim.

## Node Trust Uses PKI And mTLS

Managed hosts run small daemons for nginx, Docker, or monitoring. Those daemons do not expose a management API to the network. Instead, they connect outbound to Gateway on the gRPC control-plane port, normally `9443/tcp`. Gateway daemon gRPC is always TLS; there is no plaintext development or production mode.

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

Gateway normally auto-issues its gRPC server certificate from the internal system CA and stores it under `GRPC_TLS_AUTO_DIR` (`/var/lib/gateway/tls` by default). The auto-issued certificate includes localhost, the Gateway host name, `APP_URL` host, configured public IPs, and `GRPC_TLS_EXTRA_SANS`. Custom `GRPC_TLS_CERT` and `GRPC_TLS_KEY` paths are advanced configuration and must point to a server certificate issued by the Gateway system CA, because enrolled daemons trust that CA for ongoing mTLS connections.

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
- SSL certificate store for ACME, uploaded, or linked certificates used by proxy hosts.

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
- Resource-scoped grants can limit access to a specific node, Docker container or deployment, proxy host, database, logging environment, schema, or similar resource.
- Write-capable scopes satisfy matching read/view checks, but resource-scoped grants stay bounded to the same resource.
- Create-only and destructive-only scopes do not grant browse access by themselves.

Sensitive operations have dedicated scopes. Examples include Docker mount editing, Docker secret reveal, database credential reveal, certificate export, node console access, container file access, raw nginx validation bypass, and audit log access.

Docker mount editing is guarded by `docker:containers:mounts`. Gateway does not maintain a hardcoded host-path denylist for this scope; users granted it for a node are trusted to define host bind mounts for that node, including high-risk control surfaces such as Docker sockets.

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

For webhook delivery, Gateway has outbound network policy controls. Loopback, link-local, multicast, reserved outbound ranges, and Gateway private/self addresses are blocked. Private network webhooks can be allowed for enterprise and homelab deployments that intentionally deliver to internal systems.

## Auditability

Gateway records administrative and automation actions in the audit log. This matters because a control plane should not only prevent unauthorized work; it should also explain who changed what when something goes wrong.

Examples of audited areas include:

- User and group changes.
- Node enrollment and management.
- API token and OAuth authorization actions.
- Proxy, certificate, Docker, database, notification, logging, and AI-assisted operations.

Use audit log export when you need external retention or compliance workflows.

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
