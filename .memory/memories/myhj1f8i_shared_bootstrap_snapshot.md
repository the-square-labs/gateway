---
{
  "id": "myhj1f8i",
  "file_name": "myhj1f8i_shared_bootstrap_snapshot",
  "tags": [
    "audit",
    "bootstrap",
    "dashboard",
    "rate-limit",
    "realtime"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1785949175721,
  "updated_at": 1785970761696
}
---
# Gateway Dashboard, Realtime, MFA, Pins, and Routing

## Dashboard Bootstrap and Realtime

- Dashboard data loads through `POST /api/monitoring/dashboard/bootstrap`.
- Dashboard and Sidebar share a Zustand snapshot key and deduplicate requests.
- Bootstrap responses include attention notices and independent Dashboard/Sidebar pins for nodes, proxies, databases, Docker containers, and deployments.
- Realtime events invalidate the shared snapshot; clients do not open per-node `EventSource` streams.
- After reconnecting an established WebSocket, EventStream revalidates the bootstrap to recover missed events.
- Update availability, group MFA policy, audit activity, and assistant pin actions can invalidate the shared snapshot.
- Bootstrap is a read-only POST and **must be excluded from fallback audit logging**. Auditing it publishes `audit.changed`, which invalidates bootstrap and creates an unbounded request loop that quickly reaches rate limits.
- Initial failures retain request identity, retry with bounded backoff while no snapshot exists, and must end in a visible, retryable error rather than a permanent spinner.
- Preserve an existing snapshot only while refreshing for the same user, scope, and pin key.
- Auth-context changes call `resetClientSessionState`, clearing bootstrap and pin stores before publishing the new user state.
- Logging-health visibility and its realtime channel require `housekeeping:view`, not `logs:read`.

## Sidebar and Lite Mode

- The Dashboard badge is blue when every visible notice is informational and yellow when any warning exists, including a red unhealthy state.
- Badge-size specifications differ: the primary snapshot says 12px; the detailed MFA specification says 8px (`h-2 w-2`).
- Lite mode keeps a separate Dashboard link at the top of the sidebar, displays Sidebar-placement resources, and then shows conversations.
- Default and Lite sidebars must share `SidebarPinnedResources` for consistent routes, scope filtering, and status colors.

## Assistant Resource Pins

- Embedded Gateway Assistant supports `find_resource` and `set_resource_pin` for Dashboard or Sidebar.
- Pins are browser-local preferences and excluded from MCP.
- Tool results emit a one-time `client.action` WebSocket event that updates the current browser’s persisted pin stores and invalidates dashboard bootstrap.
- Apply pin actions only for the active conversation. If a run is active, its run must match the message run; never replay historic or delayed actions.
- Docker pin actions require `nodeId`, `nodeSlug`, and `name`.

## MFA and Authorization

- Local accounts with a registered TOTP factor or passkey receive MFA after password/email-OTP sign-in regardless of group policy.
- `requireGateway2fa` requires enrollment for local non-OIDC users without a factor; OIDC users remain excluded because their identity provider manages MFA.
- Group MFA policy changes publish `mfa.required.<userId>` for affected local users without a factor in both directions. Existing sessions remain valid; enforcement starts at the next login.
- MFA WebSocket access is restricted to the authenticated matching user.
- `RealtimeBridge`, mounted for every authenticated session, invalidates the shared dashboard bootstrap. `AdminGroups` also immediately invalidates the initiating administrator’s bootstrap.
- MFA attention notices are yellow; their CTA opens `MfaSetupWizard` standalone without changing onboarding or finalize-setup state.
- Resolve legacy Redis sessions with `session.userId ?? session.user?.id`; never access `session.user.id` directly.
- Handle authentication metadata defensively, including revocation of CSRF-protected sessions created by older versions.

## Docker Child Scopes and Routes

- Browser-provided Docker `scopeResourceId` is display metadata only.
- Resolve the deployment or container server-side and authorize its resolved stable identity before returning name or state.
- Persist backend-generated collision-safe slugs, limited to 60 characters before `-1`, `-2`, etc., for nodes, database connections, proxy hosts, and existing logging fields.
- Docker containers, deployments, and volumes use exact case-sensitive names scoped by node slug.
- Technical APIs, mutations, and popouts remain ID-based.
- Do not add slug systems for PKI, domains, certificates/CAs, or templates unless separately requested.
- The frontend never computes canonical slugs.
- Slug rename events use the notification bus. The current tab updates from mutation responses; other tabs update from realtime while retaining their active tab.
- Route resolver failures remain local with retry UI and must not trigger global outage or rate-limit blockers.
- Resolved page context must remain owner-safe for AI and the command palette.
- Compact Docker node responses must be filtered client-side by requested Docker scope bases; broad `nodes:details` access must not expand resource-scoped Docker authorization.

## Verification

- Run full backend and frontend test suites, frontend build, backend typecheck, lint/Biome and `git diff --check`.
- Test migrations against current and fresh PostgreSQL.
- Update affected PKI test database stubs to implement and assert transaction usage.
- Browser smoke coverage should include all eight route families, transient resolver retry, two-tab node slug rename, and a Docker-only scoped user.
