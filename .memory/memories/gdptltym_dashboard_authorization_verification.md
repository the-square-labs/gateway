---
{
  "id": "gdptltym",
  "file_name": "gdptltym_dashboard_authorization_verification",
  "tags": [
    "authorization",
    "dashboard",
    "docker",
    "pki",
    "realtime",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1785966895978,
  "updated_at": 1785966895978
}
---
Gateway dashboard bootstrap safety contract:
- Keep an existing bootstrap snapshot only during a refresh for the same user/scope/pin key. Auth context changes are handled by the registered resetClientSessionState callback, which clears dashboard bootstrap and pin stores before the new user state is published; preserve this path and its auth-store coverage.
- Initial bootstrap failures must terminate in a visible, retryable error state after bounded automatic retries, never a permanent spinner.
- For Docker child-scoped pins, browser-supplied scopeResourceId is display metadata only. Resolve the requested deployment/container server-side and authorize its resolved stable identity before returning name/state.
- PKI lifecycle changes that introduce a database transaction require affected test DB stubs to implement and assert transaction usage. Full backend tests are needed because targeted dashboard checks will not catch such fixture drift.
Verified in this remediation with frontend build + full frontend suite, backend typecheck + full backend suite, targeted Biome/diff checks, and two-domain broad review.
