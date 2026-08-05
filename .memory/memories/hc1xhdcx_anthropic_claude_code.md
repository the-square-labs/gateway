---
{
  "id": "hc1xhdcx",
  "file_name": "hc1xhdcx_anthropic_claude_code",
  "tags": [
    "anthropic",
    "claude-code",
    "credentials",
    "gateway-cli",
    "inference"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1785451683980,
  "updated_at": 1785451683980
}
---
Gateway inference supports Claude Code CLI as a separate `claude-code` harness when persisted harness-specific endpoints are enabled. The companion command is `npx @wiolett/gateway-inference setup claude-code`; package version for this feature is 0.2.0 and Claude Code >= 2.1.129 is required. It reuses setup OAuth and a dedicated `gwi_` token but stores that runtime credential in a distinct `runtime:<profile>:claude-code` slot, preserving the published Codex slot `runtime:<profile>` and allowing both harnesses on one device.

Claude Code uses its native gateway contract directly, without a loopback proxy or daemon: `ANTHROPIC_BASE_URL` points at `/api/inference/anthropic`, model discovery calls `/v1/models`, and inference calls `/v1/messages`. The backend exposes reversible `claude-gateway-<base64url logical id>` aliases because Claude Code accepts only IDs starting with `claude` or `anthropic`; Messages and Count Tokens resolve aliases back to logical models, while response projection preserves the requested alias. Incoming `X-Claude-Code-Session-Id` supplies affinity, and supported `anthropic-version`/`anthropic-beta`, context management, and native tool fields are preserved on Anthropic-native upstreams.

The CLI keeps the `gwi_` token out of Claude settings. It installs the private bundled runtime and writes an `apiKeyHelper` command that prints only the Claude Code credential. It atomically merges owned values into `~/.claude/settings.json` or `$CLAUDE_CONFIG_DIR/settings.json`: `apiKeyHelper`, `ANTHROPIC_BASE_URL`, gateway model discovery, login/logout suppression, and default Opus/Sonnet/Haiku aliases. State is stored under the Gateway data directory. Setup refuses foreign ownership conflicts; removal restores exact previous values, preserves unrelated/later-added settings, and stops if an owned value was edited.

Setup verifies the installed Claude version, authenticated `/v1/models`, and a minimal SSE Messages completion before reporting success. The interactive manager independently reports, diagnoses, repairs, and removes Codex and Claude Code. Claude Desktop, the VS Code extension, MCP registration, Tool Search enablement, publication, and deployment are intentionally outside this integration.
