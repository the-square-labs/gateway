# Gateway Inference

`@wiolett/gateway-inference` is the interactive inference companion for Good Gateway. It configures supported AI harnesses while keeping dedicated `gwi_` runtime tokens out of their configuration files.

Node.js 22 or newer is required. Run the package through npm exec; a global installation and `PATH` changes are not required. Before setup, an administrator must enable **Inference** under **Settings > General > General settings**. All harness traffic uses the Gateway's single stable `/api/inference/v1` prefix.

Version 0.3 accepts both the previous discovery schema v1 and the current v2 document. It normalizes both to the standard OpenAI and Anthropic adapters and never selects a legacy harness-specific endpoint.

## Interactive manager

```sh
npx -y @wiolett/gateway-inference@latest
```

The manager shows the active Gateway connection plus Codex and Claude Code state. It can log in, set up, diagnose, repair, or remove either package-managed harness integration, refresh the Codex catalog, and log out.

## Login and logout

```sh
npx -y @wiolett/gateway-inference@latest login
npx -y @wiolett/gateway-inference@latest login https://gateway.example.com
npx -y @wiolett/gateway-inference@latest login https://gateway.example.com --token gwi_...
npx -y @wiolett/gateway-inference@latest logout
```

`login` asks for the Gateway URL when it is omitted in an interactive terminal, then offers **Browser OAuth** or **Existing inference token**. Browser OAuth discovers the Gateway instance, prints the complete authorization URL to the console before attempting to open it, and completes Authorization Code with PKCE through a random loopback callback. The printed URL remains available for manual opening when the browser does not start automatically. OAuth requests only the isolated `inference:setup` resource.

The interactive token prompt masks an existing `gwi_` inference token and validates it with Gateway before saving it. The token itself identifies its Gateway user; no email or separate account identifier is required. For non-interactive use, pass `--token`; treat that command as sensitive because command-line arguments may be retained by shell history or process inspection.

OAuth and inference runtime credentials are stored in the operating-system credential store. If none is available, an interactive warning can opt into a mode-`0600` file. The dedicated `gwi_` runtime token stays in that Gateway-owned credential store and is never written to Codex configuration or `$CODEX_HOME/auth.json`. `logout` removes setup authorization but leaves an already configured harness and its dedicated runtime token unchanged.

## Portable companion home

Pass `--home` before or after the command to keep all companion-owned filesystem state in one directory:

```sh
npx -y @wiolett/gateway-inference@latest --home /data/inference login https://gateway.example.com --token gwi_...
npx -y @wiolett/gateway-inference@latest --home /data/inference setup codex
```

Profiles, the private runtime helper, catalogs, proxy state, and mode-`0600` setup/runtime credentials are stored below `/data/inference`. Generated Codex and Claude Code configuration remains in each harness's native configuration directory so the harness can discover it. `GATEWAY_INFERENCE_HOME=/data/inference` is equivalent to the CLI option. The installed helper, MCP command, credential helper, and detached proxy retain the selected home automatically.

## Configure Codex

```sh
npx -y @wiolett/gateway-inference@latest setup
npx -y @wiolett/gateway-inference@latest setup codex
```

`setup` asks which supported harness to configure when the harness is omitted in an interactive terminal. Outside a terminal, the harness is required. The current release supports Codex and Claude Code.

Codex setup performs Gateway login when needed, issues a dedicated `gwi_` runtime token, installs a stable helper in the private Gateway user-data directory, and downloads the authoritative Gateway model catalog. It keeps Codex on the built-in `openai` provider, selects the first available Gateway model, and points `openai_base_url` at a private `127.0.0.1` endpoint. Setup starts and verifies a detached local proxy before it reports success; the MCP process can reuse that listener. The proxy discards Codex's incoming authorization, reads the `gwi_` token from the Gateway credential store, and forwards both HTTP and WebSocket inference traffic to Gateway. This keeps the full catalog available to Codex CLI and Desktop without modifying Codex authentication. Existing Codex settings and comments are restored when the integration is removed.

Codex must also be signed in to an OpenAI account through its normal login flow. Setup checks `codex login status` and prints a warning when that account login is missing, because Codex Desktop does not expose custom model catalogs until its own account session exists. After setup or login, fully quit and reopen Codex so its startup-only catalog snapshot is replaced.

Gateway model entries reuse the full model instructions bundled with the installed Codex CLI. The companion does not replace Codex's base prompt with a Gateway-authored prompt; exact Codex model slugs use their matching bundled instructions, while other routed models use the bundled default instructions from that Codex version.

The installed helper owns the loopback proxy, refreshes the catalog at startup, follows Gateway invalidation events, and falls back to conditional polling. Runtime auth, proxy, and MCP lifecycle modes are private implementation details and are not public CLI commands.

Codex usage and quota displays are not overridden. View Gateway limits in the Gateway UI; Codex Desktop and CLI continue to show their native account usage. Version 0.3.6 and later remove the experimental usage wrappers from 0.3.4 and 0.3.5. Running `setup codex` cleans up package-owned legacy wrapper artifacts automatically. The offline cleanup command remains available for affected installations:

```sh
npx -y @wiolett/gateway-inference@latest uninstall codex-usage
```

## Configure Claude Code

Claude Code 2.1.129 or newer is required.

```sh
npx -y @wiolett/gateway-inference@latest setup claude-code
```

Setup issues a separate `gwi_` runtime token, validates Gateway model discovery and native Anthropic streaming, then merges package-owned values into `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`). It configures the native `ANTHROPIC_BASE_URL`, enables gateway model discovery, and installs an `apiKeyHelper` that reads the token from the operating-system credential store. The token itself is never written to Claude settings.

Gateway models are exposed through stable `claude-gateway-*` aliases so Claude Code accepts them in its model picker. Setup maps the default Opus, Sonnet, and Haiku selections to the first available Gateway model; users can select any discovered Gateway alias afterwards. Existing unrelated Claude settings are preserved. Removal restores the exact values that existed before setup and stops if a package-owned value was edited.

This integration configures the Claude Code CLI only. Claude Desktop and the Claude Code VS Code extension use separate configuration surfaces and are not modified automatically.

Run `npx -y @wiolett/gateway-inference@latest --help` for the complete public command surface.

## License

Square Labs-owned source in this package is available for noncommercial use under the [PolyForm Strict License 1.0.0](LICENSE.md). A Square Labs-issued Personal, Business, or Enterprise Gateway key provides the named licensee a limited commercial-use grant under [Good Gateway Commercial Key License 1.0](COMMERCIAL-LICENSE.md). Neither license permits modification or redistribution.
