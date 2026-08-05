---
{
  "id": "acdy69d9",
  "file_name": "acdy69d9_gateway_license_server",
  "tags": [
    "gateway",
    "license",
    "license-server",
    "repo",
    "workflow"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1777057210510,
  "updated_at": 1777057210510
}
---
Gateway licensing now uses a sibling repository at /Users/knownout/Projects/wiolett/gateway-license-server. The repo is a Go service with binary name `gls`, SQLite storage, CLI license management, and HTTP API. Gateway hardcodes the license server URL as https://gw-license-server.wiolett.net. Gateway stores license state in the existing `settings` table with encrypted key storage via CryptoService, uses scopes `license:view` and `license:manage`, and treats no key as Community. License tiers are Homelab and Enterprise labels only for now. Heartbeat verifies only; activation may replace the active installation. Unreachable license server uses a 30-day grace window from last valid check.
