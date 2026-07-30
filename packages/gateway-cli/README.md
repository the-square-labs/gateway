# `@wiolett/gateway-inference`

The interactive inference companion for Wiolett Gateway. Node.js 22 or newer is required. Run it through npm exec; a global installation and `PATH` changes are not required.

## Interactive manager

```sh
npx @wiolett/gateway-inference
```

The manager shows the active Gateway connection and Codex state. It can log in, set up or repair Codex, refresh the model catalog, diagnose the integration, remove package-managed Codex configuration, and log out.

## Login and logout

```sh
npx @wiolett/gateway-inference login
npx @wiolett/gateway-inference login https://gateway.example.com
npx @wiolett/gateway-inference logout
```

`login` asks for the Gateway URL when it is omitted in an interactive terminal. It discovers the Gateway instance, opens its OAuth consent screen, and completes Authorization Code with PKCE through a random loopback callback. It requests only the isolated `inference:setup` resource.

OAuth and inference runtime credentials are stored in the operating-system credential store. If none is available, an interactive warning can opt into a mode-`0600` file. The dedicated `gwi_` runtime token stays in that Gateway-owned credential store and is never written to Codex configuration or `$CODEX_HOME/auth.json`. `logout` removes setup authorization but leaves an already configured harness and its dedicated runtime token unchanged.

## Configure Codex

```sh
npx @wiolett/gateway-inference setup
npx @wiolett/gateway-inference setup codex
```

`setup` asks which Gateway-advertised harness to configure when the harness is omitted in an interactive terminal. Outside a terminal, the harness is required. The current release supports Codex.

Codex setup performs Gateway login when needed, issues a dedicated `gwi_` runtime token, installs a stable helper in the private Gateway user-data directory, and downloads the authoritative Gateway model catalog. It keeps Codex on the built-in `openai` provider, selects the first available Gateway model, and points `openai_base_url` at a private `127.0.0.1` endpoint. Setup starts and verifies a detached local proxy before it reports success; the MCP process can reuse that listener. The proxy discards Codex's incoming authorization, reads the `gwi_` token from the Gateway credential store, and forwards both HTTP and WebSocket inference traffic to Gateway. This keeps the full catalog available to Codex CLI and Desktop without modifying Codex authentication. Existing Codex settings and comments are restored when the integration is removed.

Codex must also be signed in to an OpenAI account through its normal login flow. Setup checks `codex login status` and prints a warning when that account login is missing, because Codex Desktop does not expose custom model catalogs until its own account session exists. After setup or login, fully quit and reopen Codex so its startup-only catalog snapshot is replaced.

The installed helper owns the loopback proxy, refreshes the catalog at startup, follows Gateway invalidation events, and falls back to conditional polling. Runtime auth, proxy, and MCP lifecycle modes are private implementation details and are not public CLI commands.

Run `npx @wiolett/gateway-inference --help` for the complete public command surface.
