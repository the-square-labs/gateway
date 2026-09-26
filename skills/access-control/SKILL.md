---
name: access-control
description: Administer Gateway identity and access, including users, permission groups, scopes, folder, node, and resource restrictions, API tokens, OAuth and MCP grants, and impersonation limits. Use when asked to create, block, or delete a user, change someone's permissions, design a least-privilege scope set for an integration or agent, or explain what a token or OAuth grant can and cannot do. Use after using-gateway has confirmed the Gateway MCP connection.
---

# Access Control

Start with `using-gateway` for connection, discovery, and safety rules; its connection reference explains how scopes bound an MCP session. Read `read_gateway_documentation({ topic: "permissions" })` (also `users`, `authentication`) before changing access, and check a specific scope in the [Scopes reference](https://docs.goodgateway.dev/en/identity/scopes-reference/) instead of guessing its name.

## Users and groups

Every user belongs to exactly one permission group. Built-in groups (`system-admin`, `admin`, `operator`, `viewer`, `guest`) cannot be modified. Custom groups hold any scope combination and nest one level: a top-level group can be a parent, a nested group cannot have children, and inherited scopes add to the member's effective scopes.

- `list_users`, `manage_user` for general administration.
- `update_user_role(userId, groupId)` changes effective permissions immediately.
- `set_user_additional_permissions(userId, additionalScopes)` **replaces** the user's extra scopes; `[]` resets them without touching the group. Read the current `additionalScopes` first when adding one, and grant only scopes the acting administrator holds.
- `set_user_blocked` blocks or unblocks.
- `delete_user` is a soft delete: access and tokens are revoked immediately and the user disappears from operational lists, but audit and usage history remain. Only a system administrator can restore a user, and a restored user stays blocked until unblocked. Do not tell anyone the account is "gone".
- `list_groups`, `create_group`, `update_group`, `delete_group` need `admin:groups`.

Authentication itself (OIDC, passwords, email one-time codes, passkeys, MFA, a user's sessions) is browser-bound; see `read_gateway_documentation({ topic: "authentication" })`.

## How scopes apply

A scope is `domain:resource:action[:qualifier]`:

- **Broad** (`proxy:view`): every resource of that type.
- **Resource-scoped** (`proxy:view:<hostId>`): exactly that resource.
- **Folder or Node restricted** (`<scope>:folder/<folderId>`, `<scope>:node/<nodeId>`): the folder or Node, its subfolders, and everything placed there now or later.

Each scope family has one view scope that its action scopes imply (`proxy:edit` satisfies `proxy:view`). Creation scopes are the exception: `*:create*` names a destination and implies no view, so `proxy:create:folder/F` does not list what is in `F`. Folder-tree scopes (`*:folders:manage`) grant folder visibility and changes, not item visibility; moving an item still needs the item's own edit or manage scope. Scopes that look symmetric often are not; check the reference.

## Restrict access

- A group's restriction is set when its scopes are assigned.
- An API token gets a folder, Node, or resource picker per restrictable scope, limited to what its creator can reach.
- An OAuth or MCP grant shows **All resources / Restrict...** for a broadly held scope and **No resources selected** for a partially held one; **Limit selected scopes to folder...** applies one folder to every selected scope of that folder's resource type.

A token or grant's own restriction is applied first and then bounded by the owner's **current** access. Narrowing a user's group immediately narrows every token and grant they issued, even mid-session.

## Tokens, grants, and what MCP cannot do

- `manage_api_token` and `manage_oauth_authorization` are browser-session tools for the current user's own tokens and grants, and are **not exposed over MCP**. An MCP agent cannot mint an API token or approve an OAuth client. When a user asks for a token, send them to the Console; do not look for a workaround.
- API tokens and OAuth grants can hold every scope a user can, except user-account-only scopes: `ai:workspace:use`, `feat:ai:configure`, `ai:skills:manage`, `ai:sandbox:*`, `mcp:use`, `inference:setup`, `admin:users:impersonate`, and `integrations:gitlab:sandbox:clone`.
- Retired scope names from before 2.11 are still accepted for two releases and rewritten to their replacements; see [retired scope names](https://docs.goodgateway.dev/en/identity/scopes-reference/#retired-scope-names) before trusting a name from older examples.

## Impersonation

`admin:users:impersonate` cannot be delegated to any token or grant: impersonation replaces the caller's browser session and is identity-bound. An MCP agent can never impersonate a user. Credential-revealing tools (database and storage credential reveal, license clearing, and others) refuse to run during impersonation, even for a human operator.

## Least privilege for an agent or integration

Grant `mcp:use` to the user account, then only the resource scopes the job needs, restricted to a folder, Node, or resource where possible. Leave manual-approval scopes (console, file access, raw nginx, credential reveal, restores, `admin:*`) unticked unless the task needs them. Prefer a dedicated group for automation users over broad additional permissions.

## Verify

After a group or permission change, have the affected identity attempt one action that should now be allowed and one that should be denied, and confirm both. After creating a restricted grant, confirm a resource outside the restriction is genuinely invisible, not merely unlisted in one view.

Scopes for this area: `admin:users`, `admin:users:folders:manage`, `admin:groups`, `admin:groups:folders:manage`, `admin:users:impersonate` (browser-only, non-delegable), and the account-level `mcp:use`. `admin:users` and `admin:groups` are OAuth manual-approval scopes. Further reading: [Users and groups](https://docs.goodgateway.dev/en/identity/auth-users-groups/), [Tokens and OAuth](https://docs.goodgateway.dev/en/identity/scopes-tokens-oauth/), [Permissions](https://docs.goodgateway.dev/en/concepts/permissions/).
