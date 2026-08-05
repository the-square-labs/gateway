---
{
  "id": "yjerrsgn",
  "file_name": "yjerrsgn_gateway_lockout_policy",
  "tags": [
    "bootstrap",
    "gateway",
    "gotcha",
    "installer",
    "setup"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1777903845880,
  "updated_at": 1777903845880
}
---
Gateway first-run setup endpoints are controlled by settings keys `setup:started_at` and `setup:completed_at`, not by first real user creation. Backend startup records `setup:started_at` on fresh installs, marks upgraded already-configured installs complete, and `/api/setup/*` stays open until installer POSTs `/api/setup/complete` or the one-hour first-start window expires. This avoids racing installer SSL/bootstrap work against the first OIDC user login.
