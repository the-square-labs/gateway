---
{
  "id": "mzmjdewo",
  "file_name": "mzmjdewo_codex_gateway_wrapper",
  "tags": [
    "cli",
    "codex",
    "desktop",
    "gateway-inference",
    "usage",
    "wrapper"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.95,
  "created_at": 1787493437067,
  "updated_at": 1787497558522
}
---
# Gateway Codex Usage Integration

- Installed only through `setup codex`, with optional `--desktop-usage` and `--cli-usage`, or interactive Desktop/CLI/both selection.
- Never shadows system `codex`.
  - CLI installs a distinct `gateway-codex`.
  - Desktop uses an owned `CODEX_CLI_PATH` activation.
- `uninstall codex-usage [desktop|cli|all]` is the offline, ownership-aware emergency removal path.
  - Preserves base Codex integration, runtime token, catalog, MCP, and proxy.
- Desktop and CLI bindings remain independent because macOS app-bundled Codex may differ from standalone CLI.
- Protocol behavior:
  - Forward `turn/completed` before any deferred usage refresh.\n- Codex Desktop compatibility: when 5h is disabled and 7d is configured, place 7d in the legacy `rateLimits.primary` slot while retaining the full `rateLimitsByLimitId` map; the current Desktop compact usage path recognizes a lone weekly window only in primary.
  - Explicit usage reads fail closed until the first successful Gateway snapshot.
  - Later refresh failures retain the last-good data.

## Platform and State Safety

- Linux XDG discovery:
  - Preserve safe `Exec` argument vectors.
  - Exclude owned marker entries during repair.
  - Validate executability.
  - Reject Flatpak/Snap commands, including absolute and environment-wrapped forms.
- macOS uninstall:
  - Check `launchctl getenv` and `launchctl unsetenv`.
  - Preserve artifacts and state if either operation fails.
- Persisted wrapper state must be validated strictly.
  - Invalid state falls back to fixed, current-platform owned paths for uninstall.

## Related Gateway Inference Contracts

- Gateway inference is isolated from internal Assistant/MCP credentials and runtime.
  - Uses OpenAI-compatible `/api/inference/v1`.
  - Dedicated `gwi_` tokens.
  - Inference feature is disabled by default and controlled by persisted `general:settings.features.inferenceEnabled`.
- Harness-specific Codex/Anthropic/setup endpoints are controlled by persisted `general:settings.inference.harnessSpecificEndpointsEnabled`, defaulting to false.
- OpenAI/Codex subscription authentication uses the official device-code flow, not the Codex CLI localhost callback.
- Codex proxying uses OpenCodex core with per-turn WebSocket proxying; the proxy must close upstream sockets on terminal events.
- Codex catalog validation:
  - `web_search_tool_type` must be `text` or `text_and_image`; null is invalid and omission defaults to `text`.
  - Gateway models without hosted search advertise `supports_search_tool=false` and `use_responses_lite=true`.
  - Invalid catalog payloads must not replace the last-good catalog.
  - Validate with generated catalogs and real `codex exec -m <model>`, not only `codex debug models`.
- Companion Codex configuration is scoped to the current process `CODEX_HOME`; managed state is separate per resolved `config.toml`.
- Shared runtime token/catalog are removed only after the last managed Codex home is removed.
- Do not use or delete user-owned provider configuration or quota during staging validation.
