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
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.88,
  "created_at": 1777057210510,
  "updated_at": 1787862542902
}
---
Gateway licensing uses a separate Go service with binary `gls`, SQLite storage, CLI license management, and an HTTP API. Gateway talks to the fixed vendor licensing endpoint configured by the product rather than an installation-defined URL. License state is stored in the existing `settings` table with encrypted key storage through `CryptoService`. Scopes are `license:view` and `license:manage`; absence of a key means Community. The supported paid tier labels are Homelab and Enterprise. Heartbeat verifies only, activation may replace the active installation, and an unreachable licensing service uses a 30-day grace window from the last valid check.
