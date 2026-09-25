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
- Every scope belongs to a family named by its longest prefix that has a view scope (`proxy:*` → `proxy:view`, `docker:containers:*` → `docker:containers:view`, `nodes:*` → `nodes:details`, `docker:tasks:manage` → `docker:tasks`). Any action scope in a family implies the family's view scope, including delete scopes: `proxy:edit` and `proxy:delete` both satisfy `proxy:view`. The rule is generated from the catalog (`packages/backend/src/lib/scopes-implications.ts`) and shipped unchanged to the web UI.
- Creation scopes (every `*:create*` scope, `docker:images:pull`, `ssl:cert:issue`, and `pki:cert:issue`) name a destination and never imply any view, whatever their qualifier (broad, `folder/`, `node/`, `account/`, or a bare node ID): `proxy:create` does not satisfy `proxy:view`, and `proxy:create:folder/F` does not satisfy `proxy:view:folder/F`. Folder trees and node pickers accept creation scopes on their own to show the destinations a creator may use. The one kept rule is `hosting:snapshots:create:<vmId>` implying that VM's snapshot view.
- `proxy:maintenance:bypass` (a browser maintenance code) and `docker:registries:internal:pull` / `:push` (registry credentials) imply nothing.
- API tokens and OAuth/MCP grants expand their own folder and node targets before they are bounded by the owner's current (expanded) permissions, and are never expanded afterwards, so a token can never reach a resource its owner cannot.
- A few explicit rules complete it: access tiers (`storage:objects:admin` ⊇ `write` ⊇ `read`, `databases:query:admin` ⊇ `write` ⊇ `read`, `storage:credentials:reveal` ⊇ `storage:credentials:use`), `logs:read` and `logs:tokens:*` imply `logs:environments:view`, `nodes:manage` implies `nodes:config:view`, which implies `nodes:details`, `inference:models:manage` implies `inference:providers:view`, and `docker:availability:manage` implies `docker:containers:view`. View scopes never imply another family's view otherwise; for example `proxy:templates:view` does not grant `proxy:view`.
- Implied scopes keep the same resource boundary. For example, `databases:query:read:<databaseId>` makes that database visible in a filtered database list, but does not grant global `databases:view`; `docker:containers:manage:<nodeId>` satisfies `docker:containers:view:<nodeId>/<resourceId>`.
- `logs:schemas:view:<schemaId>` does not imply global `logs:schemas:view`. Resource-scoped schema view/edit access can list only the matching schema rows.
- Folder-tree scopes (`proxy:folders:manage`, `docker:folders:manage`, and the other `*:folders:manage` scopes except hosting snapshot folders) grant full folder-tree visibility and folder mutation rights, but not item visibility. Moving or reordering items still requires the matching item edit or manage scope.
- `pages:folders:manage` grants full Page Project folder-tree visibility and folder mutation rights, but moving or reordering Projects also requires `pages:edit:<projectId>` for every affected Project.
- Every resource-qualified Pages scope uses the Page Project ID, including Deployment, Tag, and deploy-token operations.
- Docker container scopes accept either `<nodeId>` for every container and deployment on a node or `<nodeId>/<stableResourceId>` for exactly one standalone container or blue/green deployment. Node grants cover their child resources; child grants do not cover siblings.
- Recreate and in-place update workflows preserve a standalone container's stable resource ID. Cross-node migration rewrites child grants to the target node. Explicit container or deployment deletion removes child grants, so a later same-name resource does not inherit access.
- When an API/OAuth token asks for a broad scope but the owning user has only resource-scoped access, Gateway narrows the effective token scope to the resource-scoped variant.
- Folder-scopable scopes accept `<scope>:folder/<folderId>`; the grant covers the folder, its subfolders, and every resource currently inside them. Node-bound families (routes, Pages, storage, databases, Docker, hosted VM snapshots and resources) and every creation scope accept `<scope>:node/<nodeId>`. Logging token scopes resolve folder grants through logging environment folders; `docker:availability:manage` through the granted container or Compose folder.
- With "assign created resource permissions" enabled, the creator of a resource keeps only the per-resource scopes they already hold for it (broadly, on the destination folder or node, or through an existing grant), and always view of the created resource itself, so the grant survives a later move without adding capabilities. The destination is read from the created resource when the caller does not pass it.

## Retired Scope Names

The v2.11 catalog cleanup renamed, merged, or removed these scopes. Migration `0200_scope_catalog_cleanup` rewrote every stored grant (qualifiers are kept: `old:<suffix>` becomes `new:<suffix>`), and holders of `pki:ca:create:root` also received `pki:ca:edit` and `pki:ca:export`, holders of `integrations:{github,git}:view` received `:repo:read`, holders of `integrations:{github,git}:manage` received `:repo:read` and `:repo:write`, and holders of `docker:volumes:create` (broad or on a bare node ID; not folder or `node/` destinations, and not delete-only holders) received `docker:volumes:edit` with the same qualifier. For two releases Gateway still accepts the old names on input (OAuth `scope`, API token create/update, permission group create/update, user additional permissions, and OAuth authorization edits) and rewrites them the same way; a request whose scopes were all removed is rejected. New API tokens and OAuth requests also receive these additions when the requester holds them, except manual-approval scopes such as `pki:ca:export` or `integrations:github:repo:write`, which must be requested explicitly (OAuth consent shows the additions and they can be unticked). Permission checks use only the current names.

| Retired | Replacement |
|---------|-------------|
| ssl:cert:revoke, ssl:cert:export | Removed (never enforced). |
| notifications:view | notifications:alerts:view, notifications:webhooks:view |
| notifications:manage | notifications:alerts:manage, notifications:webhooks:manage |
| notifications:alerts:create, :edit, :delete | notifications:alerts:manage |
| notifications:webhooks:create, :edit, :delete | notifications:webhooks:manage |
| notifications:deliveries:view | notifications:webhooks:view |
| logs:manage | Every logs:* scope. |
| docker:containers:config | Removed. Duplicate and recreate require environment and secrets; a Docker node's service address requires nodes:manage. |
| nodes:config:edit | nodes:manage |
| pki:ca:view:root, pki:ca:view:intermediate | pki:ca:view |
| integrations:gitlab:sync, :github:sync, :git:sync | integrations:<provider>:manage |
| integrations:gitlab:system, :github:system, :git:system | integrations:<provider>:use |
| integrations:gitlab:projects:view | integrations:gitlab:view (listing synced projects is connector metadata) |
| integrations:gitlab:ci:view, :variables:view | integrations:gitlab:repo:read (repository files, CI pipelines and job logs, and CI/CD variable keys) |
| integrations:gitlab:ci:edit, :variables:edit, :variables:delete, :webhooks:manage, :registry:manage | integrations:gitlab:repo:write |
| proxy:raw:toggle | Removed; toggling raw mode requires proxy:raw:write. |
| proxy:advanced:bypass, proxy:raw:bypass | proxy:unrestricted |
| proxy:templates:create, :edit, :delete | proxy:templates:manage |
| docker:containers:folders:manage | docker:folders:manage |

Legacy global nginx management routes under `/api/monitoring/nginx/*` are no longer exposed. Node-specific nginx monitoring, config, and logs remain governed by node scopes.

## Scope List

| Scope | Resource-scopable |
|-------|-------------------|
| `storage:view` | Resource-scopable storage or backup permission. |
| `storage:create` | Create storage in permitted folders or nodes. |
| `storage:edit` | Resource-scopable storage or backup permission. |
| `storage:delete` | Resource-scopable storage or backup permission. |
| `storage:credentials:reveal` | Resource-scopable storage or backup permission. |
| `storage:credentials:use` | Resource-scopable storage or backup permission. Lets backups use the saved credentials without revealing them; implied by `storage:credentials:reveal`. |
| `storage:iam` | Manage storage access keys | Yes |
| `storage:objects:read` | Resource-scopable storage or backup permission. |
| `storage:objects:write` | Resource-scopable storage or backup permission. |
| `storage:objects:admin` | Resource-scopable storage or backup permission. |
| `storage:folders:manage` | Manage storage resource folders. |
| `databases:backups:view` | Resource-scopable storage or backup permission. |
| `databases:backups:manage` | Resource-scopable storage or backup permission. |
| `databases:backups:run` | Resource-scopable storage or backup permission. |
| `databases:backups:restore` | Resource-scopable storage or backup permission. |
| `nodes:backups:execute` | Resource-scopable storage or backup permission. |
| `pki:ca:view` | Yes. View certificate authorities; restrictable to CA ID. Replaces `pki:ca:view:root` and `pki:ca:view:intermediate`. |
| `pki:ca:create:root` |  |
| `pki:ca:create:intermediate` | Yes |
| `pki:ca:edit` | Yes. Edit CA settings (CRL and CA issuer URLs, maximum validity) and the OCSP responder; restrictable to CA ID. |
| `pki:ca:export` | Yes. Export a CA private key; restrictable to CA ID. Requires manual OAuth approval. |
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
| `proxy:advanced` | Yes |
| `proxy:unrestricted` | Yes. Apply unrestricted advanced nginx snippets and raw configs that bypass dangerous-directive validation. Replaces `proxy:advanced:bypass` and `proxy:raw:bypass`. |
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
| `proxy:templates:manage` | Yes. Create, edit, and delete nginx templates, including template content. Replaces `proxy:templates:create`, `:edit`, and `:delete`. |
| `ssl:cert:view` | Yes |
| `ssl:cert:issue` |  |
| `ssl:cert:folders:manage` | Yes |
| `ssl:cert:delete` | Yes |
| `acl:view` | Yes |
| `acl:create` |  |
| `acl:edit` | Yes |
| `acl:delete` | Yes |
| `nodes:details` | Yes |
| `nodes:create` |  |
| `nodes:rename` | Yes |
| `nodes:delete` | Yes |
| `nodes:manage` | Yes. General node control: global nginx config, Docker secure runtime install, the service addresses of Docker, Nginx, database, and storage nodes (no `nodes:rename` needed), and hosted VM power, resize, and snapshot restore. Replaces `nodes:config:edit`. |
| `nodes:config:view` | Yes |
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
| `integrations:gitlab:view` | View GitLab connectors, their sync status, and their synced projects. Absorbs `projects:view`. |
| `integrations:gitlab:manage` | Configure, test, and synchronize GitLab connectors. |
| `integrations:gitlab:use` | Use the GitLab connector system credential. Replaces `integrations:gitlab:system`. |
| `integrations:gitlab:repo:read` | Read GitLab repository content, CI pipelines and job logs, and CI/CD variable keys (never values; these can still be sensitive). Absorbs `ci:view` and `variables:view`. |
| `integrations:gitlab:repo:write` | Write GitLab repository content, CI configuration, CI/CD variables, webhooks, and container registry state. Absorbs `ci:edit`, `variables:edit`, `variables:delete`, `webhooks:manage`, and `registry:manage`. |
| `integrations:gitlab:sandbox:clone` |  |
| `integrations:github:view` |  |
| `integrations:github:manage` | Configure, test, and synchronize GitHub connectors. |
| `integrations:github:use` | Use GitHub connector system credentials. Replaces `integrations:github:system`. |
| `integrations:github:repo:read` | List and read GitHub repositories and their files; no Actions variable values. |
| `integrations:github:repo:write` | Write GitHub repository files and secrets, and read or change Actions variables. |
| `integrations:git:view` |  |
| `integrations:git:manage` | Configure, test, and synchronize generic Git connectors. |
| `integrations:git:use` | Use generic Git connector system credentials. Replaces `integrations:git:system`. |
| `integrations:git:repo:read` | List and read generic Git repositories and their files. |
| `integrations:git:repo:write` | Write generic Git repository files. |
| `integrations:ssh:view` |  |
| `integrations:ssh:manage` |  |
| `integrations:ssh:use` |  |
| `integrations:cloudflare:view` |  |
| `integrations:cloudflare:manage` |  |
| `integrations:cloudflare:sync` |  |
| `integrations:hosting:view` | View hosting accounts; restrictable to connector ID. |
| `integrations:hosting:manage` | Configure and synchronize hosting accounts; restrictable to connector ID. |
| `hosting:resources:view` | View provider inventory; restrictable to connector ID. |
| `hosting:resources:create` | Create hosted nodes; restrictable to connector ID. Also requires `nodes:create`. |
| `hosting:resources:power` | Start, shut down or reboot a hosted VM; restrictable to resource ID. |
| `hosting:resources:resize` | Resize a hosted VM; restrictable to resource ID. |
| `hosting:snapshots:view` | View VM snapshots and folders; restrictable to resource ID. Snapshot mutation permissions imply view only for the same resource. Also requires VM inventory and bound-node details access. |
| `hosting:snapshots:create` | Create a VM snapshot without requiring shutdown; restrictable to resource ID. Also requires configuration access to bound nodes. Optional `includeRam` is supported only for running Proxmox VMs and defaults to disk-only snapshots. |
| `hosting:snapshots:delete` | Delete a VM snapshot; restrictable to resource ID. |
| `hosting:snapshots:restore` | Restore a VM snapshot, replacing disk data; restrictable to resource ID. Proxmox handles stopping a running VM during rollback; Gateway requests restart if it was running immediately before dispatch. Other providers currently require a stopped VM. |
| `hosting:snapshots:folders:manage` | Create folders and organize VM snapshots; restrictable to resource ID. |
| `hosting:resources:delete` | Destroy a hosted VM or cancel a HOSTKEY rental; restrictable to resource ID. |
| `hosting:resources:recover` | Restart a hosted daemon through an available independent channel; restrictable to resource ID. |
| `hosting:billing:view` | Read account finances; restrictable to connector ID. Never implied by node access. |
| `hosting:billing:topup` | Create a HOSTKEY deposit invoice; restrictable to connector ID. |
| `housekeeping:view` |  |
| `housekeeping:run` |  |
| `housekeeping:configure` |  |
| `license:view` |  |
| `license:manage` |  |
| `ai:workspace:use` | Use AI Workspace. Granted to the built-in viewer group and above. |
| `feat:ai:use` | Use Gateway Inference, view personal usage, and create or revoke personal inference tokens. |
| `feat:ai:configure` |  |
| `ai:skills:manage` | Manage shared user-defined AI Workspace skills. |
| `ai:sandbox:use` |  |
| `ai:sandbox:tier:medium` |  |
| `ai:sandbox:tier:high` |  |
| `ai:sandbox:manage` |  |
| `mcp:use` |  |
| `inference:setup` | OAuth-only companion setup token scope; not assignable to users or groups. |
| `inference:providers:view` |  |
| `inference:providers:manage` |  |
| `inference:models:manage` |  |
| `inference:limits:manage` |  |
| `inference:usage:view` |  |
| `docker:containers:view` | Yes |
| `docker:containers:create` | Yes |
| `docker:containers:edit` | Yes |
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
| `docker:availability:manage` | Yes. Folder grants resolve through the granted container or Compose folder. |
| `docker:folders:manage` | Manage folders for Docker containers, deployments, Compose projects, networks, volumes, and images. Replaces `docker:containers:folders:manage`. |
| `docker:compose:view` | Yes |
| `docker:compose:create` | Yes |
| `docker:compose:manage` | Yes |
| `docker:compose:delete` | Yes |
| `docker:images:view` | Yes |
| `docker:images:pull` | Yes |
| `docker:images:delete` | Yes |
| `docker:volumes:view` | Yes |
| `docker:volumes:create` | Yes |
| `docker:volumes:edit` | Yes. Rename, relabel, resize, and adopt one volume; restrictable to node, volume, or folder. |
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
| `notifications:alerts:view` | View alert rules. |
| `notifications:alerts:manage` | Create, edit, and delete alert rules. |
| `notifications:webhooks:view` | View notification webhooks and their delivery history. |
| `notifications:webhooks:manage` | Create, edit, test, and delete notification webhooks. |
| `logs:environments:view` | Yes |
| `logs:environments:create` |  |
| `logs:environments:edit` | Yes |
| `logs:environments:delete` | Yes |
| `logs:environments:folders:manage` |  |
| `logs:tokens:view` | Yes. Folder grants resolve through logging environment folders. |
| `logs:tokens:create` | Yes. Folder grants resolve through logging environment folders. |
| `logs:tokens:delete` | Yes. Folder grants resolve through logging environment folders. |
| `logs:schemas:view` | Yes |
| `logs:schemas:create` |  |
| `logs:schemas:edit` | Yes |
| `logs:schemas:delete` | Yes |
| `logs:schemas:folders:manage` |  |
| `logs:read` | Yes |
| `status-page:view` |  |
| `status-page:manage` |  |
| `status-page:incidents:create` |  |
| `status-page:incidents:update` |  |
| `status-page:incidents:resolve` |  |
| `status-page:incidents:delete` |  |

## API Token Delegation

API tokens and OAuth grants (for both the Gateway API and Gateway MCP resources) can carry every scope a user can hold, so programmatic clients and MCP agents can do everything a user can do with Gateway resources: node enrollment and configuration, raw nginx config, users and permission groups, Gateway settings, integrations, hosting resources, inference administration, relay control, and updates. Only browser- or identity-bound capabilities are excluded. They cannot be granted:

| Scope | Reason |
|-------|--------|
| `ai:workspace:use` | User-only AI Workspace chat access. |
| `feat:ai:configure` | User-only AI Workspace configuration. |
| `ai:skills:manage` | User-only shared AI skill management. |
| `ai:sandbox:use` | User-only AI sandbox runner access. |
| `ai:sandbox:tier:medium` | User-only AI sandbox runner tier access. |
| `ai:sandbox:tier:high` | User-only AI sandbox runner tier access. |
| `ai:sandbox:manage` | User-only AI sandbox runner management. |
| `mcp:use` | User-account capability gate for remote MCP. |
| `inference:setup` | OAuth-only companion CLI authorization resource; not assignable to users or groups. |
| `admin:users:impersonate` | Impersonation replaces the caller's browser session with another user's session. |
| `integrations:gitlab:sandbox:clone` | Clones repositories into the AI sandbox working copy and also requires `ai:sandbox:use`. |

`mcp:use` is not a token scope. It gates whether the owning user account may use the MCP endpoint at all. MCP tokens use ordinary delegated Gateway scopes such as `nodes:details`, `proxy:view`, or `docker:containers:view` to determine which MCP tools and resources are available.

Gateway MCP delegates the same scopes as API tokens, including GitLab, GitHub, generic Git, Cloudflare, hosting, and external SSH connector administration and operations. Managed DNS access uses the ordinary `domains:*` scopes.

Some operations stay browser-only regardless of scopes because they are bound to the caller's identity or browser: sign-in, password, MFA, passkeys, the caller's own sessions and preferences, starting impersonation, OAuth consent, creating or editing API tokens and OAuth authorizations (a token must not mint Gateway credentials), per-user Git credentials, AI Workspace chat, UI bootstrap, and the post-setup onboarding checklist. Gateway settings, user/group administration, node config, raw nginx config, hosting, inference administration and personal `gwi_` inference keys (with `feat:ai:use` on the token), relay control, and updates accept API and OAuth tokens.

Account-level baseline scopes that gate a whole route family (for example `feat:ai:use` in front of inference administration) are evaluated against the token owner's live permissions for bearer callers; the token still needs the route's own delegated scope. Personal inference key management requires `feat:ai:use` on the token itself.

Git providers (GitLab, GitHub, generic Git) share the same verbs: `integrations:<provider>:view` lists connectors, `:manage` configures, tests, and synchronizes them, `:use` uses the connector's system credential, and `:repo:read` / `:repo:write` read or write repository content (files, CI, secrets, webhooks, registry). Listing GitLab's synced projects is connector metadata under `integrations:gitlab:view`. GitLab `:repo:read` includes CI job logs and CI/CD variable keys (never values); GitHub Actions variable values are secrets, so reading them needs `integrations:github:repo:write`. `integrations:cloudflare:sync` lets API and OAuth tokens resync a Cloudflare connector without holding `integrations:cloudflare:manage`. External SSH has no sync scope: its connection re-test authenticates with the stored credential and stays under `integrations:ssh:manage`.

## OAuth Manual Approval Scopes

OAuth consent leaves high-risk scopes unchecked by default. The user must explicitly select them in the consent UI. Resource-scoped variants are covered by their base scope, for example `pki:cert:export:<certificateId>` is treated as `pki:cert:export`.

| Scope | Risk |
|-------|------|
| `storage:credentials:reveal` | Reveals storage credentials. |
| `storage:iam` | Issues and revokes credentials |
| `databases:backups:restore` | Restores database contents into an authorized target. |
| `pki:ca:create:root` | Can create trust anchors. |
| `pki:ca:create:intermediate` | Can create subordinate CAs. |
| `pki:ca:export` | Can export CA private keys. |
| `pki:ca:revoke:root` | Can revoke or delete root CAs. |
| `pki:ca:revoke:intermediate` | Can revoke or delete intermediate CAs. |
| `pki:cert:export` | Can export certificates with private key material. |
| `ssl:cert:issue` | Can upload/provision certificates and private keys. |
| `ssl:cert:delete` | Can remove deployed SSL certificates. |
| `proxy:raw:write` | Can write raw nginx server config for routes. |
| `proxy:unrestricted` | Can apply unrestricted advanced nginx snippets and raw configs that bypass dangerous-directive validation. |
| `proxy:templates:manage` | Can write nginx template content, which is raw nginx configuration. |
| `pages:delete` | Can delete Page Projects after their dependencies and retained Deployments are removed. |
| `pages:tokens:manage` | Can create and revoke Project deploy credentials. |
| `pages:settings:edit` | Can configure or migrate the public wildcard Pages profile. |
| `nodes:manage` | Can replace a node's global nginx config, install the Docker secure runtime, change a node's service addresses, and power, resize, or restore hosted VMs. |
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
| `integrations:gitlab:use` | Can use the system GitLab credential. |
| `integrations:gitlab:repo:write` | Can modify repositories, CI configuration, CI/CD variables, webhooks, and registry state through connected GitLab projects. |
| `integrations:gitlab:sandbox:clone` | Can clone connected GitLab repositories into AI sandboxes. |
| `integrations:github:use` | Can use GitHub connector system credentials. |
| `integrations:github:repo:write` | Can modify GitHub repository files and secrets, and read or modify Actions variables. |
| `integrations:git:use` | Can use generic Git connector system credentials. |
| `integrations:git:repo:write` | Can modify generic Git repository files. |
| `integrations:ssh:use` | Can run commands on hosts behind external SSH connectors. |
| `integrations:hosting:manage` | Can create, reconfigure, and read secrets of hosting provider connectors. |
| `hosting:resources:create` | Can order paid VMs and install nodes on them. |
| `hosting:resources:delete` | Can destroy VMs or cancel rentals. |
| `hosting:snapshots:restore` | Can roll a VM back to a snapshot. |
| `hosting:billing:topup` | Can request provider deposit invoices. |
| `logs:tokens:create` | Can mint logging ingest tokens. |
| `feat:ai:use` | Can use Gateway Inference and mint or revoke the user's `gwi_` inference keys. |
| `admin:audit` | Can read audit history. |
| `audit:siem:manage` | Can configure authenticated SIEM endpoints and replay failed audit exports. |
| `admin:details:certificates` | Can view internal system PKI and SSL certificates. |
| `admin:update` | Can check for and apply Gateway/daemon updates. |
| `admin:system` | Protected system administration: deleted-user restore, MFA reset, relay control. |
| `admin:users` | Can create, reconfigure, block, and delete users and revoke their sessions. |
| `admin:groups` | Can create and change permission groups and their scopes. |
| `settings:gateway:edit` | Can change authentication and control-plane settings. |
