# `@wiolett/gateway`

The command-line companion for Wiolett Gateway. Node.js 22 or newer is required. Run it through npm exec; a global installation and PATH changes are not required.

## Interactive menu

```sh
npx @wiolett/gateway
```

The root menu selects a Gateway module; v1 exposes **Inference**. To open its action menu directly:

```sh
npx @wiolett/gateway inference
```

The Inference menu shows the authenticated account and Gateway role, lists locally available models, and provides authentication, model refresh, harness setup, and logout actions. Explicit subcommands remain available for scripts and `--json` automation.

## Log in

```sh
npx @wiolett/gateway login https://gateway.example.com
npx @wiolett/gateway status
```

Login discovers the Gateway instance, opens its OAuth consent screen, and completes Authorization Code with PKCE through a random loopback callback. It requests only the isolated `inference:setup` resource. Use `--profile NAME` to isolate multiple Gateway instances.

OAuth and inference runtime credentials are stored in the operating-system credential store. If none is available, an interactive warning can opt into a mode-`0600` file; non-interactive use must pass `--allow-file-credentials` explicitly.

## Configure Codex

```sh
npx @wiolett/gateway inference setup
```

The interactive setup checks the selected profile, opens Gateway OAuth when authorization is missing, lists the harnesses advertised by that Gateway instance, and configures the selected integration with guided progress. If no profile exists yet, it also asks for the Gateway URL.

For scripts and other non-interactive environments, specify the harness explicitly:

```sh
npx @wiolett/gateway inference setup codex
npx @wiolett/gateway inference sync codex
npx @wiolett/gateway inference doctor codex
npx @wiolett/gateway inference remove codex
```

`setup` requires a compatible Codex CLI. It issues a dedicated `gwi_` runtime token, installs a stable helper in the private Gateway user-data directory, writes bounded package-managed sections to `CODEX_HOME/config.toml`, and downloads the authoritative Gateway model catalog. Existing Codex settings and comments are preserved. Catalog changes apply to the next Codex process.

`sync` never replaces a missing or revoked runtime token. Run `setup` explicitly to issue a replacement. `remove` deletes only package-managed local configuration and credentials; pass `--revoke-token` to revoke its Gateway runtime token as well.

The configured stdio MCP refreshes the catalog at startup, follows Gateway invalidation events, and falls back to conditional polling:

```sh
npx @wiolett/gateway inference mcp --profile default
```

## Manage runtime tokens

```sh
npx @wiolett/gateway inference tokens list
npx @wiolett/gateway inference tokens create --harness codex --name laptop
npx @wiolett/gateway inference tokens revoke TOKEN_ID
```

New secrets are shown once. `--json` provides machine-readable output, but it does not hide a newly created copy-once token from the command that explicitly requested it. Do not write that output to shared logs.

Run `npx @wiolett/gateway --help` for all options.
