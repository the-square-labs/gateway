# Permission Scopes

All scopes follow `domain:resource:action[:qualifier]`. Resource-scopable scopes may be limited with a resource suffix, for example `logs:schemas:view:<schemaId>`.

## Built-in Groups

| Group | Description |
|-------|-------------|
| `system-admin` | All canonical scopes, including protected `admin:system`. |
| `admin` | Curated broad access, excluding `admin:system`, gateway settings edit, housekeeping configure, and Docker registry mutation defaults. |
| `operator` | Operational access for day-to-day PKI, proxy, SSL, ACL, node, Docker container, database, notification, and logging read/query work. |
| `viewer` | Read-only view/discovery access. |
| `guest` | Authenticated account access without infrastructure permissions. |

## Programmatic Access

Gateway has four token families:

| Prefix | Purpose |
|--------|---------|
| `gw_` | API token for REST API automation. |
| `gwo_` | OAuth access token for one OAuth resource. |
| `gwl_` | External logging ingest token. |
| `gwi_` | Dedicated Gateway Inference runtime token. |

OAuth tokens are bound to exactly one resource:

| Resource | URL path | Accepted by |
|----------|----------|-------------|
| Gateway API | `/api` | REST API routes |
| Gateway MCP | `/api/mcp` | Remote MCP endpoint |

The REST API accepts browser sessions, `gw_` API tokens, and `gwo_` OAuth tokens issued for the Gateway API resource. The MCP endpoint accepts only `gwo_` OAuth tokens issued for the Gateway MCP resource; API tokens, browser cookies, logging tokens, and inference tokens are rejected. Inference data-plane routes accept only `gwi_` tokens.

OAuth lifetime behavior is resource-specific:

- Gateway API OAuth uses expiring access tokens and refresh-token renewal.
- Gateway MCP OAuth is intended for long-lived MCP access and does not rely on refresh-token churn during normal use.

Delegated API/OAuth scopes are always bounded by the owning user's current effective scopes. Revoking or editing a user's group permissions also reduces the effective permissions of that user's existing tokens.

## Scope Evaluation Behavior

Gateway evaluates scopes with exact, broad, resource-scoped, and implied-scope rules:

- A broad resource-scopable scope grants access to every resource for that base scope. For example, `proxy:view` grants `proxy:view:<hostId>`.
- A resource-scoped scope grants access only to that resource. For example, `proxy:edit:<hostA>` grants read/edit access to `hostA`, but not to `hostB` and not to broad `proxy:view`.
- List APIs and list pages are derived from view/detail permissions. Broad view lists every visible resource of that type; resource-scoped view lists only matching rows.
- Write-capable scopes satisfy the matching read/view checks needed to use the resource. For example, `proxy:edit` satisfies `proxy:view`; `databases:query:admin` satisfies `databases:query:write` and `databases:query:read`.
- Resource-scoped write-capable scopes keep the same resource boundary. For example, `databases:query:read:<databaseId>` can make that database visible in a filtered database list, but it does not grant global `databases:view`.
- Create-only and destructive-only scopes do not imply view/discovery access. For example, `proxy:create`, `proxy:delete`, `databases:create`, and `notifications:webhooks:create` do not grant browse permissions by themselves.
- `logs:schemas:view:<schemaId>` does not imply global `logs:schemas:view`. Resource-scoped schema view/edit access can list only the matching schema rows.
- `proxy:folders:manage` and `docker:containers:folders:manage` grant full folder-tree visibility and folder mutation rights, but not item visibility. Moving or reordering items still requires the matching item edit or manage scope.
- `pages:folders:manage` grants full Page Project folder-tree visibility and folder mutation rights, but moving or reordering Projects also requires `pages:edit:<projectId>` for every affected Project.
- Every resource-qualified Pages scope uses the Page Project ID, including Deployment, Tag, and deploy-token operations.
- Docker container scopes accept either `<nodeId>` for every container and deployment on a node or `<nodeId>/<stableResourceId>` for exactly one standalone container or blue/green deployment. Node grants cover their child resources; child grants do not cover siblings.
- Recreate and in-place update workflows preserve a standalone container's stable resource ID. Cross-node migration rewrites child grants to the target node. Explicit container or deployment deletion removes child grants, so a later same-name resource does not inherit access.
- When an API/OAuth token asks for a broad scope but the owning user has only resource-scoped access, Gateway narrows the effective token scope to the resource-scoped variant.

Legacy global nginx management routes under `/api/monitoring/nginx/*` are no longer exposed. Node-specific nginx monitoring, config, and logs remain governed by node scopes.

## Scope List

| Scope | Resource-scopable |
|-------|-------------------|
| `pki:ca:view:root` |  |
| `pki:ca:view:intermediate` |  |
| `pki:ca:create:root` |  |
| `pki:ca:create:intermediate` | Yes |
| `pki:ca:revoke:root` |  |
| `pki:ca:revoke:intermediate` |  |
| `pki:cert:view` | Yes |
| `pki:cert:issue` | Yes |
| `pki:cert:revoke` | Yes |
| `pki:cert:export` | Yes |
| `pki:templates:view` |  |
| `pki:templates:create` |  |
| `pki:templates:edit` |  |
| `pki:templates:delete` |  |
| `domains:view` |  |
| `domains:create` |  |
| `domains:edit` |  |
| `domains:delete` |  |
| `domains:folders:manage` |  |
| `proxy:view` | Yes |
| `proxy:create` | Yes |
| `proxy:edit` | Yes |
| `proxy:delete` | Yes |
| `proxy:raw:read` | Yes |
| `proxy:raw:write` | Yes |
| `proxy:raw:toggle` | Yes |
| `proxy:raw:bypass` | Yes |
| `proxy:advanced` | Yes |
| `proxy:advanced:bypass` | Yes |
| `proxy:maintenance:bypass` | Yes |
| `proxy:folders:manage` |  |
| `pages:view` | Yes |
| `pages:create` |  |
| `pages:edit` | Yes |
| `pages:delete` | Yes |
| `pages:deploy` | Yes |
| `pages:deployments:manage` | Yes |
| `pages:tags:manage` | Yes |
| `pages:tokens:manage` | Yes |
| `pages:folders:manage` |  |
| `pages:settings:view` |  |
| `pages:settings:edit` |  |
| `proxy:templates:view` | Yes |
| `proxy:templates:create` |  |
| `proxy:templates:edit` | Yes |
| `proxy:templates:delete` | Yes |
| `ssl:cert:view` | Yes |
| `ssl:cert:issue` |  |
| `ssl:cert:delete` | Yes |
| `ssl:cert:revoke` | Yes |
| `ssl:cert:export` | Yes |
| `acl:view` | Yes |
| `acl:create` |  |
| `acl:edit` | Yes |
| `acl:delete` | Yes |
| `nodes:details` | Yes |
| `nodes:create` |  |
| `nodes:rename` | Yes |
| `nodes:delete` | Yes |
| `nodes:config:view` | Yes |
| `nodes:config:edit` | Yes |
| `nodes:logs` | Yes |
| `nodes:console` | Yes |
| `nodes:files:read` | Yes |
| `nodes:files:write` | Yes |
| `nodes:lock` | Yes |
| `nodes:folders:manage` |  |
| `admin:users` |  |
| `admin:users:impersonate` |  |
| `admin:users:folders:manage` |  |
| `admin:groups` |  |
| `admin:groups:folders:manage` |  |
| `admin:audit` |  |
| `audit:siem:view` |  |
| `audit:siem:manage` |  |
| `admin:system` |  |
| `admin:details:certificates` |  |
| `admin:update` |  |
| `admin:alerts` |  |
| `settings:gateway:view` |  |
| `settings:gateway:edit` |  |
| `integrations:gitlab:view` |  |
| `integrations:gitlab:manage` |  |
| `integrations:gitlab:sync` |  |
| `integrations:gitlab:system` |  |
| `integrations:gitlab:projects:view` |  |
| `integrations:gitlab:repo:read` |  |
| `integrations:gitlab:repo:write` |  |
| `integrations:gitlab:ci:view` |  |
| `integrations:gitlab:ci:edit` |  |
| `integrations:gitlab:variables:view` |  |
| `integrations:gitlab:variables:edit` |  |
| `integrations:gitlab:variables:delete` |  |
| `integrations:gitlab:webhooks:manage` |  |
| `integrations:gitlab:registry:manage` |  |
| `integrations:gitlab:sandbox:clone` |  |
| `integrations:github:view` |  |
| `integrations:github:manage` |  |
| `integrations:github:system` |  |
| `integrations:git:view` |  |
| `integrations:git:manage` |  |
| `integrations:git:system` |  |
| `integrations:ssh:view` |  |
| `integrations:ssh:manage` |  |
| `integrations:ssh:use` |  |
| `integrations:cloudflare:view` |  |
| `integrations:cloudflare:manage` |  |
| `housekeeping:view` |  |
| `housekeeping:run` |  |
| `housekeeping:configure` |  |
| `license:view` |  |
| `license:manage` |  |
| `ai:workspace:use` | Use AI Workspace. Granted to the built-in viewer group and above. |
| `feat:ai:use` | Use Gateway Inference, including personal inference usage. |
| `feat:ai:configure` |  |
| `ai:skills:manage` | Manage shared user-defined AI Workspace skills. |
| `ai:sandbox:use` |  |
| `ai:sandbox:tier:medium` |  |
| `ai:sandbox:tier:high` |  |
| `ai:sandbox:manage` |  |
| `mcp:use` |  |
| `inference:setup` | OAuth-only companion setup token scope; not assignable to users or groups. |
| `inference:tokens:manage` |  |
| `inference:providers:view` |  |
| `inference:providers:manage` |  |
| `inference:models:manage` |  |
| `inference:limits:manage` |  |
| `inference:usage:view` |  |
| `docker:containers:view` | Yes |
| `docker:containers:create` | Yes |
| `docker:containers:edit` | Yes |
| `docker:containers:config` | Yes |
| `docker:containers:manage` | Yes |
| `docker:containers:environment` | Yes |
| `docker:containers:delete` | Yes |
| `docker:containers:console` | Yes |
| `docker:containers:files:read` | Yes |
| `docker:containers:files:write` | Yes |
| `docker:containers:export` | Yes |
| `docker:containers:secrets` | Yes |
| `docker:containers:webhooks` | Yes |
| `docker:containers:mounts` | Yes |
| `docker:containers:migrate` | Yes |
| `docker:containers:folders:manage` |  |
| `docker:compose:view` | Yes |
| `docker:compose:create` | Yes |
| `docker:compose:manage` | Yes |
| `docker:compose:delete` | Yes |
| `docker:images:view` | Yes |
| `docker:images:pull` | Yes |
| `docker:images:delete` | Yes |
| `docker:volumes:view` | Yes |
| `docker:volumes:create` | Yes |
| `docker:volumes:delete` | Yes |
| `docker:volumes:export` | Yes |
| `docker:volumes:files:read` | Yes |
| `docker:volumes:files:write` | Yes |
| `docker:networks:view` | Yes |
| `docker:networks:create` | Yes |
| `docker:networks:edit` | Yes |
| `docker:networks:delete` | Yes |
| `docker:registries:view` |  |
| `docker:registries:create` |  |
| `docker:registries:edit` |  |
| `docker:registries:delete` |  |
| `docker:registries:internal:pull` | Repository-scopable access to pull artifacts from the internal registry. |
| `docker:registries:internal:push` | Repository-scopable access to push artifacts to the internal registry. |
| `docker:tasks` |  |
| `docker:tasks:manage` | Yes |
| `databases:view` | Yes |
| `databases:create` |  |
| `databases:edit` | Yes |
| `databases:delete` | Yes |
| `databases:query:read` | Yes |
| `databases:query:write` | Yes |
| `databases:query:admin` | Yes |
| `databases:credentials:reveal` | Yes |
| `databases:folders:manage` |  |
| `notifications:alerts:view` |  |
| `notifications:alerts:create` |  |
| `notifications:alerts:edit` |  |
| `notifications:alerts:delete` |  |
| `notifications:webhooks:view` |  |
| `notifications:webhooks:create` |  |
| `notifications:webhooks:edit` |  |
| `notifications:webhooks:delete` |  |
| `notifications:deliveries:view` |  |
| `notifications:view` |  |
| `notifications:manage` |  |
| `logs:environments:view` | Yes |
| `logs:environments:create` |  |
| `logs:environments:edit` | Yes |
| `logs:environments:delete` | Yes |
| `logs:environments:folders:manage` |  |
| `logs:tokens:view` | Yes |
| `logs:tokens:create` | Yes |
| `logs:tokens:delete` | Yes |
| `logs:schemas:view` | Yes |
| `logs:schemas:create` |  |
| `logs:schemas:edit` | Yes |
| `logs:schemas:delete` | Yes |
| `logs:schemas:folders:manage` |  |
| `logs:read` | Yes |
| `logs:manage` |  |
| `status-page:view` |  |
| `status-page:manage` |  |
| `status-page:incidents:create` |  |
| `status-page:incidents:update` |  |
| `status-page:incidents:resolve` |  |
| `status-page:incidents:delete` |  |

## API Token Delegation

API and OAuth tokens can be granted all scopes except the protected user/session-only scopes listed below. They cannot be granted:

| Scope | Reason |
|-------|--------|
| `ai:workspace:use` | User/session-only AI Workspace access. |
| `feat:ai:use` | User/session-only Gateway Inference access. |
| `feat:ai:configure` | User/session-only AI configuration. |
| `ai:skills:manage` | User/session-only shared AI skill management. |
| `ai:sandbox:use` | User/session-only sandbox runner access. |
| `ai:sandbox:tier:medium` | User/session-only sandbox runner tier access. |
| `ai:sandbox:tier:high` | User/session-only sandbox runner tier access. |
| `ai:sandbox:manage` | User/session-only sandbox runner management. |
| `mcp:use` | User-account capability gate for remote MCP. |
| `inference:setup` | OAuth-only companion CLI authorization resource; not assignable to users or groups. |
| `inference:tokens:manage` | User/session-only inference token creation and revocation. |
| `admin:system` | Protected system-administrator shielding. |
| `admin:users` | User administration is session-only. |
| `admin:users:impersonate` | Browser-only protected user impersonation. |
| `admin:groups` | Permission group administration is session-only. |
| `settings:gateway:view` | Gateway auth/control-plane settings are session-only. |
| `settings:gateway:edit` | Gateway auth/control-plane settings are session-only. |
| `integrations:gitlab:manage` | GitLab connector administration is session-only. |
| `integrations:gitlab:system` | System GitLab credential access is session-only. |
| `integrations:github:manage` | GitHub connector administration is session-only. |
| `integrations:github:system` | GitHub connector system credentials are session-only. |
| `integrations:git:manage` | Generic Git connector administration is session-only. |
| `integrations:git:system` | Generic Git connector system credentials are session-only. |
| `integrations:ssh:manage` | External SSH connector administration is session-only. |
| `integrations:cloudflare:manage` | Cloudflare connector administration is session-only. |
| `proxy:raw:read` | Raw nginx config is session-only. |
| `proxy:raw:write` | Raw nginx config is session-only. |
| `proxy:raw:toggle` | Raw nginx mode is session-only. |
| `proxy:raw:bypass` | Dangerous raw nginx directive bypass is session-only. |
| `proxy:advanced:bypass` | Unrestricted advanced nginx snippets are session-only. |
| `proxy:maintenance:bypass` | Maintenance access code issuance is session-only. |
| `nodes:config:view` | Global node nginx config is session-only. |
| `nodes:config:edit` | Global node nginx config is session-only. |
| `inference:providers:view` | Inference provider credentials and account state are session-only. |
| `inference:providers:manage` | Inference provider administration is session-only. |
| `inference:models:manage` | Inference model publication is session-only. |
| `inference:limits:manage` | Inference budget administration is session-only. |
| `inference:usage:view` | System-wide inference accounting is session-only. |

`mcp:use` is not a token scope. It gates whether the owning user account may use the MCP endpoint at all. MCP tokens use ordinary delegated Gateway scopes such as `nodes:details`, `proxy:view`, or `docker:containers:view` to determine which MCP tools and resources are available.

Gateway MCP does not delegate `integrations:gitlab:*`, `integrations:github:*`, `integrations:git:*`, or `integrations:ssh:*` scopes. Source-control repository, CI, variable, webhook, registry, and external SSH operations belong to dedicated provider MCP servers rather than Gateway's control-plane MCP. Managed DNS access uses the ordinary `domains:*` scopes; `integrations:cloudflare:*` is limited to connector visibility and administration.

## OAuth Manual Approval Scopes

OAuth consent leaves high-risk scopes unchecked by default. The user must explicitly select them in the consent UI. Resource-scoped variants are covered by their base scope, for example `pki:cert:export:<certificateId>` is treated as `pki:cert:export`.

| Scope | Risk |
|-------|------|
| `pki:ca:create:root` | Can create trust anchors and currently gates CA private-key export. |
| `pki:ca:create:intermediate` | Can create subordinate CAs. |
| `pki:ca:revoke:root` | Can revoke or delete root CAs. |
| `pki:ca:revoke:intermediate` | Can revoke or delete intermediate CAs. |
| `pki:cert:export` | Can export certificates with private key material. |
| `ssl:cert:issue` | Can upload/provision certificates and private keys. |
| `ssl:cert:delete` | Can remove deployed SSL certificates. |
| `ssl:cert:revoke` | Can revoke SSL certificates. |
| `ssl:cert:export` | Reserved for SSL certificate export capability. |
| `proxy:raw:bypass` | Can bypass dangerous directive validation for raw nginx config. |
| `pages:delete` | Can delete Page Projects after their dependencies and retained Deployments are removed. |
| `pages:tokens:manage` | Can create and revoke Project deploy credentials. |
| `pages:settings:edit` | Can configure or migrate the public wildcard Pages profile. |
| `nodes:console` | Can open an interactive shell on nodes. |
| `nodes:files:read` | Can read files from managed node filesystems. |
| `nodes:files:write` | Can create, modify, move, or delete files on managed nodes. |
| `docker:containers:console` | Can open an interactive console in containers. |
| `docker:containers:files:read` | Can browse and read container filesystem contents. |
| `docker:containers:files:write` | Can create, modify, move, or delete container filesystem contents. |
| `docker:containers:export` | Can export a container as a portable Gateway archive. |
| `docker:containers:secrets` | Can reveal and manage encrypted container/deployment secrets. |
| `docker:containers:mounts` | Can add, remove, or change container/deployment mounts within the managed-volume policy. New host bind mounts are prohibited. |
| `docker:containers:migrate` | Can move containers or deployments and their data between Docker nodes. |
| `docker:volumes:export` | Can export a Docker volume as a portable archive. |
| `docker:volumes:files:read` | Can read files from Docker volumes. |
| `docker:volumes:files:write` | Can create, modify, move, or delete files in Docker volumes. |
| `databases:query:read` | Can read data from database resources. |
| `databases:query:write` | Can modify data in database resources. |
| `databases:query:admin` | Can run administrative database commands. |
| `databases:credentials:reveal` | Can reveal stored database credentials and connection strings. This does not reveal a binding's injected application secret by default. |
| `integrations:gitlab:repo:write` | Can modify repositories through connected GitLab projects. |
| `integrations:gitlab:ci:edit` | Can modify GitLab CI configuration and trigger write-capable CI operations. |
| `integrations:gitlab:variables:edit` | Can create or update GitLab CI/CD variables. |
| `integrations:gitlab:variables:delete` | Can delete GitLab CI/CD variables. |
| `integrations:gitlab:webhooks:manage` | Can create, update, or delete GitLab webhooks. |
| `integrations:gitlab:registry:manage` | Can mutate GitLab container registry state. |
| `integrations:gitlab:sandbox:clone` | Can clone connected GitLab repositories into AI sandboxes. |
| `logs:tokens:create` | Can mint logging ingest tokens. |
| `admin:audit` | Can read audit history. |
| `audit:siem:manage` | Can configure authenticated SIEM endpoints and replay failed audit exports. |
| `admin:details:certificates` | Can view internal system PKI and SSL certificates. |
| `admin:update` | Can check for and apply Gateway/daemon updates. |
