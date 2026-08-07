# Installation Guide

[Back to README](../README.md)

Gateway installs as a small Docker Compose stack containing the application, a long-lived daemon relay, PostgreSQL, and Redis. Product configuration belongs to Gateway itself and is completed in the browser.

## Requirements

- Linux with Docker Engine and Docker Compose v2.
- OpenSSL and curl.
- Access to the Gateway image registry and GitLab release API.
- Inbound `3000/tcp` for the UI/API and `9443/tcp` for managed daemon gRPC connections.
- A trusted reverse proxy is optional. Gateway can serve port 3000 directly over HTTP or over a certificate issued by its existing System CA.

Gateway mounts the host Docker socket for self-updates and optional managed local ClickHouse. Run it in an isolated VM or on a dedicated trusted host.

## Install

```bash
curl -sSL https://gitlab.wiolett.net/wiolett/gateway/-/raw/main/scripts/install.sh | bash
```

The installer downloads the latest release and asks one question on a fresh interactive install: whether port 3000 should start with native HTTPS. HTTPS is the default, including non-interactive installs. Choose HTTP only when you deliberately want plaintext on the internal hop or will terminate TLS elsewhere.

Explicit non-interactive examples:

```bash
# Native HTTPS (also the default)
curl -sSL https://gitlab.wiolett.net/wiolett/gateway/-/raw/main/scripts/install.sh | bash -s -- --https

# Plain HTTP on port 3000
curl -sSL https://gitlab.wiolett.net/wiolett/gateway/-/raw/main/scripts/install.sh | bash -s -- --http
```

Supported options are `--install-dir`, `--image`, `--source-dir`, `--http`, `--https`, and `--dry-run`. `--source-dir` builds a fresh test installation from a local Gateway checkout instead of discovering and pulling a release; it cannot update an existing installation. `--dry-run` verifies the selected signed release and renders the planned flow without creating files, building or pulling images, or starting services. Run with `--help` for syntax. The installer has no domain, nginx, Cloudflare, OIDC, SMTP, or ClickHouse prompts.

## Browser Setup Wizard

After the stack is healthy, the installer prints:

- the URL to open;
- the System CA SHA-256 fingerprint;
- a one-time setup code valid for 24 hours;
- the command that resets setup and issues a new code.

The setup code is shown only in installer output. Gateway stores its identifier, expiry, and SHA-256 hash, never the plaintext code. Until setup completes, normal product and authentication APIs return `423 SETUP_REQUIRED`; health, static wizard assets, and the setup API remain available.

Open Gateway and enter the code. The wizard then configures:

1. An explicit canonical public URL. Gateway never uses the browser origin as its default.
2. One or more sign-in methods: OIDC, password, and email one-time code.
3. OIDC when selected, and verified SMTP when an email-based method is selected.
4. Exactly one first administrator and exactly one primary sign-in method for that account.
5. Structured logging as disabled, Gateway-managed local ClickHouse, or external ClickHouse.

Finish the wizard before using Gateway. The setup session and one-time code are invalidated at completion.

## Native HTTPS And Reverse Proxies

Native HTTPS and HTTP use the same port, `3000`. Native HTTPS uses a dedicated `gateway-web` leaf certificate issued by the existing Gateway System CA; it does not create a second root CA.

A reverse proxy can connect to either internal protocol. Configure the proxy to trust the Gateway System CA when it verifies the native HTTPS upstream. Public certificates, DNS, Cloudflare, and ACME remain outside the installer and wizard.

Administrators can enable or disable internal HTTPS later in **Settings → Gateway**. Gateway restarts after the change. When the browser directly addresses an IP, the UI changes `http`/`https` to follow the listener. With a domain or reverse proxy, the browser keeps its external URL and only reloads.

## Structured Logging

The wizard offers three modes:

- **Disabled**: logging ingest and UI are unavailable.
- **Managed local**: Gateway uses the mounted Docker socket to create a pinned ClickHouse container on its current Docker network.
- **External**: Gateway stores the supplied ClickHouse connection configuration.

Disabling managed local logging stops the ClickHouse container and preserves its named volume. Re-enabling adopts the same managed container and credentials. OIDC, SMTP, and ClickHouse secrets are encrypted with `PKI_MASTER_KEY` in Gateway settings.

## Updating And Legacy Migration

Running the installer again updates an existing installer-managed deployment to the latest release without repeating product configuration.

The relay is the sole public owner of the existing `9443/tcp`; the application keeps only an internal gRPC listener for relay-to-app control-plane proxying. App and relay use independent image references even though both entrypoints come from the same signed Gateway image. A normal app-only update therefore does not recreate the relay. The relay image reference advances only when the signed release manifest changes `relayVersion`.

The first update from a pre-relay installer-managed foundation runs the target image's foundation migrator before the new app starts. It backs up `.env` and `docker-compose.yml`, adds the relay service and identity volume, moves the existing public `9443/tcp` mapping from `app` to `relay`, and preserves the existing data volumes and daemon identity. This ownership cutover causes one expected interruption to daemon connections. If migration fails, the updater restores the foundation backup instead of starting a partial topology.

On the first compatible update, legacy `OIDC_*`, `CLICKHOUSE_*`, and `APP_URL` values are imported into Gateway settings. OIDC and ClickHouse secrets are encrypted before the managed installer or in-app updater atomically removes those exact legacy keys from `.env` and recreates the application container. An incomplete legacy OIDC configuration aborts cleanup instead of deleting recoverable values.

The migration removes the old Compose ClickHouse service definition but does not delete its container or volume. When migrated settings select local mode, Gateway adopts the legacy container. Manual Compose deployments may retain legacy env keys until the operator runs an installer-managed or in-app update.

## Backups

Back up together:

- PostgreSQL;
- Redis if active browser/setup sessions matter;
- the `gateway_data` volume containing auto-issued TLS material;
- the `gateway_relay_identity` volume containing relay service identity material;
- the managed ClickHouse volume when local structured logging is enabled;
- `.env`, especially `PKI_MASTER_KEY` and database credentials.

Losing `PKI_MASTER_KEY` makes encrypted OIDC, SMTP, ClickHouse, PKI, and other stored secrets unrecoverable.

## After Installation

Create managed nodes from the authenticated Gateway UI after the first-run wizard is complete. Node enrollment and proxy/domain configuration are intentionally separate from installing the Gateway control plane.
