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
  "created_at": 1787493437067,
  "updated_at": 1787493437067
}
---
Gateway's Codex usage integration is installed only through `setup codex`: optional `--desktop-usage` and `--cli-usage`, plus interactive Desktop/CLI/both choices. It never shadows system `codex`; CLI installs a distinct `gateway-codex`, while Desktop uses an owned CODEX_CLI_PATH activation. `uninstall codex-usage [desktop|cli|all]` is the offline, ownership-aware emergency removal path and preserves the base Codex integration, runtime token, catalog, MCP, and proxy. Keep Desktop and CLI real-Codex bindings independent because the macOS app-bundled Codex can differ from standalone CLI. For protocol integrity, forward `turn/completed` before optional deferred usage refresh; explicit usage reads fail closed before first successful Gateway snapshot, while later refresh failures retain last-good data. Linux XDG discovery must preserve safe Exec argv, exclude owned marker entries during repair, validate executability, and reject Flatpak/Snap including absolute or env-wrapped commands. macOS uninstall must check launchctl getenv/unsetenv and preserve artifacts/state on failure. Validate persisted wrapper state strictly; invalid state falls back to fixed current-platform owned paths for uninstall.
