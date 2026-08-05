---
{
  "id": "127mkya9",
  "file_name": "127mkya9_cli_codex_endpoints",
  "tags": [
    "cli",
    "codex",
    "endpoints",
    "gateway",
    "inference",
    "settings"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.5,
  "importance": 0.5,
  "created_at": 1785449792533,
  "updated_at": 1785449864803
}
---
Gateway inference endpoint exposure contract (supersedes the older endpoint paragraph in memory dcfkgqwx):
- The inference feature itself remains persisted and disabled by default; enabling the general feature does not show an alpha confirmation modal.
- The canonical always-available data-plane adapter while inference is enabled is the OpenAI-compatible `/api/inference/v1`; the unreleased `/api/inference/openai/v1` path is removed without a redirect.
- Persisted `general:settings.inference.harnessSpecificEndpointsEnabled` defaults false. When false, `/api/inference/codex/*`, `/api/inference/anthropic/*`, and `/api/inference/setup/*` return `INFERENCE_HARNESS_ENDPOINTS_DISABLED`; when true, those adapters/setup endpoints are exposed.
- Enabling harness-specific endpoints requires a confirmation that harness APIs are unstable, change frequently, the feature is barely tested, and it may stop working at any time. Cancel leaves the toggle disabled; turning the endpoints back off is immediate.
- Settings > Inference contains an `Inference settings` panel using PanelShell/SettingsControlRow. Provider viewers can read the toggle and provider managers can change it. The inline setup link opens a body-copy modal with `@wiolett/gateway-inference` install/login/setup commands and the Codex Desktop caveat: the user must first sign in through the normal OpenAI login flow and fully restart Codex after setup or login changes.
- Discovery publishes the harness toggle, uses `/api/inference/v1` as the OpenAI base URL, and reports Codex support from the toggle. New CLI code stops before authentication with `HARNESS_ENDPOINTS_DISABLED` when explicitly false while retaining compatibility with older Gateway discovery payloads that omit the field.
