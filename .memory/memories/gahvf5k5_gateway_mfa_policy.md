---
{
  "id": "gahvf5k5",
  "file_name": "gahvf5k5_gateway_mfa_policy",
  "tags": [
    "dashboard",
    "gateway",
    "mfa",
    "pins",
    "realtime",
    "security",
    "sessions"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.92,
  "created_at": 1785708614178,
  "updated_at": 1786184817522
}
---
## Gateway Local MFA

- Local accounts with a registered TOTP factor or passkey receive an MFA challenge after password/email-OTP sign-in, regardless of group policy.
- `requireGateway2fa` remains a direct-group-only policy. It requires enrollment for local non-OIDC users without a factor; OIDC users remain excluded because their identity provider manages MFA, and bearer API/OAuth credentials are unchanged.
- Authentication settings persist `mfaExistingSessionGracePeriodDays` (default 3; editable in the existing Authentication UI from 0 to 7) for future direct false-to-true group MFA transitions.
- Enabling group MFA stamps current affected local browser sessions with `mfaGraceExpiresAt`. A legacy cookie session without `mfaSatisfiedAt` remains usable only until that fixed deadline; at or after it, required authentication destroys the session and returns MFA sign-in required.
- Disabling group MFA clears affected session markers. Middleware also ignores a stale marker whenever the group policy is off.
- Creating an MFA factor alone does not satisfy an existing legacy session; a fresh MFA-backed sign-in is required. The Dashboard shows the precise deadline and a reauthentication warning.
- Group MFA policy changes publish the user-targeted `mfa.required.<userId>` channel for every affected direct local member in both directions, including users who already have a factor, so active dashboards refresh the grace deadline. WebSocket access remains restricted to the authenticated matching user.
- `RealtimeBridge`, mounted for every authenticated session, invalidates the shared dashboard bootstrap; `AdminGroups` also invalidates the initiating administrator's bootstrap immediately.
- The MFA attention notice is yellow. A factorless user can open `MfaSetupWizard` in standalone mode; any legacy session in grace is instructed to sign out and perform a fresh MFA-backed sign-in without mutating finalize-setup/onboarding state.

## Dashboard Bootstrap and Realtime

- Dashboard data is loaded via `POST /api/monitoring/dashboard/bootstrap`; Sidebar and Dashboard share a Zustand snapshot key and deduplicate requests.
- Realtime events invalidate the shared snapshot rather than opening per-node EventSource streams. On reconnect after an established socket, EventStream revalidates the shared bootstrap to recover events missed while disconnected.
- Initial bootstrap failures retain request identity, retry with bounded backoff while no snapshot exists, and remain invalidatable afterward.
- Bootstrap responses include attention notices and independent Dashboard/Sidebar pins for nodes, proxies, databases, Docker containers, and deployments.
- Update availability, group MFA policy, and audit activity publish authorized dashboard-consumable events; RealtimeBridge invalidates their shared snapshot.
- Logging-health visibility and its realtime channel both require `housekeeping:view` (not `logs:read`), matching the bootstrap contract.
- The Sidebar Dashboard badge is an 8px square (`h-2 w-2`): blue only when all visible notices are informational; yellow when any warning exists, including red unhealthy state.

## Assistant Pins

- Embedded Gateway Assistant supports `find_resource` and `set_resource_pin` for Dashboard or Sidebar. Pins are browser-local and excluded from MCP.
- Tool results emit a one-time `client.action` WebSocket event that updates current browser pin stores and invalidates bootstrap.
- Pin actions are applied only for the active conversation; if an active run exists it must match the message run. Historic or delayed actions must not overwrite later manual choices.
- Docker pin actions require `nodeId`, `nodeSlug`, and `name` so local metadata remains resolvable.

## Session and WebSocket Compatibility

- Legacy Redis sessions may contain `session.userId` without nested `session.user`; resolve with `session.userId ?? session.user?.id`, never `session.user.id` directly.
- Authentication metadata must be handled defensively, including revocation of CSRF-protected sessions created by older versions.
