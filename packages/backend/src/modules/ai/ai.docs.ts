import { hasScopeBase } from '@/lib/permissions.js';
import { PERMISSIONS_DOC } from './ai.docs.permissions.js';

export const INTERNAL_DOCS: Record<string, string> = {
  discovery: `# Resource Discovery

Gateway AI starts conversations with a small base tool surface. Domain-specific tools are discovered by category and then remembered on the backend conversation.

## Base Tools
- discover_tools: inspect callable tool categories and category-specific tools.
- read_skill and activate_skill: inspect or load one system or enabled organization skill listed in the assistant's compact prompt catalog. These are AI Workspace-only and are not MCP tools. Do not reactivate a skill while its earlier activation remains in the current context; activate it again after compaction only when it is still relevant.
- get_current_context: read the current UI route/resource when the user says "this page" or "current item".
- wait: pause briefly when an operation is pending, then continue by re-checking status.
- find_resource: globally search readable resources by name, ID, domain, image, etc.
- internal_documentation: read workflow and argument docs before complex operations.
- ask_question: ask concise clarifying questions.
- fetch: read a direct HTTP/HTTPS URL through Gateway when sandbox runner is enabled and the user has sandbox access.
- web_search: available only when enabled by settings.

## Tool Discovery
- If the needed operation is not available, call discover_tools first.
- Use internal_documentation before Gateway-specific workflows, tool argument details, permission-sensitive operations, and recently added capabilities. Do not answer those from general intuition.
- Use discover_tools({ categories: ["Logging"], includeTools: true }) before managing logging environments/schemas/logs.
- Use discover_tools({ categories: ["Docker"], includeTools: true }) before managing Docker containers/images/volumes/networks.
- Use discover_tools({ categories: ["Ingress"], includeTools: true }) before managing domains, routes, route folders, nginx templates, or access lists.
- Use discover_tools({ categories: ["Inference"], includeTools: true }) before configuring inference providers, models, limits, or tokens.
- Use discover_tools({ query: "certificate" }) when you know the task but not the category.
- After discovery, use internal_documentation for workflow details and argument shapes.

Use find_resource whenever the user gives a name, domain, hostname, image, container name, certificate name, logging environment/schema name, database name, or other visible identifier and you need the actual ID or nodeId.
Use find_resource with an empty query and a concrete type when the user asks to list resources by type, for example Docker containers or Page Projects.

## Rule
- Use get_current_context when the user refers to the page or resource they are currently viewing.
- Use wait for short pending states such as container startup, image pull completion, DNS/SSL validation, deployments, daemon reloads, or log ingestion. After wait, call the relevant read/status tool again; do not finish the conversation just because the operation is not complete yet.
- Prefer find_resource before broad list sweeps.
- For a direct URL, use fetch. Use web_search only when you need search results rather than the exact URL content.
- Do not list every node and then inspect every node for Docker resources unless find_resource failed, the user explicitly asked for per-node enumeration, or you need a complete inventory.
- If the result includes nodeId, pass that nodeId to Docker tools.
- If exactly one result is valid/applicable for the operation, use it without asking. For Docker image/container operations, ignore non-Docker nodes as choices.
- If multiple applicable results match, use ask_question to disambiguate.

## Examples
- Find a container named api: find_resource({ query: "api", types: ["docker_container"] })
- List Docker containers: find_resource({ query: "", types: ["docker_container"], limit: 50 })
- List Docker nodes: find_resource({ query: "", types: ["node"], limit: 50 })
- Find an ingress route by domain: find_resource({ query: "example.com", types: ["proxy_host"] })
- Find a logging schema: find_resource({ query: "nginx", types: ["logging_schema"] })
- Search all readable resources: find_resource({ query: "production" })`,

  pki: `# PKI (Public Key Infrastructure)

## Certificate Authorities (CAs)
- **Root CA**: Self-signed, top of the trust chain. Created with create_root_ca. Set pathLengthConstraint to limit CA chain depth (0 = can only issue end-entity certs, 1 = can create one level of intermediate CAs).
- **Intermediate CA**: Signed by a parent CA. Created with create_intermediate_ca(parentCaId, ...). Recommended for issuing end-entity certificates.
- Key algorithms: rsa-2048, rsa-4096, ecdsa-p256, ecdsa-p384.
- CAs can be revoked (permanent) or deleted (only if no certs issued).
- Each CA has: commonName, keyAlgorithm, validityYears, maxValidityDays (max validity for certs it issues).

## PKI Certificates
- Issued by a CA using issue_certificate.
- Types: tls-server (web/SSL), tls-client (client auth), code-signing, email (S/MIME).
- Fields: caId, commonName, keyAlgorithm, validityDays, type, sans (Subject Alternative Names).
- SANs: array of PLAIN strings — just the value, NO type prefix. Examples: "example.com", "*.example.com", "10.0.0.1", "user@example.com". The system auto-detects the type (dns/ip/email/url). NEVER use "DNS:", "IP:", or other prefixes — they will cause errors.
- Certificates can be revoked with a reason (key_compromise, superseded, unspecified, etc.).
- Private keys are generated server-side and encrypted at rest.

## System PKI Audit
- System CAs and their leaves are hidden from ordinary PKI tools.
- Use \`audit_system_pki_leaves\` only when the user explicitly asks to inspect Gateway system PKI. It requires both PKI view permission and \`admin:details:certificates\`.
- The report is read-only: \`current\` and \`retired\` reflect persisted lifecycle ownership; \`unknown\` means ownership cannot be proven and must never be mutated automatically.
- Never use generic revoke/delete operations for system certificates or CAs: server policy rejects them. This tool cannot revoke, delete, issue, export keys, or clean up certificates.

## PKI → SSL Workflow
PKI certificates live in a separate store from SSL certificates. To use a PKI cert with an ingress route:
1. issue_certificate → returns { certificate, message }
2. link_internal_cert(internalCertId: certificate.id) → creates an SSL certificate entry
3. Use the SSL certificate ID (from step 2) when creating/updating routes through the existing proxy-host tools.
NEVER use a PKI certificate ID directly as sslCertificateId on a route.`,

  ssl: `# SSL Certificates

SSL certificates in Gateway enable HTTPS on ingress routes. Three types exist:

## Types
1. **ACME** (Let's Encrypt): Automated free certificates via request_acme_cert. Requires domain verification. Auto-renewable.
2. **Upload**: Manually uploaded PEM certificate + private key via manage_ssl_certificate({ operation: "upload", ... }). No auto-renewal — must be re-uploaded before expiry.
3. **Internal**: Linked from PKI store via link_internal_cert(internalCertId). Uses the PKI cert's key material. Renewed by re-issuing the PKI cert and re-linking.

## ACME Certificates (Let's Encrypt)
- request_acme_cert({ domains: ["example.com", "www.example.com"], challengeType: "http-01" })
- **http-01**: Gateway deploys each challenge to the Nginx ingress assigned to that registered domain. The assigned node must be online and publicly reachable on port 80.
- **dns-01 with Cloudflare**: For wildcard certs or when port 80 is blocked and a matching Cloudflare connector/zone is configured. Use request_acme_cert({ domains, challengeType: "dns-01", dnsProvider: "cloudflare" }). Gateway creates the TXT records, waits for propagation, verifies the ACME order, cleans up created TXT records, and returns the issued certificate.
- **manual dns-01**: If no Cloudflare connector/zone is available, omit dnsProvider. The tool returns { domain, recordName, recordValue }; user must create a DNS TXT record manually, then confirm with manage_ssl_certificate({ operation: "verify_dns", sslCertificateId }).
- Auto-renew: checked daily at 3 AM. Renews certificates 30 days before expiry.
- DNS-01 auto-renew requires Cloudflare. Enable or disable it with manage_ssl_certificate({ operation: "set_auto_renew", sslCertificateId, enabled: true, provider: "cloudflare" }) or enabled: false.
- Staging mode available for testing (certs not browser-trusted).

## Uploading Custom Certificates
- manage_ssl_certificate({ operation: "upload", certificatePem, privateKeyPem, chainPem? })
- Chain PEM is optional (intermediate CA chain).
- Expiry is parsed from the certificate — no auto-renewal.

## Using PKI Certificates as SSL
To use a PKI-issued certificate with an ingress route:
1. Issue a PKI certificate: issue_certificate(...) → returns cert with id
2. Link it: link_internal_cert(internalCertId: cert.id) → creates an SSL certificate entry with a separate ID
3. Use the SSL certificate ID (from step 2) as sslCertificateId on the route
IMPORTANT: Never use a PKI certificate ID directly as sslCertificateId — you must link it first.

## Using SSL Certs with Routes
- Set sslCertificateId on the route to the SSL certificate UUID.
- Set sslEnabled: true to enable HTTPS.
- sslForced: true redirects all HTTP traffic to HTTPS (301 redirect).
- http2Support: true enables HTTP/2 (recommended with SSL).

## Certificate Deployment
When an enabled TLS route uses an SSL certificate, Gateway:
1. Keeps the canonical encrypted certificate material in the Gateway control plane
2. Deploys a node-local replica only to the route's nginx ingress node
3. Applies the certificate and route config atomically, tests the config (nginx -t), and reloads nginx
4. Tracks per-node deployment state and removes unused replicas after the cleanup grace period

Certificate issuance itself is not tied to a machine. HTTP-01 validation is served by the registered domain's assigned ingress node; DNS-01 validation does not require HTTP ingress.`,

  proxy: `# Ingress Routes

The UI calls these resources Routes. Existing REST paths, tool names, resource types, and persisted identifiers retain the proxy-host name for compatibility.

## Types
- **proxy**: Forward requests to a backend server (forwardHost:forwardPort).
- **redirect**: Redirect to a URL (redirectUrl, redirectStatusCode: 301/302).
- **404**: Return 404 for all requests (used to block domains).

## Key Fields
- nodeId: the nginx ingress node this route is deployed on (required when creating).
- domainNames: array of domains this route serves. Registered domains must be assigned to the same nginx node.
- forwardHost/forwardPort/forwardScheme: backend server details (for proxy type).
- upstreamKind: manual, docker_container, docker_deployment, or pages. Docker upstreams store a stable container name or deployment ID plus a published TCP port; Pages stores a Page Project and mutable Tag target.
- sslEnabled: enable HTTPS. Requires sslCertificateId (SSL cert UUID, NOT PKI cert UUID).
- sslForced: redirect HTTP to HTTPS.
- http2Support: enable HTTP/2.
- websocketSupport: enable WebSocket proxying.
- accessListId: attach an access list for IP/auth restrictions.
- healthCheckEnabled: monitor backend availability.
- advancedConfig: raw nginx config snippet (advanced users only).
- rawConfigEnabled: bypass template rendering and use rawConfig directly.
- rawConfig: custom nginx configuration content (used when rawConfigEnabled is true).
- enabled: toggle the route on/off without deleting.
- folderId: organize into folders.
- nginxTemplateId: use a custom nginx template.

Ordinary list_proxy_hosts and get_proxy_host responses omit rawConfig and rawConfigEnabled. Raw content is only available through explicit raw config read/render tools with raw-read permission.

## Maintenance Mode
- Maintenance mode is available for enabled managed routes that are not using raw config. It keeps the configured HTTP/HTTPS vhosts but returns HTTP 503 and pauses managed health checks until maintenance ends.
- Maintenance state is audited and can feed notification rules and status pages.
- The current Assistant proxy tools do not expose maintenance toggling or Docker upstream fields. Direct the user to the Routes UI or documented REST API instead of trying to emulate maintenance by disabling the route or rewriting its config.

## Docker Upstreams
- The UI and REST API can bind a route to a Docker container by stable name or to a blue/green deployment by deployment ID. Gateway validates a reachable published TCP port and follows deployment slot changes.
- The current Assistant create/update proxy tools support manual upstream fields only. Do not invent Docker-upstream arguments.

## Additional Routes And Secure Links
- Use \`manage_additional_route\` for managed literal path-prefix locations inside a Route. Targets may be manual, Docker container/deployment, or a ready Pages Tag. Docker targets automatically create a route-owned Secure Link binding; edit or delete that binding through the Additional Route.
- Use \`manage_additional_secure_link\` for independent Docker bindings referenced by advanced nginx config. Its list also reports route-owned bindings for visibility, but those cannot be deleted independently.

## Nginx Config
Each route generates an nginx server block on its selected ingress node. Changes are applied by reloading nginx.
Config templates can customize the generated config (see templates topic).

## Raw Config Mode
When rawConfigEnabled is true, the template rendering is bypassed and rawConfig is used directly as the nginx server block. Use get_proxy_rendered_config to view the current config, toggle_proxy_raw_mode to enable/disable, and update_proxy_raw_config to write raw config.`,

  domains: `# Domains

Domains are registered public hostnames with an explicit nginx ingress assignment. DNS may be operator-managed externally or managed through a configured Cloudflare connector.

## Purpose
- Track the A/AAAA target expected from the assigned nginx ingress node public service address
- With external DNS, validate the operator-managed records without mutating the DNS provider
- With Cloudflare, create and reconcile managed A/AAAA records
- Adopt existing matching Cloudflare A/AAAA records without changing their target
- Detect target mismatches before creating routes
- Required for ACME HTTP-01 challenges (domain must resolve to its assigned Nginx ingress)

## Lifecycle
1. Register a domain with an eligible nginx node: create_domain({ domain: "example.com", nginxNodeId: "..." })
2. Gateway resolves the node's effective public ingress address
3. Without Cloudflare, the operator points external DNS to that address and Gateway validates the resolved records
4. With Cloudflare, Gateway resolves the matching zone; it creates missing records or adopts existing matching A/AAAA records as matched_existing
5. If Cloudflare has different A/AAAA records, create_domain returns conflict metadata; overwrite or adopt only after explicit user approval
6. Use manage_domain({ operation: "check_dns", domainId }) to manually re-check resolved DNS
7. Moving ingress is an explicit migration: the domain and its routes move together. Cloudflare-managed DNS is updated during cutover; external DNS must be changed by the operator before completion.

## DNS Records Tracked
- **A**: assigned Nginx node public IPv4 address
- **AAAA**: assigned Nginx node public IPv6 address
- Other record types are not created or overwritten by Gateway domain tools in v1

## Rules
- Domains used by routes cannot be deleted (remove them from routes first)
- isSystem domains (management domains) cannot be deleted
- Wildcard domains (*.example.com) can be registered
- nginxNodeId is optional only when exactly one Nginx node has a detected public address
- Registered domains and their routes must use the same nginx node
- create_domain requires domains:create, and delete_domain requires domains:delete. Those domain permissions include the managed DNS records for the domain
- For matched_existing domains, pass deleteDns=false to keep DNS and remove only the Gateway mapping, or deleteDns=true to remove the adopted Cloudflare records`,

  'access-lists': `# Access Lists

Access lists provide IP-based access control and HTTP basic authentication for ingress routes.

## How It Works
1. Create an access list with IP rules and/or basic auth users
2. Attach it to one or more routes via accessListId
3. Nginx enforces the rules on every request to those routes

## IP Rules
- Array of rules: { type: "allow"|"deny", value: "CIDR or IP" }
- Examples: { type: "allow", value: "10.0.0.0/8" }, { type: "deny", value: "0.0.0.0/0" }
- Rules are evaluated in order — first match wins
- Common pattern: allow specific IPs/ranges, deny all others

## Basic Authentication
- basicAuthEnabled: true to enable HTTP basic auth
- basicAuthUsers: array of { username, password }
- Passwords are hashed with bcrypt before storage in htpasswd format
- Htpasswd files are deployed to nginx nodes via daemon

## Tool Argument Shapes
- create_access_list accepts allowIps and denyIps as string arrays plus basicAuthUsers.
- manage_access_list({ operation: "update", accessListId, ... }) accepts ipRules as ordered { type, value } objects and basicAuthUsers as { username, password } objects.
- Use basicAuthEnabled to turn HTTP basic auth on or off. If it is enabled, provide at least one basic auth user.

## Usage
- One access list can be shared across multiple routes
- Changing an access list automatically updates all routes using it
- Deleting an access list detaches it from all hosts first`,

  templates: `# Certificate Templates

Templates define preset configurations for issuing PKI certificates. They save time and enforce consistency.

## How Templates Work
1. Admin creates a template with desired settings (cert type, key algorithm, validity, key usage, etc.)
2. When issuing a certificate, select the template — its settings become defaults
3. Settings can still be overridden per-certificate at issue time

## Template Fields
- **certType**: tls-server, tls-client, code-signing, email
- **keyAlgorithm**: rsa-2048, rsa-4096, ecdsa-p256, ecdsa-p384
- **validityDays**: default validity period (1-3650 days)
- **keyUsage**: digitalSignature, keyEncipherment, dataEncipherment, keyAgreement, nonRepudiation
- **extKeyUsage**: serverAuth, clientAuth, codeSigning, emailProtection, timeStamping, ocspSigning (plus custom OIDs)
- **requireSans**: whether SANs are mandatory when issuing
- **sanTypes**: allowed SAN types (dns, ip, email, uri)
- **subjectDnFields**: default Organization, OU, Locality, State, Country for the certificate subject
- **crlDistributionPoints**: URLs for CRL download
- **authorityInfoAccess**: OCSP responder URL and CA Issuers URL
- **certificatePolicies**: policy OIDs with optional CPS qualifier URLs
- **customExtensions**: arbitrary X.509 extensions by OID (hex-encoded DER values)

## Built-in Templates
- isBuiltin: true — provided by default, cannot be edited or deleted
- Common presets: TLS Server, TLS Client, Code Signing, Email

## Nginx Config Templates
Separate from certificate templates — these define nginx server block templates for routes.
- Each template has a type: proxy, redirect, or 404.
- Templates use variable syntax ({{variableName}}) for dynamic values
- Can be cloned and customized
- Assigned to routes via nginxTemplateId`,

  acme: `# ACME (Automated Certificate Management)

Let's Encrypt integration for free, automated SSL certificates.

## Issuing an ACME Certificate
1. request_acme_cert({ domains: ["example.com", "www.example.com"], challengeType: "http-01" })
2. Gateway contacts Let's Encrypt, receives a challenge
3. For http-01: Gateway deploys each challenge to the registered domain's assigned Nginx ingress, then Let's Encrypt verifies it
4. For Cloudflare dns-01: use request_acme_cert({ domains, challengeType: "dns-01", dnsProvider: "cloudflare" }); Gateway creates TXT records, verifies, cleans up, and can enable Cloudflare auto-renew.
5. For manual dns-01: Gateway returns { domain, recordName, recordValue } — user creates DNS TXT record, then confirms
6. Certificate is issued and stored as an SSL certificate

## Challenge Types
- **http-01**: Automatic for registered domains with an assigned, online Nginx ingress. Gateway deploys the challenge to that node at \`/.well-known/acme-challenge/\`; the domain must resolve to the node and port 80 must be publicly accessible.
- **dns-01 with Cloudflare**: Automatic when a matching Cloudflare connector/zone is configured. Use dnsProvider: "cloudflare".
- **manual dns-01**: For wildcard certificates (*.example.com) or when port 80 is blocked. Manual step: add a TXT record at \`_acme-challenge.example.com\`. Supports wildcard issuance.

## Auto-Renewal
- Checked daily at 3 AM (configurable via ACME_RENEWAL_CRON setting)
- Renews certificates 30 days before expiry
- Uses the same challenge type as the original issuance
- DNS-01 auto-renew requires Cloudflare and is controlled with manage_ssl_certificate({ operation: "set_auto_renew", sslCertificateId, enabled, provider: "cloudflare" })
- Renewal failures are logged and alerted

## Staging Mode
- ACME_STAGING=true in settings uses Let's Encrypt staging servers
- Certificates are NOT trusted by browsers (for testing only)
- Useful for testing ACME flow without hitting rate limits
- Rate limits: 50 certs per registered domain per week (production)

## Troubleshooting
- **Challenge fails**: Verify domain resolves to your nginx node IP (check Domains page). Ensure port 80 is open and not blocked by firewall.
- **DNS-01 fails**: Verify TXT record is propagated (use dig or nslookup). TTL must be low enough for timely propagation.
- **Rate limited**: Switch to staging for testing. Production limit: 5 duplicate certs per week, 50 per domain per week.
- **Renewal fails**: For HTTP-01, check the assigned ingress node and daemon logs. For Cloudflare DNS-01, check the connector, zone access, and TXT propagation.`,

  users: `# User Management

## Authentication
Gateway can enable OIDC, password, and email one-time-code sign-in independently. Email-based sign-in requires verified SMTP. Users can add passkeys after they sign in; passkeys are not a first-run primary method.
- The browser setup wizard creates exactly one deliberate first administrator in the built-in system-admin group. It does not promote an arbitrary first OIDC login.
- OIDC is configured under Settings > Advanced with an issuer URL, client ID, client secret, auto-provisioning policy, default group, and optional verified-email requirement.
- When OIDC auto-provisioning is enabled, later valid OIDC logins can create users in the configured default group. Existing OIDC users are bound to the provider subject; Gateway may refresh their name and avatar from the provider.
- Password and email-code configuration, recovery flows, passkeys, and first-run choices are described in the authentication topic. Do not claim that OIDC is the only sign-in method.

## Permission Groups
- Every user belongs to exactly one permission group
- Groups define which scopes (permissions) the user has
- **Built-in groups** (cannot be modified): system-admin, admin, operator, viewer, guest
- **Custom groups**: created by admins with any combination of scopes
- **Group nesting**: a group can inherit from one parent group (single level only). Inherited scopes are automatically added to the user's effective scopes.
- Nesting limit: only top-level groups can be parents — a nested group cannot itself have children

## Managing Users
- View all users: list_users
- Change a user's group: update_user_role(userId, groupId) — changes their permissions immediately
- Replace a user's exact additional per-user scopes: set_user_additional_permissions(userId, additionalScopes). Pass [] to reset all additional permissions without changing the user's group. Only grant scopes the acting administrator already has.
- Block or unblock users from the Administration UI, API, or AI Workspace.
- Deleting a user is a soft-delete: their access and tokens are revoked, they are hidden from operational user lists, and historical audit/usage data remains intact. Only a system administrator can restore a deleted user, and restore leaves them blocked until explicitly unblocked.

## User Fields
- id, email, name, avatarUrl, groupId, groupName, groupScopes, additionalScopes, scopes, isBlocked, isDeleted
- lastLoginAt, loginCount, createdAt`,

  audit: `# Audit Log

All significant actions are logged.
- Fields: userId, action, resourceType, resourceId, details (JSON), ipAddress, userAgent, createdAt.
- Actions follow pattern: "resource.action" (e.g., "ca.create", "cert.revoke", "proxy.update").
- AI-initiated actions have details.ai_initiated: true.
- Query with get_audit_log: filter by action, resourceType, pagination.
- Housekeeping can auto-delete old entries (configurable retention).
- SIEM audit export is a separate privacy-reduced delivery stream. Its receiver never receives full audit details, user agents, resource names, secrets, or collector response bodies. See the siem topic for its lifecycle and tools.`,

  siem: `# SIEM Audit Export

## Purpose
When enabled in Gateway general settings, Gateway can export privacy-reduced audit events to up to five active HTTPS SIEM collectors. This is an outbound push integration: Gateway sends batches to the collector; it does not expose a webhook for the collector to call.

## Safe Event Contract
Each event contains an id, a stable Gateway installation source identifier, type \`com.wiolett.gateway.audit.v1\`, ISO timestamp, action, optional actor id/email, resource type/id, and source IP. Never claim that full audit \`details\`, resource display names, user agents, secrets, credentials, raw request payloads, or collector response bodies are exported.

## Destination Security
- Endpoint URLs must be HTTPS and must not include userinfo, query parameters, or fragments.
- The existing outbound-webhook network policy validates and pins DNS addresses to protect against SSRF and rebinding. Redirects are not followed.
- Every destination uses a bearer token, HMAC-SHA256, or one validated custom HTTP header. The secret or custom header value is encrypted at rest and is never returned by API, UI, tools, logs, audit entries, or assistant responses.
- Custom headers cannot replace Gateway transport headers such as \`Host\`, \`Content-Type\`, or the \`X-Gateway-*\` headers. A custom Authorization header is allowed when a collector requires a non-Bearer scheme.
- HMAC sends \`X-Gateway-Timestamp\` and \`X-Gateway-Signature-256\` for \`timestamp + "." + rawBody\`; bearer uses the standard Authorization header.

## Delivery Lifecycle
- Audit writes and queued SIEM records are created in one database transaction; the request path never sends HTTP.
- The in-process scheduler claims rows with database leases and sends a JSON body \`{ schemaVersion: 1, events: [...] }\`.
- 2xx completes delivery. Network errors, 408, 429, and 5xx retry at 30s, 2m, 8m, 30m, 2h, 6h, and 12h, for at most eight attempts. Other 4xx responses fail terminally.
- Disabling SIEM in Gateway general settings prevents new outbox rows and pauses delivery; destinations, history, and queued records stay intact until SIEM is enabled again.
- Disabling a destination pauses outstanding work; enabling resumes it. Deleting a destination soft-deletes configuration and discards outstanding work. Only failed deliveries can be manually requeued.
- A test sends a synthetic \`com.wiolett.gateway.audit.test.v1\` event only: it creates no audit row and no queued delivery.
- Terminal delivery history follows Audit Log retention. Do not use notification-webhook delivery semantics for SIEM.

## AI Tools
- SIEM tools are unavailable while \`generalSettings.features.siemEnabled\` is false.
- Read: \`list_siem_destinations\`, \`get_siem_destination\`, \`list_siem_deliveries\`, \`get_siem_delivery\` require \`audit:siem:view\`.
- Change: \`create_siem_destination\`, \`update_siem_destination\`, \`delete_siem_destination\`, \`test_siem_destination\`, and \`requeue_siem_delivery\` require \`audit:siem:manage\` and go through normal tool approval.
- Request a secret only when the caller explicitly wants to create or replace a destination. Treat it as one-time input and never echo it.`,

  nginx: `# Nginx Ingress Management

Gateway manages public ingress through nginx daemon nodes running on remote servers. The Gateway relay on port 9443 is the daemon control-plane transport; it is not an HTTP/TLS ingress for published applications.

## Architecture
- Each nginx node runs a Go daemon (\`nginx-daemon\`) alongside the host's native nginx installation
- A dedicated Gateway relay communicates with daemons over gRPC (port 9443) with mutual TLS; the application uses an internal service-mTLS control-plane hop
- Domains and routes are assigned to specific nginx nodes. A registered domain and every route using it must share the same node.
- Each route config is generated by Gateway and pushed to its selected ingress daemon
- The daemon writes the config files, tests with \`nginx -t\`, and reloads nginx gracefully

## Config Management
- Route configs are generated from templates and written to the nginx \`conf.d/sites/\` directory
- Each route becomes one nginx server block file
- Changes are atomic: write → test → reload (rollback on test failure)
- Global nginx.conf can be viewed and edited from the node detail page (Configuration tab)

## Config Templates
- Nginx templates define the server block structure for routes
- Built-in templates for common patterns (reverse proxy, redirect, etc.)
- Custom templates support variables: \`{{variableName}}\` replaced at render time
- Assigned to routes via nginxTemplateId — default template used if none specified

## Raw Config Mode
- When rawConfigEnabled is true on a route, the template rendering is bypassed entirely
- The rawConfig field is used directly as the nginx server block content
- Useful for complex configurations that templates can't express
- Ordinary route list/detail responses omit rawConfig and rawConfigEnabled
- Raw content can only be read through explicit raw config read/render paths with raw-read permission
- Requires proxy:raw:toggle and proxy:raw:write scopes
- proxy:raw:bypass can bypass dangerous raw directive validation for the same route
- Use get_proxy_rendered_config to see the current generated config before switching to raw mode

## Monitoring
- **Stub status**: nginx stub_status module provides active connections, accepts, handled, requests, reading, writing, waiting
- **Access log parsing**: traffic stats by status code, response times, bandwidth
- **Health checks**: per-route backend health monitoring (configurable URL, interval, expected status)
- **Nginx logs**: access and error logs streamed via daemon, viewable per route or per node

## SSL/TLS
- SSL certificates are stored canonically by Gateway and deployed as node-local replicas only to ingress nodes with enabled TLS routes using them
- Config includes ssl_certificate and ssl_certificate_key directives
- HTTP/2 support togglable per route
- OCSP stapling enabled by default when CA chain is available`,

  nodes: `# Nodes (Daemon Management)

Nodes are remote servers running Gateway daemons. Each daemon type manages different infrastructure.

## Node Types
- **nginx**: Ingress node — runs nginx and manages route configs, TLS replicas, access lists, public traffic, logs, and stats. Requires nginx installed on the server.
- **monitoring**: Lightweight system monitoring agent — reports CPU, memory, disk, load, network. No nginx required. Useful for any server you want to monitor.
- **docker**: Container management node — manages Docker containers, images, volumes, networks. Requires Docker installed. Provides container console (exec), file browser, log streaming, environment/secrets management.
- **databases**: Restricted docker-daemon profile for Gateway-managed Postgres, Redis, and ClickHouse only. It runs as root, validates ext4 image storage before enrollment, and rejects generic Docker workloads.

## How to Enroll a New Node (Step by Step)

### Step 1: Create the node in Gateway UI
Go to **Nodes** page → click **Enroll Node** → select the node type (nginx, docker, databases, or monitoring) → optionally set a display name → click **Create**. This generates a **one-time enrollment token**, the Gateway gRPC certificate fingerprint, and setup commands.

### Step 2: Run the setup script on the target server
The UI shows ready-to-copy commands. Run one of these on the target server as root:

For **nginx** nodes:
\`\`\`bash
curl -sSL https://gitlab.wiolett.net/wiolett/gateway/-/raw/main/scripts/setup-node.sh | sudo bash -s -- \\
  --gateway <gateway-host>:9443 --token <enrollment-token> --gateway-cert-sha256 sha256:<gateway-cert-fingerprint>
\`\`\`

For **docker** nodes:
\`\`\`bash
curl -sSL https://gitlab.wiolett.net/wiolett/gateway/-/raw/main/scripts/setup-docker-node.sh | sudo bash -s -- \\
  --gateway <gateway-host>:9443 --token <enrollment-token> --gateway-cert-sha256 sha256:<gateway-cert-fingerprint>
\`\`\`

For **database** nodes, run setup-database-node.sh with the generated Gateway address, enrollment token, and certificate fingerprint. The interactive installer selects an eligible local storage root before enrollment. For automation, pass --storage-root <path> and --yes; database nodes always run the restricted docker-daemon profile as root. Before enrollment, the installer verifies the local Docker Engine and the complete fixed-size ext4 image lifecycle, including loop attach, mount/write, growth, resize, unmount, and detach. An LXC host must receive loop-control, a loop-device pool, and mount permission from its outer host; there is no unbounded-volume fallback.

For **monitoring** nodes:
\`\`\`bash
curl -sSL https://gitlab.wiolett.net/wiolett/gateway/-/raw/main/scripts/setup-monitoring-node.sh | sudo bash -s -- \\
  --gateway <gateway-host>:9443 --token <enrollment-token> --gateway-cert-sha256 sha256:<gateway-cert-fingerprint>
\`\`\`

The setup script:
1. Downloads the daemon binary to \`/usr/local/bin/<type>-daemon\`
2. On a fresh generic Docker node, preflights and attempts to install the optional Secure Runtime before enrollment. Database-profile nodes skip this generic-workload runtime.
3. Creates config at \`/etc/<type>-daemon/config.yaml\` with the gateway address, token, and certificate fingerprint
4. Creates a systemd service and enables it
5. Starts the daemon — it connects to the gateway and completes mTLS enrollment automatically

### Step 3: Verify connection
The node status changes from **pending** to **online** in the Nodes list once the daemon connects. The enrollment token is invalidated after first use.

## Assistant Tools
- list_nodes: list daemon nodes visible to the current user.
- get_node: inspect one node.
- execute_node_console_command: run one argv-style command on a node console. Use { nodeId, command: ["sh","-lc","..."] }. This is destructive, requires nodes:console, is available to MCP only when that OAuth scope is explicitly granted, and catastrophic patterns such as rm -rf / are blocked.
- create_node, rename_node, delete_node: manage node records.
- manage_node_config: read/update/test nginx node config. Use { operation: "read"|"update"|"test", nodeId, content? }. read requires nodes:config:view:<nodeId>; update/test require nodes:config:edit:<nodeId>. This tool is browser-session-only and is not available to MCP tokens.
- manage_node_file: manage node filesystem paths. This tool is browser-session-only and is not available to MCP tokens.

### Alternative: Manual installation
If you cannot use the setup script, you can install manually. Database nodes are the exception: they use docker-daemon in its databases profile and require the database installer storage preflight.
1. Download the daemon binary and place it at \`/usr/local/bin/<type>-daemon\`
2. Run: \`<type>-daemon install --gateway <host>:9443 --token <token> --gateway-cert-sha256 sha256:<gateway-cert-fingerprint>\`
   This creates the config file and systemd service automatically.
3. Enable and start: \`systemctl enable --now <type>-daemon\`

## Connection & Communication
- Daemons connect to the gateway via **gRPC on port 9443** with mutual TLS (mTLS).
- The gateway pushes commands to daemons: apply config, deploy certs, health check, log streaming, exec, etc.
- The daemon sends back: health reports (every 30s), command results, log entries, exec output.
- Daemons auto-reconnect on disconnect with exponential backoff (1s → 60s).
- mTLS certificates auto-renew when within 7 days of expiry.

## Console (Interactive Shell)
All node types support an interactive console — a PTY shell session on the host OS.
- Accessed via the **Console** tab on the node detail page.
- Requires \`nodes:console\` scope.
- Supports popout window, reconnection with output replay, and terminal resize.
- Shell auto-detected from \`/etc/shells\` (prefers bash > zsh > ash > sh).
- Can be configured to run as a specific OS user via \`console.user\` in daemon config.
- The assistant has a separate one-shot \`execute_node_console_command\` tool for command execution when regular Gateway read/manage tools cannot answer the request. Prefer argv commands such as \`["sh","-lc","systemctl status nginx"]\`.
- Treat every console command as destructive: risky commands require explicit approval and obviously host-breaking commands are blocked before reaching the daemon.
- Use console tools for host-level inspection or repair only after identifying the exact node with get_current_context or find_resource. Do not guess node IDs from chat text.

## System Information
Daemons report hardware/OS info on registration:
- CPU model, core count, architecture (amd64, arm64)
- Kernel version, hostname, OS info
- Uptime, file descriptor usage
- Disk mounts with usage percentages
- Network interfaces with RX/TX stats

## Monitoring & Health
- **Health reports** (every 30s): CPU%, memory, disk, load average, swap, network I/O, open FDs.
- Daemons report localIpAddresses and publicIpAddresses. Docker nodes may set serviceAddress explicitly; otherwise Gateway uses the first reported local address and then a public address for cross-node/proxy-upstream traffic.
- **Nginx nodes** additionally report: nginx status, uptime, worker count, error rates (4xx/5xx), stub status stats.
- **Docker nodes** additionally report: container count (running/stopped/total), per-container CPU/memory/network stats, Docker version.
- Generic Docker nodes report Secure Runtime state, version, setup progress, and compatibility. Existing nodes expose manual Setup in Node Details to administrators with \`admin:update\`; do not attempt remote installation through a console unless the user explicitly asks for host-level repair.
- **Traffic stats** (nginx only): parsed from access logs — status code distribution, response times.
- Background polling at 10s intervals; 5s when a user is actively viewing the node detail page.

## Node Management
- **Rename**: change display name (does not affect hostname).
- **Delete**: removes the node from Gateway. The daemon will fail to reconnect (mTLS cert becomes invalid).
- **Pin to sidebar**: quick-access link in the sidebar navigation.
- **Default node**: one nginx node can be marked as default — used for proxy operations when no specific node is selected.

## Key Fields
- id, hostname, displayName, type, status (pending/online/offline/error)
- serviceAddress (optional Docker reachability override)
- lastSeenAt, capabilities (daemon version, features, system info)
- certificateSerial (mTLS cert), enrollmentTokenHash
- metadata (extensible metadata object)`,

  housekeeping: `# Housekeeping

Automated cleanup tasks, configurable in Settings.
- Schedule: cron expression (default: "0 2 * * *" — 2 AM daily).
- Tasks:
  - Nginx Logs: rotate/compress/delete old log files. Retention in days.
  - Audit Log: delete entries older than retention days.
  - Dismissed Alerts: remove old dismissed alerts.
  - Delivery Log: delete old notification delivery attempts.
  - Structured Logs: cap ClickHouse application logs by total rows and approximate disk size while preserving the newest daily partition.
  - ClickHouse Internals: monitor high-volume system logs and, when enabled, trim supported internal tables during manual Housekeeping runs and the five-minute health guard. Enable it only for a ClickHouse instance dedicated to Gateway.
  - Orphaned AI Artifacts: delete files no longer attached to a chat.
  - Orphaned Certs: remove unreferenced certificate files.
  - ACME Challenges: clean up old validation tokens.
  - Docker Prune: remove unused Docker images.
- Can be triggered manually from Settings page.
- Run history tracked (last N runs with per-category results).

## Permissions
- \`housekeeping:view\` — read config, stats, and run history.
- \`housekeeping:run\` — trigger a manual run.
- \`housekeeping:configure\` — edit config and schedule.`,

  permissions: PERMISSIONS_DOC,

  docker: `# Docker Container Management

## Overview
Gateway provides Portainer-like Docker container management through a daemon running on Docker hosts. Docker tools still require a nodeId, while container permissions can be granted for the whole node or narrowed to one standalone container or blue/green deployment.

## Granular Access
- Every standalone container has a Gateway-managed stable access identity; every blue/green deployment uses its stable deployment ID.
- A node-level \`docker:containers:*\` grant covers every container and deployment on that node. A child-level grant covers only the selected container or deployment.
- Child grants are enforced consistently by the UI, REST routes, WebSockets, proxy Docker upstream resolution, AI tools, and MCP tools. Lists omit inaccessible resources.
- Recreating or updating an existing container preserves its stable access identity and grants even though the Docker runtime ID changes.
- Migrating a container or deployment to another node moves its child grants to the target node during metadata cutover.
- Explicitly deleting a container or deployment removes its child grants. A later resource with the same name does not inherit them.

## Container Lifecycle
- **Create**: Deploy from image with ports, volumes, env, networks, restart policy
- **Start/Stop/Restart/Kill**: Lifecycle management (transitions tracked as tasks)
- **Recreate**: Stop + remove + create with new config (preserves name, secrets auto-injected)
- **Duplicate**: Clone a container with a new name (secrets are copied too)
- **Remove**: Delete container (must be stopped first)

Before creating a container, list images on the selected node. If the requested image is absent, pull it and wait for the pull task to complete before calling create; do not use a failed create as an image-existence probe. Public Docker Hub images are pulled directly without a saved registry or \`registryId\`.

## Recreated Containers and Stale IDs
Docker container IDs are volatile. Recreate, image update, webhook rollout, or config changes can remove the old
container and create a new one with the same semantic workload/name. If a Docker tool returns "No such container",
do not conclude the workload is deleted. Use \`find_resource\` with the last known container name, nodeId, image, or
other stable hint to locate the recreated container and continue with its new ID.

## Environment Variables & Secrets
- Regular env vars: stored in container config, visible to all users with view access
- Secrets: encrypted at rest in Gateway DB, injected as env vars on container start/recreate. Only users with docker:containers:secrets scope can view decrypted values. Secrets are keyed by container name so they survive recreates.

## Image Updates & Webhooks
- **Manual image tag change**: in container Settings, the Image Tag field allows changing the version. Changing the tag and clicking Recreate will pull the new image and recreate the container.
- **Webhook updates**: each container can have a webhook URL enabled (Settings → Webhook section). CI pipelines POST to the webhook URL to trigger automatic pull + recreate. URL format: \`POST /api/webhooks/docker/<token>\` with optional body \`{"tag":"v1.2.3"}\`. No auth header needed — the token in the URL is the auth.
- **Auto-cleanup**: webhook config supports automatic cleanup of old image versions after updates, with configurable retention count.
- Webhook configuration requires the \`docker:containers:webhooks\` scope.
- Use \`update_docker_container_image\` tool to change a container's image tag programmatically (pulls + recreates).

## Blue/Green Deployments
- Deployments are Gateway-managed blue/green services with a stable deployment ID, active slot, inactive slot, router, routes, health checks, and release history.
- Managed deployment containers are protected. Do not start, stop, restart, kill, remove, rename, or update the underlying slot container directly.
- Use \`list_docker_deployments\` and \`get_docker_deployment\` to find the deployment ID, active slot, routes, and health.
- Use \`start_docker_deployment\`, \`stop_docker_deployment\`, \`restart_docker_deployment\`, \`kill_docker_deployment\`, \`deploy_docker_deployment\`, \`switch_docker_deployment_slot\`, \`rollback_docker_deployment\`, and \`stop_docker_deployment_slot\` for deployment-safe lifecycle operations.
- To roll out a new image or tag for a deployment, use \`deploy_docker_deployment\` instead of \`update_docker_container_image\`.

## Settings
- **Runtime (live-update)**: restart policy, memory limit, CPU shares, PID limit — applied without recreation
- **Requires recreate**: port mappings, volume mounts, entrypoint, command, stop grace period, working dir, hostname, labels, image tag
- **Stop grace period**: container-level Docker stop timeout in seconds (0-300). Stop/restart tools use this configured value when no explicit timeout is supplied, falling back to 20 seconds.

## Isolation Profiles
- **Default** uses Docker \`runc\` for standard compatibility and GPU/device support.
- **Secure** uses gVisor \`runsc\` for a stronger host-isolation boundary. It is not a virtual machine or a promise of universal Linux syscall compatibility.
- Secure can be selected only when the target node reports a healthy Secure Runtime state. Creation fails closed while setup is unknown, installing, unhealthy, or unsupported; direct the administrator to **Node Details > Secure Runtime Setup**.
- Secure Runtime needs no KVM. It supports compatible Linux amd64/arm64 hosts with a local, restartable Docker Engine. Compatible LXC guests can work when nested Docker and the required host capabilities are available; do not claim universal LXC support.
- Secure workloads cannot attach GPUs or devices, use host bind mounts, migrate between nodes, or export as \`.gwca\` archives. Changing profile recreates the workload.
- Every newly created Gateway workload in either profile is non-privileged, adds no Linux capabilities, and receives \`no-new-privileges\`.

## Images, Volumes, Networks
- Images: list, pull from registries, remove, prune unused
- Volumes: create produces a Gateway-managed local volume with no custom driver. New or changed mounts can reference only Gateway-managed local volumes; never propose a host bind path.
- Existing legacy mounts remain unchanged during ordinary updates. A legacy volume can be adopted in the UI only when it uses the local driver, local scope, and no driver options. Orphaned unmanaged volumes are hidden.
- Networks: list, create, remove, connect/disconnect containers

## Inventory Availability
- Gateway keeps sanitized container, deployment, image, volume, and network inventory snapshots. Read views can show the last synchronized state while a Docker node is offline or refreshing.
- Treat snapshot availability metadata as authoritative. Do not attempt mutations against unavailable resources; explain that the node must reconnect before Gateway can change them.

## Cross-Node Migrations
- Gateway can migrate a standalone container or a blue/green deployment to another Docker node, including referenced images, named-volume data, capacity preflight, verification, proxy cutover, cancellation, and cleanup recovery.
- Secure Runtime workloads and GPU-attached workloads are not eligible for cross-node migration in the current version.
- Migration requires \`docker:containers:migrate\` plus the source-resource permissions needed to inspect protected configuration, secrets, and mounts.
- Use \`manage_docker_migration\` to preflight first, start with the returned fingerprint, inspect progress, cancel before cutover, or retry cleanup. Never start without a blocker-free current preflight.
- Container archive export requires \`docker:containers:export\` plus file and environment access for the source container. Secret values are included only when the caller also has \`docker:containers:secrets\`. Secure Runtime workloads and containers with host bind mounts cannot be exported. Import rejects host bind mounts and accepts existing volume selections only from safe Gateway-managed local volumes.

## Registries & Templates
- Registries: add private Docker registries with encrypted credentials. Global or node-specific scope.
- Templates: save container configurations as reusable templates for quick deployment

## Tasks
Long-running operations (stop, restart, kill, recreate, update) create tasks visible on the Tasks page. Tasks track progress and completion status.

## Console & Files
- Console: interactive terminal (exec) into running containers via xterm.js WebSocket
- Assistant console command: \`execute_docker_container_console_command({ nodeId, containerId, command: ["sh","-lc","..."], user? })\` runs one command in a container when ordinary Docker tools do not cover the needed inspection or repair. It requires \`docker:containers:console\`, is destructive, is available to MCP only when that OAuth scope is explicitly granted, and blocks catastrophic patterns such as \`rm -rf /\`.
- Before using container console, resolve the current container through get_current_context or find_resource. Container IDs can change after recreate, so re-check by name when a command reports "No such container".
- File browser: navigate filesystem, view/edit files inside containers

## Key Notes
- Most Docker tools require a nodeId parameter. If the user names a container/image/volume/network, use find_resource first; it returns nodeId with the match. Use list_nodes with type="docker" only when you specifically need to choose or inspect Docker nodes.
- Container IDs change after recreate/update — the frontend handles navigation to new IDs
- Transition states (stopping, restarting, recreating, deploying, switching, etc.) block concurrent operations on the same container or deployment`,

  databases: `# Databases

## Overview
Gateway supports two database resource models:
- **External connections** store operator-supplied connection details and are operated directly by the backend.
- **Managed instances** run curated Postgres, Redis, or ClickHouse images on a dedicated database node. They are private by default and use daemon-managed storage.

Managed database instances are not generic Docker workloads. The database node only runs Gateway-managed database containers.

## Managed Instance Access
- A managed instance has no published host port by default. Application bindings use the private connector and authenticated Gateway tunnel; do not substitute direct TCP for a binding.
- The tunnel terminates in Gateway's separate long-lived relay container. Ordinary app-only updates keep established binding traffic running; a red relay warning is a critical operator state after bounded automatic recovery fails, not a reason to publish a replacement port.
- A TCP endpoint is an independent, explicit publication option for infrastructure outside Gateway. It requires engine authentication and may not be tunnel-encrypted unless the database engine is configured with TLS. Gateway does not change host firewalls automatically.
- Each application binding gets a separate engine identity. Its URI and optional host/port/database/user/password environment values are injected into the selected application; do not reveal, log, or copy those values unless an explicit secret-reveal flow permits it.
- Assistant and MCP flows use \`manage_managed_database\` for catalog/list/get/create/update/retry/delete, restart/pause/unpause, certificate rotation, and workload binding lifecycle. Read the catalog before create, keep instances private unless the user explicitly requests publication, poll get until ready, then create a container or deployment binding. Credential reveal and credential rotation remain outside this tool; never reveal owner or binding credentials.

## Providers
- **Postgres**: schema/table explorer, paginated row browser, row insert/update/delete for PK-backed tables, SQL console, monitoring.
- **Redis**: key browser, type-aware viewer/editor for common types (string, hash, list, set, zset), Redis command console, monitoring.

## Credentials
- Connection credentials and managed owner credentials are encrypted at rest in the Gateway database using the same envelope-encryption primitive used for Docker secrets and PKI keys.
- Raw credentials are hidden by default. Revealing an explicitly requested credential requires the \`databases:credentials:reveal\` scope. Binding-injected credentials remain hidden by default.
- Team members can operate databases through Gateway without being given the raw hosting credentials.

## Permissions
- \`databases:view\`, \`databases:create\`, \`databases:edit\`, \`databases:delete\` govern both external connections and managed instances/bindings; no new managed-database scope is introduced.
- \`databases:query:read\`, \`databases:query:write\`, \`databases:query:admin\`; AI/MCP query tools also require \`databases:view\` on the same database.
- \`databases:credentials:reveal\`
- Most database scopes are resource-scopable by database ID, so access can be limited per saved connection.

## Monitoring
- Gateway stores short rolling metric history for database sparklines and persists health-history entries for health bars. Managed lifecycle and health notifications contain only the database ID, display name, engine, and safe status; never credentials, connection URIs, generated aliases, or daemon errors.
- Postgres metrics include latency and active connection utilization.
- Redis metrics include latency and memory utilization.

## Audit
- Connection CRUD, connection tests, credential reveals, data mutations, and console executions are audit logged.
- Query text and command text are sanitized and truncated in the audit log to avoid leaking secrets.`,

  pages: `# Pages

Pages serves immutable static Deployments owned by a Page Project. Use \`find_resource({ types: ["page_project"] })\` and \`manage_pages\` for profile, project, deployment, Tag, deploy-token, migration, pinning, retention, and runtime-config operations.

## Workflow
- The Pages profile must be licensed and enabled. A Project is placed on one Pages-capable node and can be migrated with \`project_migrate\`.
- Artifact bytes are uploaded through the resumable Pages deploy API; \`manage_pages\` operates deployment metadata and publication, not local archive bytes.
- Deploy tokens can be listed, created, and revoked with \`manage_pages\`. A newly created raw token is returned once; do not repeat it in later chat messages, notifications, or logs.
- Deployments are immutable. Mutable Tags point at ready Deployments. Ingress Routes and Additional Routes target a Tag, never an immutable Deployment.
- Runtime configuration is a JSON object exposed as \`window.runtime.config\`. Save a default config or a Tag override; deleting a Tag also removes its override.
- Disabling Pages stops immutable preview publication but existing Tag routes and stored content continue to work.

Required scopes are under \`pages:*\`; profile changes require \`pages:settings:*\`. Never bypass the Pages entitlement or daemon capability checks.`,

  postgres: `# Postgres in Gateway

## Explorer
- Schemas and tables are discovered from \`information_schema\`.
- Row editing in the visual explorer requires a primary key. Tables or views without a PK are browse-only in the explorer.
- Explorer pages are paginated; use the SQL console for advanced filtering or bulk operations.

## SQL Console
- One or more SQL statements can be executed per request.
- Read, write, and admin statements are separated by permissions: \`databases:query:read\`, \`databases:query:write\`, and \`databases:query:admin\`. AI/MCP execution also requires \`databases:view\` for the target saved connection.

## Monitoring
- Health is based on connectivity and latency.
- Metrics include \`latency_ms\`, \`active_connections\`, \`max_connections\`, \`active_connections_pct\`, and \`database_size_bytes\`.`,

  redis: `# Redis in Gateway

## Explorer
- Keys are discovered with \`SCAN\`, not \`KEYS\`, so the browser can safely handle large keyspaces.
- Visual editing supports string, hash, list, set, and zset.
- Streams are browse-only in the visual explorer; use the command console for advanced stream operations.

## Command Console
- One or more Redis commands can be executed per request.
- Read, write, and admin commands are permission-gated by \`databases:query:read\`, \`databases:query:write\`, and \`databases:query:admin\`. AI/MCP execution also requires \`databases:view\` for the target saved connection.

## Monitoring
- Health is based on connectivity and latency.
- Metrics include \`latency_ms\`, \`used_memory_bytes\`, \`maxmemory_bytes\`, \`memory_pct\`, \`connected_clients\`, and \`instantaneous_ops_per_sec\`.`,

  logging: `# External Logging

Gateway can ingest structured logs from external services into ClickHouse-backed logging environments.

Before creating environments or schemas, call \`manage_logging_backend\` with \`get\`. If logging is disabled on an empty Gateway, ask whether to provision Gateway-managed local ClickHouse or use an existing external ClickHouse, then apply the chosen backend before continuing.

Per-environment retention TTL is complemented by optional Housekeeping caps for total rows and approximate disk size. ClickHouse also has an internal-log safety budget and health guard. Enable ClickHouse Internals in Housekeeping to allow cleanup of supported system tables, and only do so for an instance dedicated to Gateway. Users with housekeeping access see storage pressure on the Dashboard.

## Resource Types
Use manage_logging with singular resource names:
- Environments: { resource: "environment", operation: "list"|"get"|"create"|"update"|"delete" }
- Schemas: { resource: "schema", operation: "list"|"get"|"create"|"update"|"delete" }
- Ingest tokens: { resource: "token", operation: "list"|"create"|"delete", environmentId }
- Logs: { resource: "logs", operation: "search", environmentId, payload }
- Facets: { resource: "facets", operation: "facets", environmentId, payload }
- Metadata: { resource: "metadata", operation: "metadata", environmentId }

## Important Tool Argument Rules
- Canonical tool resources are singular: "environment", "schema", "token". Do not copy plural REST nouns like "schemas" unless you have to; use the singular canonical form.
- Create/update/search bodies go in payload, not at the top level.
- Use find_resource({ query, types: ["logging_environment"] }) or find_resource({ query, types: ["logging_schema"] }) when the user names an environment/schema and you need its ID.

## Schema Payload
\`\`\`json
{
  "resource": "schema",
  "operation": "create",
  "payload": {
    "name": "Application Logs",
    "slug": "application-logs",
    "description": "Structured application events",
    "schemaMode": "loose",
    "fieldSchema": [
      { "key": "service", "location": "label", "type": "string", "required": true },
      { "key": "durationMs", "location": "field", "type": "number", "required": false }
    ]
  }
}
\`\`\`

schemaMode:
- loose: accept unknown labels/fields
- strip: drop unknown labels/fields
- reject: reject events with unknown labels/fields

fieldSchema entries:
- key: safe key matching letters/numbers/underscore/dot/dash rules
- location: "label" or "field"
- type: labels must be "string"; fields can be "string", "number", "boolean", "datetime", or "json"
- required: whether every event must include the key

## Environment Payload
\`\`\`json
{
  "resource": "environment",
  "operation": "create",
  "payload": {
    "name": "Production",
    "slug": "production",
    "enabled": true,
    "schemaId": null,
    "schemaMode": "reject",
    "retentionDays": 30,
    "fieldSchema": []
  }
}
\`\`\`

## Searching Logs
\`\`\`json
{
  "resource": "logs",
  "operation": "search",
  "environmentId": "<logging environment UUID>",
  "payload": {
    "query": "error",
    "limit": 100,
    "services": ["gateway-backend"],
    "sources": ["codex-smoke"]
  }
}
\`\`\`

## Ingest Tokens
- Create tokens with { resource: "token", operation: "create", environmentId, payload: { name, expiresAt? } }.
- The raw token is shown only once. Do not expose it unless the user explicitly needs to configure an ingest client.`,

  folders: `# Foldered Resources

Gateway uses shared folder views for several resource lists. Use folder tools instead of guessing REST paths.

## Tools
- list_resource_folders({ resourceType, dockerResourceType? }) lists folders and visible assignments.
- manage_resource_folder({ resourceType, operation, ... }) mutates folder trees and item placement.

## Resource Types
- nodes
- databases
- domains
- logging_environments
- logging_schemas
- admin_users
- permission_groups
- proxy_hosts
- docker with dockerResourceType: container, image, network, or volume

## Operations
- create: { name, parentId? }
- update: { folderId, name?, parentId? }
- delete: { folderId }
- reorder_folders: { items: [{ id, sortOrder }] }
- move_resources: { folderId, resourceIds }
- reorder_resources: { items: [{ id, sortOrder }] }
- move_folder is supported only where the underlying resource service supports moving folders.

## Scope Rules
- nodes: list with nodes:details or nodes:folders:manage; mutate with nodes:folders:manage.
- databases: list with databases:view or databases:folders:manage; mutate with databases:folders:manage.
- domains: list with domains:view; mutate with domains:folders:manage.
- logging_environments: list with logs:environments:view, logs:environments:folders:manage, or logs:manage; mutate with logs:environments:folders:manage or logs:manage.
- logging_schemas: list with logs:schemas:view, logs:schemas:folders:manage, or logs:manage; mutate with logs:schemas:folders:manage or logs:manage.
- admin_users: list with admin:users or admin:users:folders:manage; mutate with admin:users:folders:manage.
- permission_groups: list with admin:groups or admin:groups:folders:manage; mutate with admin:groups:folders:manage.
- proxy_hosts: list with proxy:view or proxy:folders:manage; mutate folders with proxy:folders:manage; moving hosts also checks proxy:edit for each host.
- docker: list uses dockerResourceType-specific view scope: docker:containers:view, docker:images:view, docker:networks:view, or docker:volumes:view. Folder mutation uses docker:containers:folders:manage. Moving or reordering container placements also checks docker:containers:edit for each item node; image, network, and volume placement follows the shared Docker folder route and does not require container edit scope.`,

  'node-files': `# Node File Management

Use manage_node_file for node filesystem operations. This works through the node daemon and follows the same validation as the node Files UI.

## Operations
- list: { nodeId, operation: "list", path? }
- read: { nodeId, operation: "read", path, encoding?: "auto"|"utf8"|"base64", limitBytes? }
- write: { nodeId, operation: "write", path, content? or contentBase64? }
- create: { nodeId, operation: "create", path, content? or contentBase64? }
- mkdir: { nodeId, operation: "mkdir", path }
- delete: { nodeId, operation: "delete", path }
- move: { nodeId, operation: "move", fromPath, toPath }
- upload_init: { nodeId, operation: "upload_init", path, totalBytes }
- upload_chunk: { nodeId, operation: "upload_chunk", uploadId, offset, contentBase64 }
- upload_complete: { nodeId, operation: "upload_complete", uploadId, path, totalBytes }
- upload_abort: { nodeId, operation: "upload_abort", uploadId }

Read output is capped and returns { encoding, content, sizeBytes, returnedBytes, truncated }. Use base64 for binary files.`,

  sandbox: `# Sandbox Runner

Sandbox tools run bounded commands in Docker containers owned by the current user. They are AI-only and intentionally not exposed through MCP.

## Execution Tools
- execute_script: run a short script in a fresh container, return output, then remove the container.
- run_process: start a longer process with a TTL.
- read_process_output: read stdout/stderr from a running process.
- write_process_stdin: send stdin to a running process.
- kill_process: stop a running sandbox process.
- list_sandbox_jobs: list current user's running sandbox jobs.

## Network and Artifacts
Sandbox containers have no direct network access. Use Gateway-mediated helpers:
- fetch: read network content through Gateway, capped at 10 MB.
- download_artifact: download a URL through Gateway and place it in a running sandbox under /workspace, capped at 200 MB.
- list_artifact_files: list files/directories already present in a running sandbox workspace without starting another process.
- read_artifact: read a file from the sandbox in chunks, capped per read.
- send_artifact: save a sandbox file as a Gateway-managed downloadable artifact for the user.

Artifact path rules:
- The sandbox process working directory is /workspace.
- Files that must be read_artifact or send_artifact must be written under /workspace.
- Artifact tool path arguments are relative to /workspace. Example: write /workspace/report.txt, then send_artifact with path "report.txt".
- If a sandbox-backed tool returns a processId and path, use list_artifact_files and read_artifact with that same processId/path to inspect files; do not launch another run_process just to run ls/find/os.walk/cat.
- Do not write deliverable files under /tmp, and do not pass absolute paths such as "/workspace/report.txt" or relative paths like "tmp/report.txt" for files created in /tmp.
- run_process returns as soon as the process starts. If a file is created by a running process, wait briefly and verify it with read_process_output or read_artifact before send_artifact.

When send_artifact succeeds, do not print the download URL in a markdown table or manual link. The chat UI automatically attaches the file card from the tool result; respond with a short confirmation such as "Attached the file."

Resource tiers are low, medium, and high. TTL is capped by tier. The agent may request ttlSeconds but cannot exceed the tier cap.`,

  conversations: `# Work Sessions and AI Workspace

AI conversations are stored on the backend. Tool discovery is conversation-scoped, so discovered toolsets remain available when returning to a saved conversation.

## Provider State
- The selected provider model and reasoning effort are pinned to the conversation when its first run starts.
- A model cannot be changed while the assistant is responding.
- Changing the model later requires a user confirmation because it can increase cost and reduce continuity or provider cache efficiency.
- Persisted model changes appear as timeline events. Consecutive changes collapse to the final transition, and a chain that returns to the original model is hidden.
- In Gateway Inference mode, model choices are filtered by the user's model access and effective API/subscription budget. A zero API budget hides API-only models.

## Context
- get_current_context returns the current UI route and focused resource when the user says "this page" or "current resource".
- compact summarizes older conversation history when context grows.
- Recent conversations are loaded from the backend, not local storage.
- manage_ai_conversation can list, read, and delete the current user's saved conversations:
  - { operation: "list" }
  - { operation: "get", conversationId }
  - { operation: "delete", conversationId }
  - { operation: "delete_by_title", title }
- manage_ai_conversation never creates, rewrites, or repairs conversation history. Use the chat UI/runtime for saving active messages.
- end_conversation closes the current chat with a localized reason. Use it only when the conversation should stop, especially after the third unrelated/off-topic request in the same conversation.
- If context is exhausted, the UI can block the composer and offer to clear the oldest saved context. Do not keep retrying the same oversized request.

## Attachments And Artifacts
- The composer accepts up to three supported images when the selected model advertises image input.
- Uploaded attachments become Gateway-managed artifacts tied to the conversation.
- Tool-generated files are attached through send_artifact and should not be duplicated as manual download links.

## AI Workspace
AI Workspace is Gateway's intent-driven desktop interface. The Work Session becomes the main screen, the sidebar shows a separate Dashboard link, Sidebar-pinned resources, and recent/pinned Work Sessions. Dashboard pins are not duplicated there: use the Sidebar placement for frequent navigation. Settings, Administration, and top-level pages keep a back button to return to the Work Session.

Do not assume the current page from chat text. Use get_current_context when the user refers to their visible page.`,

  'status-page': `# Status Pages

Gateway can publish status-page data from monitored services and incidents. Use manage_status_page for settings, services, incidents, updates, proxy-template choices, and preview.

## Resources and Operations
- settings: { resource: "settings", operation: "get"|"update", payload? }
- proxy_templates: { resource: "proxy_templates", operation: "list" }
- services: { resource: "services", operation: "list"|"create"|"update"|"delete", serviceId?, payload? }
- incidents: { resource: "incidents", operation: "list"|"create"|"update"|"delete"|"resolve"|"promote", incidentId?, status?, limit?, payload? }
- incident_updates: { resource: "incident_updates", operation: "create_update", incidentId, payload }
- preview: { resource: "preview", operation: "preview" }

Scopes: status-page:view for reads/preview, status-page:manage for settings/services, and status-page:incidents:create, status-page:incidents:update, status-page:incidents:resolve, or status-page:incidents:delete for incident mutations.`,

  api: `# Gateway REST API

Gateway provides REST access for external scripts, CI/CD pipelines, CLI tools, and integrations without a browser session.
Programmatic REST clients can use either Gateway API tokens (\`gw_\`) or OAuth Authorization Code + PKCE access tokens (\`gwo_\`). AI Workspace access, AI configuration, MCP user access, auth administration, raw nginx config, gateway settings, node raw config, node filesystem access, \`proxy:raw:bypass\`, and \`proxy:advanced:bypass\` cannot be delegated to API/OAuth tokens. MCP clients use OAuth access tokens for the MCP resource with ordinary delegated API scopes; the owning user account must have \`mcp:use\`. Node config and node file-management Workspace tools are intentionally browser-session-only and are not exposed through MCP.

## Current-User OAuth Authorizations
The assistant can manage existing OAuth authorizations for the current browser user with manage_oauth_authorization:
- { operation: "list" }
- { operation: "update_scopes", clientId, resource, scopes }
- { operation: "revoke", clientId, resource }

Pending OAuth consent remains browser-only. Do not try to approve a new OAuth client through tools.

## Current-User Gateway API Tokens
The assistant can manage the current browser user's Gateway API tokens with manage_api_token:
- { operation: "list" }
- { operation: "create", name, scopes }
- { operation: "update", tokenId, name?, scopes? }
- { operation: "revoke", tokenId }

Token scopes must be a subset of the current user's scopes. Token secrets are returned only by create and cannot be read later. manage_api_token is browser-session-only and is not exposed through MCP.

## Creating an API Token
1. Go to **Profile** → **Authorizations** → **API Tokens**
2. Click **Create Token** → enter a name and select the scopes (permissions) the token should have
3. Token scopes must be a subset of your own group's scopes — you cannot grant permissions you don't have
4. The token is shown **once** after creation (prefixed with \`gw_\`) — copy and store it securely
5. Tokens cannot be retrieved after creation — if lost, revoke and create a new one

## Authentication
Programmatic API requests authenticate via the \`Authorization\` header:

\`\`\`bash
curl -H "Authorization: Bearer gw_your_token_here" https://gateway.example.com/api/cas
\`\`\`

Token format: \`gw_\` followed by 64 hex characters.
OAuth access tokens use the \`gwo_\` prefix and the same Bearer header. Browser-only endpoints still require the HttpOnly session cookie and CSRF token where applicable.

## Base URL
All endpoints are under \`/api/\`. Example: \`https://gateway.example.com/api/cas\`

## Key Endpoints

### PKI & Certificates
- \`GET /api/cas\` — list certificate authorities
- \`GET /api/cas/:id\` — get CA details
- \`POST /api/cas\` — create root CA
- \`POST /api/cas/:id/intermediate\` — create intermediate CA
- \`GET /api/certificates\` — list certificates
- \`POST /api/certificates/issue\` — issue a certificate
- \`POST /api/certificates/:id/revoke\` — revoke a certificate
- \`GET /api/certificates/:id/export\` — download cert + key
- \`GET /api/templates\` — list certificate templates

### SSL Certificates
- \`GET /api/ssl-certificates\` — list SSL certificates
- \`POST /api/ssl-certificates/acme\` — request ACME (Let's Encrypt) certificate
- \`POST /api/ssl-certificates/upload\` — upload custom certificate
- \`POST /api/ssl-certificates/internal\` — link PKI cert as SSL

### Ingress Routes
The UI calls these resources Routes; stable API paths keep the \`proxy-hosts\` name.
- \`GET /api/proxy-hosts\` — list routes
- \`POST /api/proxy-hosts\` — create route
- \`PUT /api/proxy-hosts/:id\` — update route
- \`DELETE /api/proxy-hosts/:id\` — delete route
- \`GET /api/nginx-templates\` — list nginx config templates
Programmatic clients can use validated \`advancedConfig\`, but cannot set or read raw nginx config fields.

### Domains
- \`GET /api/domains\` — list domains
- \`POST /api/domains\` — register domain
- \`POST /api/domains/:id/check-dns\` — trigger DNS re-check

### Nodes
- \`GET /api/nodes\` — list daemon nodes
- \`POST /api/nodes\` — create node (returns enrollment token and gatewayCertSha256)
- \`DELETE /api/nodes/:id\` — delete node

### Docker
- \`GET /api/docker/nodes/:nodeId/containers\` — list containers
- \`POST /api/docker/nodes/:nodeId/containers/:id/start\` — start container
- \`POST /api/docker/nodes/:nodeId/containers/:id/stop\` — stop container
- \`POST /api/docker/nodes/:nodeId/containers/:id/restart\` — restart container
- \`POST /api/docker/nodes/:nodeId/containers/:id/recreate\` — recreate with new config (supports \`image\` field for tag change)
- \`POST /api/docker/nodes/:nodeId/images/pull-sync\` — pull image synchronously (validates image exists)

### Docker Webhooks
- \`GET /api/docker/nodes/:nodeId/containers/:name/webhook\` — get webhook config
- \`PUT /api/docker/nodes/:nodeId/containers/:name/webhook\` — enable/update webhook
- \`DELETE /api/docker/nodes/:nodeId/containers/:name/webhook\` — disable webhook
- \`POST /api/webhooks/docker/:token\` — trigger webhook update (no auth header needed, token is in URL)

### Access Lists
- \`GET /api/access-lists\` — list access lists
- \`POST /api/access-lists\` — create access list

### Browser-only administration
- \`/auth/*\`, \`/api/oauth/consent/*\`, \`/api/oauth/authorizations/*\`, \`/api/admin/users\`, \`/api/admin/groups\`, \`/api/tokens\`, \`/api/ai/*\`, raw nginx config endpoints, and system update mutations require a browser session.
- \`GET /api/audit\` — query audit log

## Response Format
- Success: JSON body with the resource data
- Errors: \`{ "code": "ERROR_CODE", "message": "Human-readable description" }\`
- List endpoints return: \`{ "data": [...], "total": N, "page": 1, "totalPages": N }\`

## Rate Limits & Pagination
- Default page size: 20 items. Use \`?page=N&limit=N\` for pagination (max 100).
- Search: \`?search=term\` on list endpoints for text filtering.
- Filter by type: \`?type=nginx\` on nodes, \`?status=running\` on containers.

## Scopes
Token permissions are controlled by scopes. Each endpoint requires specific scopes. A token with only \`pki:cert:view\` can list certificates but cannot issue or revoke them. See the permissions topic for the full scope list.

## Token Management
- Tokens are tied to the user who created them
- Revoking a token invalidates it immediately
- Token last-used timestamp is tracked for auditing
- Tokens inherit the user's resource restrictions (if the user's group restricts a scope to specific resources, the token is similarly restricted)`,

  'gateway-settings': `# Gateway Settings And MCP

Use \`get_gateway_settings\` before changing control-plane settings and \`update_gateway_settings\` with only the fields the user explicitly requested.

## Sign-in And OAuth
- oidcAutoCreateUsers controls whether a valid OIDC login may create a Gateway user automatically.
- oidcDefaultGroupId is the permission group assigned to automatically created users.
- oidcRequireVerifiedEmail requires the provider to assert a verified email.
- oauthExtendedCallbackCompatibility allows unverified public OAuth clients to use external HTTPS callbacks. Loopback callbacks are the safer default. External callbacks are marked as higher risk in consent.

## MCP
- mcpServerEnabled enables the remote MCP endpoint. MCP still requires an OAuth token issued for the MCP resource and the owning user must have \`mcp:use\`.
- Gateway MCP never delegates GitLab, GitHub, generic Git, or external SSH integration scopes. External agents must configure dedicated provider MCP servers for repository, CI, variable, webhook, registry, and SSH operations. Cloudflare DNS remains part of Gateway MCP because Gateway directly manages domain and ingress DNS state.
- The default MCP mode starts with a compact core toolset. \`discover_tools\` activates domain toolsets for the current session, Gateway sends \`notifications/tools/list_changed\`, and the client should refresh \`tools/list\`.
- The \`Ingress\` toolset covers Domains, Routes, route folders, nginx templates, access lists, and raw route configuration. Stable tool names, resource URIs, scopes, and REST paths still use proxy-host identifiers for compatibility.
- Use \`manage_additional_route\` for path-prefix locations inside a Route. It supports manual, Docker container/deployment, and Pages Tag targets plus location advanced config. Docker targets create and own their required Secure Link binding.
- Use \`manage_additional_secure_link\` only for extra bindings referenced by a Route's advanced nginx config. Route-owned bindings are visible in its list but must be changed through \`manage_additional_route\`, not deleted independently.
- The \`Pages\` toolset exposes Page Projects, Deployments, Tags, runtime configuration, profile settings, and project migration. The \`Databases\` toolset includes managed database provisioning and application bindings.
- mcpExtendedCompatibility is enabled by default. It returns every OAuth-scoped tool in the initial \`tools/list\` response and omits \`discover_tools\`. Disable it only when a harness loads every tool schema into its context at once and exhausts that context; disabling it can leave that harness unable to use some Gateway tools.

## General And Network Settings
- generalSettings contains feature flags and shared limits. Inference is disabled by default under Settings > General > General settings, and its harness-specific endpoints are configured separately under Settings > Inference.
- networkSecurity controls trusted private destinations and outbound request restrictions.
- outboundWebhookPolicy controls allowed webhook destinations.

Never weaken callback, network, or webhook restrictions without explaining the resulting external-data or SSRF exposure and receiving explicit user approval.`,

  'licensing-updates': `# Licensing And Updates

## Licensing
- \`get_license_status\` reads tier, installation ID, expiry, grace state, and masked key metadata.
- \`manage_license({ operation: "activate", licenseKey })\` activates a key. Treat the key as a secret and never repeat it in chat.
- \`manage_license({ operation: "check" })\` refreshes the current state.
- \`manage_license({ operation: "clear" })\` removes the active key and is destructive.
- Current license tiers are informational and do not gate product features. Read the live status instead of inferring a tier from available UI.

## Gateway And Daemon Updates
- Use \`manage_system_updates({ operation: "get_gateway_status" })\` or \`manage_system_updates({ operation: "check_gateway" })\` before proposing an update.
- Read release notes with \`manage_system_updates({ operation: "get_gateway_release_notes", version })\` for the exact advertised version.
- Apply an app update with \`manage_system_updates({ operation: "perform_gateway_update", version })\` only after explicit approval.
- Use the \`list_daemon_updates\` and \`check_daemon_updates\` operations before \`manage_system_updates({ operation: "update_daemon", nodeId })\`; pass the exact nodeId and verify the node reconnects on the expected version.
- Never invent a version, claim an update completed before its status confirms success, or update unrelated daemons as a side effect.`,

  inference: `# Gateway Inference

Gateway Inference is a standalone external model gateway. It is not the AI Workspace provider configuration and it is not Gateway MCP. It has separate provider credentials, model configuration, scopes, accounting, continuation state, and dedicated \`gwi_\` runtime tokens. Never use a normal \`gw_\` API token, a \`gwo_\` OAuth token, a Workspace provider key, or an MCP credential on the inference data plane.

## Availability

Inference is disabled by default. Read Gateway settings first. An administrator with \`settings:gateway:edit\` can enable it through \`update_gateway_settings\`:

\`\`\`json
{
  "generalSettings": {
    "features": { "inferenceEnabled": true }
  }
}
\`\`\`

No restart is required. If inference is disabled, inference tools fail instead of bypassing the feature gate.

## Administrative Tools

- \`manage_inference_provider\`: list templates/connections, connect API keys, start or inspect supported authorization flows, sync, rename, enable/disable, configure quota reserves/API budgets/routing, or disconnect.
- \`manage_inference_model\`: list models, inspect account suggestions, atomically create/replace a complete model configuration, or delete a model.
- \`manage_inference_limits\`: list default/per-user policies and configure or remove overrides.
- \`manage_inference_token\`: list, create, or revoke the current user's \`gwi_\` tokens. It cannot issue a token for another user.

Always inspect current state before mutation. Use \`internal_documentation({ topic: "inference" })\` before multi-step inference work.

## Provider Workflow

1. Call \`manage_inference_provider({ operation: "list_templates" })\` and use the returned provider ID. Never invent template IDs.
2. For API/local providers, call \`connect_api_key\` with the name, providerId, and only the secret/URL fields supported by that template. Never repeat the API key.
3. For supported device/OAuth providers, call \`start_authorization\`. Subscription connectors require the exact returned termsVersion and explicit user approval before acceptTerms may be true. Never infer or silently accept connector terms.
4. Return the authorization URL/user code. For device flows, call \`wait\` and then \`authorization_status\`; Gateway polls automatically. Redirect/paste-callback providers must be completed in **Settings > Inference**. Never ask the user to paste an OAuth callback URL or authorization code into AI chat.
5. Call \`sync\`, then verify discoveredModels, quota, status, and syncStatus.

Each connection row is one account or API key. There is no Pool resource. Gateway groups compatible connections automatically per provider/model:

- \`balanced\`: distributes new threads across available connections while retaining thread affinity;
- \`sequential\`: uses the lowest routingOrder connection until unavailable, then moves down the list.

Subscription connections can set minimumRemainingPercent. API connections can set apiMonthlyLimitUsd; null means no per-connection cap. Disconnecting or disabling is blocked when it would leave a published model without a route.

## Model Workflow

1. List synchronized provider connections and select a discovered model.
2. Call \`manage_inference_model({ operation: "save", configuration })\`. Omit modelId to create; include modelId to replace the entire configuration atomically.
3. A logical model uses exactly one provider template and one upstream model. Multiple sources are accounts/keys for that same provider/model, never a mix of OpenAI, OpenRouter, Anthropic, Kimi, etc.
4. Configure publicId, displayName, contextWindow, maxInputTokens, optional maxOutputTokens, autoCompactTokenLimit, modalities, capabilities, reasoning efforts, subscriptionMultiplier, sources, pricing, and access.
5. Access mode is \`everyone\`, \`selected\` with user/group subjects, or \`disabled\`. Never publish without an enabled, available source.
6. reasoningEffortMap maps client efforts to provider efforts, for example \`{ "ultra": "max" }\`. Every advertised effort must be representable by every enabled source.
7. API pricing is versioned. Pricing values are integer microdollars per million tokens: $5.00 per million tokens is 5,000,000 microdollars. Prefer synchronized/known pricing; use manual pricing only when provider metadata is unavailable.

\`save\` is the only model mutation workflow. Do not attempt partial model/source/pricing/access updates.

## Default And Per-user Limits

\`manage_inference_limits\` uses one complete policy object. \`enabled\` controls inference access. Subscription windows use credits5hEnabled/credits5h, credits7dEnabled/credits7d, and credits30dEnabled/credits30d. A disabled window is unlimited; if all three are disabled, subscription-credit usage is unlimited. apiMonthlyMicrodollars is the user's monthly API budget and 0 disables API usage. When API usage is disabled, models whose usable sources are API-only are omitted from OpenAI, harness, and internal Assistant catalogs for that user. billingTimezone is an IANA timezone. Per-user policies override the default policy.

## User Tokens And Harness Setup

Users need \`feat:ai:use\`, which grants both AI Workspace and Gateway Inference access, including personal usage visibility. Creating and revoking tokens additionally require \`inference:tokens:manage\`.

Token options:

- UI: **Profile > Authorizations > Inference API tokens**;
- AI: \`manage_inference_token({ operation: "create", name: "Laptop" })\` for the current user.

The \`gwi_\` secret is shown once. Never repeat it after creation, store it in assistant history, or expose it to another user.

### Recommended harness setup

No global installation or PATH change is required:

\`\`\`bash
npx -y @wiolett/gateway-inference@latest
\`\`\`

An administrator must first enable **Harness-specific endpoints** in **Settings > Inference** and accept the alpha-risk warning. Harness APIs track unstable upstream contracts and may stop working after a client update; the base OpenAI-compatible adapter does not require this toggle. Before giving harness setup instructions, call \`get_gateway_settings\` when it is available and report both \`generalSettings.features.inferenceEnabled\` and \`generalSettings.inference.harnessSpecificEndpointsEnabled\`. Without that read permission, do not guess either value: explain that an administrator must confirm them. The interactive manager asks for the Gateway URL, completes isolated OAuth/PKCE, and can configure, diagnose, repair, or remove supported harness integrations. The only direct commands are \`login [gateway]\`, \`logout\`, and \`setup [harness]\`. If the user does not name a harness, ask whether they use Codex or Claude Code before giving harness-specific instructions.

#### Codex CLI and Desktop

\`\`\`bash
npx -y @wiolett/gateway-inference@latest login https://gateway.example.com
npx -y @wiolett/gateway-inference@latest setup codex
\`\`\`

Codex setup issues a dedicated runtime token, writes only package-managed Codex configuration sections, installs a private helper and loopback proxy, and maintains the authoritative Gateway model catalog. Catalog changes apply after starting a new Codex process. Codex Desktop must also be signed in to an OpenAI account through Codex's normal login flow; after Gateway setup or login changes, fully quit and reopen Codex.

#### Claude Code CLI

Claude Code 2.1.129 or newer is required:

\`\`\`bash
npx -y @wiolett/gateway-inference@latest login https://gateway.example.com
npx -y @wiolett/gateway-inference@latest setup claude-code
\`\`\`

Claude Code setup issues a separate dedicated runtime token and configures the native Anthropic gateway contract with \`ANTHROPIC_BASE_URL\`, model discovery, and a private \`apiKeyHelper\`. It does not use the Codex loopback proxy. This setup supports the Claude Code CLI only; Claude Desktop and the Claude Code VS Code extension are separate and are not modified automatically.

### Manual OpenAI-compatible setup

\`\`\`text
Base URL: https://gateway.example.com/api/inference/v1
API key:  gwi_...
Models:   GET <base-url>/models
\`\`\`

Use this base adapter for OpenAI SDKs and OpenAI-compatible clients. It supports Responses and Chat Completions. Harness-specific adapters such as Codex and Anthropic are available only when an administrator enables them in **Settings > Inference**.

### Manual Anthropic-compatible setup

\`\`\`text
Anthropic SDK base URL: https://gateway.example.com/api/inference/anthropic
Direct REST prefix:     https://gateway.example.com/api/inference/anthropic/v1
API key:                gwi_...
\`\`\`

Anthropic SDKs append \`/v1\` themselves, so configure the SDK base URL without \`/v1\`. Direct HTTP clients call \`/api/inference/anthropic/v1/messages\`. Dedicated \`gwi_\` tokens work as Bearer credentials and as \`x-api-key\`.

## Safety And Verification

- Management tools enforce the caller's actual inference scopes; never work around a permission error.
- Provider credentials are encrypted and list operations return masked metadata only.
- Activity stores metadata and normalized usage, never prompts or model output.
- After configuration, verify provider sync, model visibility, a small request, accounting, reasoning mapping, tools, continuation, and Codex auto-compaction where applicable.
- Gateway Inference runtime and credentials remain isolated from the assistant configuration. The assistant may use a published Gateway Inference model only when an administrator explicitly selects that provider type.`,
  'ai-settings': `# AI Workspace Settings

AI Workspace settings control the provider, request limits, tool exposure, web search, and sandbox runner. Use these tools instead of guessing from UI labels:

## Tools
- get_ai_settings: read provider, model, limits, system prompt, tool access, web search, and sandbox runner settings.
- update_ai_settings: update supported assistant settings. Send only fields that should change.
- list_ai_tools: list available assistant tools with categories, scopes, descriptions, and whether they are destructive.
- get_sandbox_runtime_status: read sandbox runner enablement and runtime health.

## Provider Settings
- providerType: openai_compatible or gateway_inference. Gateway Inference is available only while the inference feature is enabled.
- providerUrl: OpenAI-compatible API base URL.
- endpointMode: auto, chat_completions, or responses.
- model: provider model name.
- apiKey: only set this when replacing the stored provider key. The current secret is never returned in full.
- gatewayInferenceModel: default published Gateway Inference model ID.
- gatewayInferenceAllowUserModelSelection: whether users may choose another model they are allowed to access.
- allowUserReasoningEffortSelection: whether users may override the default reasoning effort for the OpenAI-compatible provider. Gateway Inference uses each published model's own reasoning capabilities instead.
- OpenAI-compatible provider values are preserved while Gateway Inference is selected. Disabling inference restores them; if no OpenAI-compatible key was saved, the assistant is disabled.

## Limits
- rateLimitMax and rateLimitWindowSeconds: rate limit for assistant requests.
- maxToolRounds: maximum sequential tool-call rounds in one assistant run.
- maxContextTokens: context budget used by the conversation builder.
- maxCompletionTokens and maxTokensField: response token cap and provider field name.
- reasoningEffort: default OpenAI-compatible provider effort: low, medium, high, or none. Use none to leave reasoning unspecified. Gateway Inference ignores this setting.

## Tool Access
- disabledTools: exact tool names hidden from the assistant.
- webSearchProvider, webSearchBaseUrl, and webSearchApiKey: provider selection, optional provider URL, and secret replacement for web search. Tavily is the default; Brave, Serper, Exa, and SearXNG are also supported. API-backed providers require a stored key, while SearXNG requires its base URL. The web_search tool is exposed only when the effective settings configure the selected provider.
- sandboxEnabled and sandboxDefaultTier: sandbox runner exposure and default tier.

## Sandbox Runner
- sandboxEnabled: expose sandbox execution and artifact tools to the assistant.
- sandboxDefaultTier: default resource tier. The agent may request a tier only if the user has the required scope. Tier workspace sizes are soft quotas; the runner refuses new reservations at 80% host-disk use and removes workspaces at terminal cleanup.
- Sandbox tools are intentionally excluded from MCP exposure and are available only to the assistant when enabled and permitted.`,

  gitlab: `# GitLab Integrations

Gateway GitLab connectors are configured by admins in Settings -> Integrations. Embedded AI users authorize each connector with their own encrypted PAT unless they have the explicit integrations:gitlab:system scope. GitLab tools are not exposed through Gateway MCP; external agents should configure their own GitLab MCP connection.

## Discovery
- Use gitlab_list_connectors to find enabled connectors.
- No connector is a setup choice, not a terminal failure. For a GitLab repository, ask the user whether they want a shared GitLab-instance connector or a generic connector scoped to this repository before treating repository inspection as unavailable.
- If Gateway asks for GitLab authorization, wait for the user to complete or cancel the authorization modal. Never ask the user to paste a PAT into chat.
- Use gitlab_list_projects or gitlab_search_projects to find projects already synced through Gateway allowlist rules.
- Project arguments accept the synced project remote ID or full path.
- Every GitLab tool except gitlab_list_connectors requires the exact connectorId UUID from gitlab_list_connectors or from a prior GitLab project result. Do not use connector names, project paths, or blank values as connectorId.
- If a visible GitLab project exists but is not enabled in the connector allowlist, use gitlab_add_connector_projects with explicit approval, then gitlab_sync_connector.
- Do not guess connector IDs or scan GitLab directly outside these tools.

## Repository Access
- Prefer direct API tools for ordinary read/write work:
  - gitlab_list_repository_tree for folders.
  - gitlab_read_file for bounded file reads. Use offset and length for large files.
  - gitlab_commit_files for create/update/delete/move commits.
- Use gitlab_clone_repository_to_sandbox only when local analysis, tests, or multi-file tooling actually requires a checkout.
- After gitlab_clone_repository_to_sandbox, wait for CLONE_READY with read_process_output, then inspect the checkout through list_artifact_files/read_artifact on the returned processId. Do not call run_process merely to list or read cloned repository files.
- Clone runs with connector-configured limits: shallow clone, depth, LFS/submodule settings, max size, and timeout.

## CI
- Use gitlab_lint_ci_config before committing CI changes.
- Use gitlab_update_ci_config for the first-class .gitlab-ci.yml edit workflow. Invalid CI config is not committed.
- Use pipeline/job tools to inspect CI status and bounded job logs.

## Variables, Webhooks, and Deploy Tokens
- gitlab_list_project_variables returns metadata only; variable values are never returned.
- gitlab_set_project_variable accepts a secret value but the value must not be repeated in responses or explanations.
- gitlab_delete_project_variable always requires explicit tool approval.
- Webhook management uses GitLab project webhook tools and must respect connector allowlist and Gateway scopes.
- gitlab_create_deploy_token captures the raw deploy token only inside Gateway, encrypts it as connector-managed credentials, and returns masked metadata only.
- If a project registry is disabled, use gitlab_update_project_settings with containerRegistryAccessLevel=enabled after approval. That tool runs a connector sync afterward and reports sync or syncError; use gitlab_sync_connector only if you need to retry a failed sync or refresh metadata later.

## Safety Rules
- Gateway scopes, connector allowlist, provider capabilities, and tool approval rules are authoritative. GitLab PAT permissions are only an upper bound.
- Direct commits to protected/default branches are allowed only when Gateway approval rules and the GitLab PAT both allow it.
- Never ask the user to paste connector PATs, deploy token values, or project variable secrets into chat unless the current tool call explicitly needs one-time secret input.
- Audit logs store metadata and optional diff hashes, not raw secrets or full diffs.`,

  notifications: `# Webhook Notifications

## Overview
The notification system sends HTTP webhook notifications when alert conditions are met. It supports threshold-based alerts (CPU, memory, disk) and event-based alerts (node offline, container stopped, etc.).

## Alert Rules
Each alert rule defines:
- **Category**: node, container, proxy, certificate, database_postgres, database_clickhouse, or database_redis
- **Type**: threshold (metric breaches a value) or event (something happens)
- **Threshold fields** (for threshold type): metric, metricTarget (optional sub-target such as a specific node disk mount), operator (>, >=, <, <=), thresholdValue, durationSeconds (fire observation window), fireThresholdPercent (percent of probes in that window that must breach), resolveAfterSeconds (resolve observation window, default 60s), resolveThresholdPercent (percent of probes in that window that must be clear)
- **Event fields** (for event type): eventPattern (offline, stopped, oom_killed, etc.)
- **Scope**: resourceIds — specific nodes/containers/certs to monitor (empty = all)
- **Severity**: info, warning, critical
- **Webhooks**: webhookIds — which webhooks receive notifications from this rule
- **Message template**: Handlebars template rendered with event-specific variables
- **Cooldown**: cooldownSeconds — won't re-fire within this period (default 900s = 15 min)

## Webhooks
Webhooks define where notifications are delivered:
- URL, HTTP method (POST/PUT/PATCH/GET)
- Body template (Handlebars) with preset options: Discord, Slack, Telegram, Generic JSON, Plain Text
- Custom headers (key-value pairs)
- HMAC-SHA256 signing with configurable secret and header name
- Delivery log with retry (5 attempts, exponential backoff)

## Handlebars Template Variables
Available in message templates (per-alert) and body templates (per-webhook):

### Common variables (all alerts)
- \`{{alert_name}}\` — alert rule name
- \`{{severity}}\` — alert severity (info/warning/critical)
- \`{{severity_emoji}}\` — emoji for severity
- \`{{resource.name}}\` — resource display name
- \`{{resource.id}}\` — resource ID
- \`{{resource.type}}\` — resource type (node/container/proxy/certificate)
- \`{{timestamp}}\` — ISO 8601 timestamp
- \`{{fired_at}}\` — when alert started firing
- \`{{fired_duration}}\` — seconds the alert was firing (on resolve)

### Threshold-specific variables
- \`{{value}}\` — current metric value
- \`{{threshold}}\` — configured threshold
- \`{{operator}}\` — comparison operator
- \`{{metric}}\` — metric name (cpu, memory, disk)
- \`{{duration}}\` — configured fire-after duration (e.g. "5m")
- \`{{node_name}}\` / \`{{hostname}}\` — node hostname

### Category-specific variables
- Container: \`{{node_name}}\` — hosting node
- Proxy: \`{{health_status}}\` — health status
- Certificate: \`{{days_until_expiry}}\`, \`{{expiry_date}}\`
- Database: \`{{metric}}\`, \`{{value}}\`, \`{{threshold}}\`, and \`{{resource.name}}\`

## Database Alert Categories
- database_postgres metrics: latency_ms, active_connections_pct, database_size_mb.
- database_clickhouse metrics: latency_ms, database_size_mb, disk_used_pct, disk_available_mb, pending_mutations.
- database_redis metrics: latency_ms, memory_pct.
- database health events: health.offline, health.degraded, health.online. These events can also be used with threshold-style observation windows when supportsThreshold is true.

## Handlebars Helpers
Available in all templates:

### Comparison & logic
\`{{#if (gt value 90)}}CRITICAL{{else}}OK{{/if}}\`, \`eq\`, \`ne\`, \`gt\`, \`lt\`, \`gte\`, \`lte\`, \`and\`, \`or\`, \`not\`

### Formatting
- \`{{round value 1}}\` — round to N decimals (e.g. 11.237 → 11.2)
- \`{{uppercase str}}\`, \`{{lowercase str}}\`
- \`{{truncate str 50}}\` — truncate with ellipsis
- \`{{json obj}}\` — JSON.stringify
- \`{{default value "N/A"}}\` — fallback for null/undefined
- \`{{join array ", "}}\` — join array elements

### Math & calculations
- \`{{math value "+" 10}}\` — arithmetic (+, -, *, /, %)
- \`{{percent used total}}\` — calculate percentage
- \`{{round (math value "/" 1024) 2}}\` — combine helpers

### Time & dates
- \`{{formatDuration seconds}}\` — human format: "5m 30s", "2h 15m"
- \`{{timeago timestamp}}\` — relative: "3 minutes ago"
- \`{{dateformat timestamp "YYYY-MM-DD HH:mm"}}\` — custom format
- Format tokens: YYYY, MM, DD, HH, mm, ss

### Text
- \`{{pluralize count "container" "containers"}}\` — singular/plural

## Template Examples
- \`CPU at {{round value 1}}% on {{resource.name}} (threshold: {{operator}} {{threshold}}%)\`
- \`{{resource.name}} {{metric}} has been above {{threshold}}% for {{duration}}\`
- \`Resolved after {{formatDuration fired_duration}} — {{metric}} now at {{round value 1}}%\`
- \`{{#if (gt value 95)}}🔥 CRITICAL{{else}}⚠️ Warning{{/if}}: {{alert_name}}\`

## API Endpoints
- \`GET /api/notifications/alert-rules\` — list rules (notifications:alerts:view or notifications:manage)
- \`GET /api/notifications/alert-rules/:id\` — view rule (notifications:alerts:view or notifications:manage)
- \`POST /api/notifications/alert-rules\` — create rule (notifications:alerts:create or notifications:manage)
- \`PUT /api/notifications/alert-rules/:id\` — update rule (notifications:alerts:edit or notifications:manage)
- \`DELETE /api/notifications/alert-rules/:id\` — delete rule (notifications:alerts:delete or notifications:manage)
- \`GET /api/notifications/alert-rules/categories\` — list categories with metrics/events/variables
- \`GET /api/notifications/webhooks\` — list webhooks (notifications:webhooks:view or notifications:manage)
- \`GET /api/notifications/webhooks/:id\` — view webhook (notifications:webhooks:view or notifications:manage)
- \`POST /api/notifications/webhooks\` — create webhook (notifications:webhooks:create or notifications:manage)
- \`PUT /api/notifications/webhooks/:id\` — update webhook (notifications:webhooks:edit or notifications:manage)
- \`DELETE /api/notifications/webhooks/:id\` — delete webhook (notifications:webhooks:delete or notifications:manage)
- \`POST /api/notifications/webhooks/:id/test\` — send test delivery
- \`GET /api/notifications/deliveries\` — list delivery log (notifications:deliveries:view or notifications:manage)
- \`GET /api/notifications/deliveries/:id\` — view delivery log entry (notifications:deliveries:view or notifications:manage)
- \`GET /api/notifications/deliveries/stats\` — delivery statistics`,
  overview: `# Gateway Overview

Gateway is a self-hosted infrastructure control plane. It combines secure access management with operations for reverse proxies, certificates, compute, databases, observability, and integrations.

## Main Capabilities
- **Access and administration**: groups, scopes, resource-scoped permissions, audit logs, OIDC/password/email-code sign-in, passkeys, API tokens, OAuth, and MCP.
- **Traffic and certificates**: nginx ingress nodes, proxy/redirect/404 routes, access lists, PKI, uploaded/internal/ACME certificates, and external or Cloudflare-managed domains.
- **Compute**: Docker nodes, containers, images, volumes, networks, private registries, webhooks, blue/green deployments, exports/imports, and migrations.
- **Databases and logging**: saved PostgreSQL, Redis, and ClickHouse connections; dedicated nodes for Gateway-managed database instances; optional structured logging in managed or external ClickHouse.
- **Operations**: daemon health, notifications, housekeeping, status pages, updates, licensing, GitLab and Cloudflare integrations, and a separate Gateway Inference service.

## How To Guide A User
Start with the user goal, then read the focused topic before explaining a workflow or calling tools. Use installation for a new deployment, authentication for access/sign-in questions, gateway-settings for control-plane settings and MCP, and troubleshooting for failures. A feature being described here does not grant permission to view or change it; always respect the user's scopes and confirm destructive changes.

## Dashboard Attention And Pins
- The Dashboard sidebar item can show a **12px square attention badge**. Blue means the Dashboard has only informational cards, such as an unfinished setup checklist. Yellow means at least one warning card is visible; this includes red/unhealthy resource states, certificate expiry, low node capacity, MFA reminders, update/logging/inference warnings, and unhealthy pinned database or Docker resources. No badge means there are no visible information or warning cards for the current user.
- The Dashboard is one user-scoped bootstrap snapshot. Do not describe the badge as an unread notification count or as a system-wide state: it reflects only cards visible to the signed-in user and their permissions.
- Nodes, routes, databases, Docker containers, and Docker deployments can each be pinned independently to the **Dashboard**, the **Sidebar**, or both. A Dashboard pin adds a compact card; a Sidebar pin adds a quick-access link. Removing one placement must not remove the other.
- When a user asks where to pin something, explain this distinction and recommend Dashboard for operational status and Sidebar for frequent navigation.
- In the embedded Gateway Assistant, resolve the resource with \`find_resource\` first, then use \`set_resource_pin\` with an explicit \`target\` and \`pinned\` value. Docker pins also need \`nodeId\`, \`nodeSlug\`, and the resource \`name\`. This tool changes only the current browser session's saved layout preference and is intentionally unavailable through MCP.`,

  installation: `# Installing And First-Time Setup

## Install
Use the release installer. It installs Gateway and starts it with native HTTPS by default. Supported installer options are --install-dir, --image, --source-dir, --http, --https, and --dry-run. The installer does not collect a domain, nginx, Cloudflare, OIDC, SMTP, or ClickHouse configuration.

## Browser Setup Wizard
After the stack becomes healthy, the installer prints the Gateway URL, System CA SHA-256 fingerprint, a one-time setup code valid for 24 hours, and a reset command. The plaintext code appears only in installer output. Until the wizard completes, normal product and auth APIs return SETUP_REQUIRED.

The wizard requires:
1. An explicit canonical public URL.
2. One or more sign-in methods: OIDC, password, and/or email one-time code.
3. OIDC settings when selected, and verified SMTP for an email-based method.
4. Exactly one first administrator and one primary sign-in method for that account.
5. Structured logging mode: disabled, Gateway-managed local ClickHouse, or external ClickHouse.

## HTTPS And Reverse Proxy
Native HTTP and HTTPS both listen on port 3000. Native HTTPS uses a Gateway System CA leaf certificate. A reverse proxy may connect over either protocol; when it verifies the HTTPS upstream, configure it to trust the Gateway System CA. Public certificates, DNS, Cloudflare, and ACME are configured after setup, not by the installer or wizard.

## Safe Advice
Never ask a user to paste a setup code, password, API token, private key, or SMTP/OIDC secret into chat. Explain where it is entered in the UI instead. For a failed install or wizard, use the troubleshooting topic before suggesting recovery steps.`,

  authentication: `# Authentication And User Access

## Sign-In Methods
Gateway can enable OIDC, password, and email one-time-code sign-in independently. Email-based sign-in requires verified SMTP. Passkeys can be added by an already signed-in user and are not a first-run primary method.

## First Administrator
The browser setup wizard creates exactly one explicit first administrator in the built-in system-admin group. Gateway does not promote an arbitrary first OIDC user. The setup code is one-time and expires after 24 hours; it must not be shared or stored in chat.

## OIDC
Configure issuer URL, client ID, client secret, requested scopes, optional automatic user creation, default group, and optional verified-email enforcement in Gateway settings. OIDC users are bound to their provider subject after the first login. When verified-email enforcement is enabled, Gateway requires the provider's verified-email assertion for future auto-provisioning and matching flows.

## Accounts And Permissions
Each user belongs to one permission group and may have permitted per-user scope overrides. Groups, scopes, resource restrictions, API tokens, OAuth authorizations, and MCP access determine what a user can do. Do not imply that a successful sign-in grants administration access.

## Support Rules
Use the Login/Profile UI for password, email-code, passkey, and token flows. Do not reveal, request, or copy secrets. If authentication is unavailable, check SMTP/OIDC configuration, the canonical URL, and the relevant audit or application logs; use troubleshooting for the ordered diagnostic path.`,

  cloudflare: `# Cloudflare Integration

Gateway Cloudflare connectors securely store an encrypted API token, synchronize available DNS zones, and support Gateway domain management plus automated DNS-01 ACME flows.

## Setup
Create a connector in the Cloudflare integration UI or through the authenticated Gateway API, provide a token with only the required zone and DNS permissions, then test and synchronize it. Do not ask users to paste the token into chat and do not expose its value after creation.

## What It Enables
- Gateway domains can create, adopt, inspect, and—when authorized—delete Cloudflare A/AAAA records.
- DNS-01 certificates can create and clean up TXT records automatically when one enabled connector has an unambiguous matching zone.
- A wildcard certificate or a deployment where port 80 is unavailable usually needs DNS-01.

## Constraints And Diagnostics
If no enabled connector has a matching zone, DNS-01 cannot be automated. If several connectors match, resolve the ambiguity rather than choosing one silently. Existing DNS records with a different target require explicit approval before overwrite. Use connector test/sync, zone status, and DNS propagation checks before retrying certificate issuance. If the API token is already present in the user's current request, create_cloudflare_connector can create the connector under approval; otherwise open the concrete Cloudflare setup flow and keep the secret out of chat history.`,

  'docker-registries': `# Docker Registries

Gateway stores private Docker registry credentials encrypted at rest. A registry may be global or restricted to a specific Docker node; use only a registry available to the selected node when pulling, recreating, or deploying an image.

Public Docker Hub images such as \`nginx:alpine\` do not require a saved registry. Pull them directly with \`registryId\` omitted. Never create a manual Docker Hub registry merely to pull a public image, and never pass an empty string as \`registryId\`.

## Configuration
Use the Docker registry UI or REST API to create, test, edit, or remove a registry. Viewing requires docker:registries:view; create, edit, and delete operations require the corresponding docker:registries scope. Integration-managed registry records, such as GitLab-provided credentials, cannot be edited as ordinary registries.

## Safe Use
Credentials are never returned after storage and must not be pasted into chat, logs, templates, or container environment variables. For Bearer token authentication, Gateway sends credentials only to a token service on the same HTTPS registry host or an explicitly configured trusted HTTPS token-service origin. Do not weaken this protection merely to make a pull succeed.

## Troubleshooting
First confirm the registry is enabled, available for the selected node, and passes its connection test. Then verify the image reference and node connectivity. A missing-credential failure may mean a GitLab integration exists but has no usable registry credentials; configure it in the integration rather than replacing it with an unrelated secret.`,

  clickhouse: `# ClickHouse In Gateway

Gateway supports ClickHouse as a saved external database connection, a Gateway-managed database instance on a dedicated database node, or the optional structured-logging backend.

## Access And Connectivity
External ClickHouse connections require an HTTP(S) URL or host plus database and username. Managed instances are private by default. Application bindings use the private connector and authenticated Gateway tunnel; do not present a binding as direct TCP access or disclose its injected credentials.

Published managed ClickHouse uses TLS and exposes HTTPS plus a native TLS endpoint. Gateway provides the Database CA certificate/fingerprint with direct credentials and supports certificate rotation after a node IP change. Publishing is an explicit infrastructure choice, not a default.

## Data Operations
Gateway provides schema/table browsing, a SQL console, monitoring, and conditional row operations when the selected table supports them. Do not promise arbitrary inline updates or deletes: ClickHouse mutations can be unsupported for a table and must fail closed. Do not use database tools to claim that Gateway can deploy, bind, publish, or reveal managed-instance credentials unless a matching guarded operation is available.

## Structured Logging
Structured logging can be disabled, use Gateway-managed local ClickHouse, or use an external ClickHouse connection. It is configured separately from ordinary saved database connections in Gateway settings.`,

  troubleshooting: `# Gateway Troubleshooting

## Start With Evidence
Identify the failing surface, read its focused internal topic, and inspect the current Gateway state before proposing a change. Do not ask for or expose secrets, raw credentials, private keys, setup codes, full daemon errors, or unredacted logs. Prefer health/status tools, audit records, and sanitized operational logs.

## First Setup Or Sign-In
- Setup blocked: confirm the one-time setup code is within its 24-hour lifetime and use the installer-provided reset command when it has expired. Normal APIs remain locked until the wizard completes.
- Sign-in failure: distinguish OIDC, password, and email-code methods. Check OIDC issuer/client settings and verified-email policy, or verified SMTP for email-based sign-in. Do not claim OIDC is mandatory.
- Browser URL problem: confirm the explicit canonical URL and whether the browser reaches Gateway directly or through a reverse proxy. Native HTTP/HTTPS use port 3000.

## Nodes, Ingress, And Certificates
- Offline node: inspect node health and reconnect status before retrying a mutation.
- Route failure: verify its nginx ingress node, domain affinity, upstream reachability, published Docker port where applicable, and rendered configuration. Do not disable a route to imitate maintenance mode.
- ACME failure: for HTTP-01 verify public port 80 and DNS; for DNS-01 verify the matching Cloudflare connector/zone and TXT propagation. Use staging for safe certificate-flow tests.

## Docker, Databases, And Integrations
- Docker pull failure: validate the node, image reference, registry availability, and registry credentials before changing a registry trust policy.
- Database failure: distinguish a saved external connection from a private managed instance. Check health and TLS/connection settings; do not copy binding credentials or publish an endpoint as a workaround.
- Cloudflare failure: test and synchronize the connector, then resolve missing or ambiguous zones explicitly.

## Escalation
If evidence is insufficient, state what could be verified and direct an administrator with the needed scope to the relevant UI or logs. Never invent a successful recovery, current version, or available tool.`,
};

/** Map doc topics to the scope required to read them */
export const DOC_TOPIC_SCOPES: Record<string, string | string[]> = {
  discovery: 'feat:ai:use',
  pki: 'pki:ca:view:root',
  ssl: 'ssl:cert:view',
  proxy: 'proxy:view',
  pages: 'pages:view',
  domains: 'domains:view',
  'access-lists': 'acl:view',
  templates: 'pki:templates:view',
  acme: 'ssl:cert:view',
  users: 'admin:users',
  audit: ['admin:audit', 'audit:siem:view'],
  siem: 'audit:siem:view',
  nginx: 'proxy:edit',
  nodes: 'nodes:details',
  folders: [
    'nodes:folders:manage',
    'databases:folders:manage',
    'domains:folders:manage',
    'logs:environments:folders:manage',
    'logs:schemas:folders:manage',
    'admin:users:folders:manage',
    'admin:groups:folders:manage',
    'proxy:folders:manage',
    'docker:containers:folders:manage',
  ],
  'node-files': ['nodes:files:read', 'nodes:files:write'],
  docker: 'docker:containers:view',
  sandbox: 'ai:sandbox:use',
  conversations: 'feat:ai:use',
  databases: 'databases:view',
  postgres: 'databases:view',
  redis: 'databases:view',
  logging: ['logs:environments:view', 'logs:schemas:view', 'logs:read', 'logs:manage'],
  'ai-settings': 'feat:ai:configure',
  'status-page': 'status-page:view',
  housekeeping: 'housekeeping:view',
  permissions: 'feat:ai:use',
  api: 'feat:ai:use',
  'gateway-settings': ['settings:gateway:view', 'settings:gateway:edit'],
  'licensing-updates': ['license:view', 'license:manage', 'admin:update'],
  inference: [
    'feat:ai:use',
    'inference:tokens:manage',
    'inference:providers:view',
    'inference:providers:manage',
    'inference:models:manage',
    'inference:limits:manage',
    'inference:usage:view',
    'settings:gateway:edit',
  ],
  gitlab: 'integrations:gitlab:view',
  notifications: ['notifications:view', 'audit:siem:view'],
  overview: 'feat:ai:use',
  installation: 'feat:ai:use',
  authentication: 'feat:ai:use',
  cloudflare: 'integrations:cloudflare:view',
  'docker-registries': 'docker:registries:view',
  clickhouse: 'databases:view',
  troubleshooting: 'feat:ai:use',
};

export function getInternalDocumentation(topic: string, userScopes: string[]): { topic: string; content: string } {
  const content = INTERNAL_DOCS[topic];
  if (!content) {
    // Only list topics the user has access to
    const available = Object.keys(INTERNAL_DOCS).filter((t) => hasDocTopicAccess(userScopes, DOC_TOPIC_SCOPES[t]));
    return {
      topic,
      content: `Unknown topic "${topic}". Available topics: ${available.join(', ')}.`,
    };
  }
  const requiredScope = DOC_TOPIC_SCOPES[topic];
  if (!hasDocTopicAccess(userScopes, requiredScope)) {
    return { topic, content: `You do not have permission to access documentation for "${topic}".` };
  }
  return { topic, content };
}

function hasDocTopicAccess(userScopes: string[], requiredScope: string | string[] | undefined) {
  if (!requiredScope) return true;
  const scopes = Array.isArray(requiredScope) ? requiredScope : [requiredScope];
  return scopes.some((scope) => hasScopeBase(userScopes, scope));
}
