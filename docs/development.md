# Development Guide

[Back to README](../README.md)

Gateway is an Nx and pnpm monorepo with TypeScript app packages and Go daemon packages.

## Requirements

- Node.js `>=24`
- pnpm `>=9`
- Go `>=1.24.4`
- Docker
- protoc

## Local Setup

Install dependencies:

```bash
pnpm install
```

Start local infrastructure:

```bash
pnpm dev:infra
```

This starts Postgres, Redis, and ClickHouse from [docker-compose.dev.yml](../docker-compose.dev.yml).

Run migrations:

```bash
pnpm db:migrate
```

Start development servers:

```bash
pnpm dev:all
```

This starts backend, frontend, and status-page dev servers through Nx.

## Environment

Use [.env.example](../.env.example) as the local development reference.

Important local defaults:

```env
DATABASE_URL=postgres://dev:dev@localhost:5432/gateway
REDIS_URL=redis://localhost:6379
SETUP_BOOTSTRAP=true
WEB_TLS_BOOTSTRAP_MODE=http
```

Configure the canonical URL, authentication, and structured logging through the first-run wizard. For `pnpm dev:infra`, the bundled development ClickHouse can be selected as an external connection at `http://localhost:8123`; leaving structured logging disabled hides its product surfaces.

## Common Commands

| Command | Description |
|---------|-------------|
| `pnpm dev:all` | Start backend, frontend, and status page in parallel. |
| `pnpm dev:infra` | Start local Postgres, Redis, and ClickHouse. |
| `pnpm dev:infra:down` | Stop local infrastructure. |
| `pnpm build` | Build backend, frontend, status page, and logging SDK. |
| `pnpm build:all` | Build app packages and daemon binaries. |
| `pnpm build:daemon` | Build all Go daemon binaries. |
| `pnpm test` | Run backend, frontend, logging SDK, and daemon tests. |
| `pnpm test:backend` | Run backend tests. |
| `pnpm test:logging-sdk` | Run logging SDK tests. |
| `pnpm test:daemon` | Run Go daemon tests. |
| `pnpm lint` | Run frontend/backend/logging SDK lint and Go vet. |
| `pnpm lint:daemon` | Run Go vet for daemons. |
| `pnpm typecheck` | Type-check TypeScript packages. |
| `pnpm proto` | Regenerate protobuf stubs. |
| `pnpm db:generate` | Generate a Drizzle ORM migration. |
| `pnpm db:migrate` | Run database migrations. |
| `pnpm db:studio` | Open Drizzle Studio. |
| `pnpm graph` | Open the Nx dependency graph. |

## Relay UI Previews

In a development build, open the Dashboard and run these commands in the browser console. Relay previews only change client-side state; retry actions do not call the backend.

For a production-style QA image, opt in at build time with `--build-arg VITE_GATEWAY_DEV_TOOLS=true`. Release images omit the commands by default.

```js
gatewayDev.showRelayActivation()
gatewayDev.showRelayMaintenance()
gatewayDev.showRelayRecovering()
gatewayDev.showRelayCritical()

gatewayDev.openRelayActivationDetails()
gatewayDev.openRelayMaintenanceDetails()
gatewayDev.openRelayRecoveringDetails()
gatewayDev.openRelayCriticalDetails()
gatewayDev.openRelayCriticalUserDetails()
gatewayDev.openRelayCriticalRetrying()

gatewayDev.hideRelayPreview()
```

Run `gatewayDev.relayUiCommands()` to return the full command list. Non-critical previews also set the Dashboard sidebar warning marker; the critical preview sets its red critical marker.

## Repository Layout

```text
gateway/
+-- packages/
|   +-- backend/          # Hono backend, REST API, OAuth, MCP, gRPC, jobs
|   +-- frontend/         # React + Vite Gateway UI
|   +-- status-page/      # Public status page frontend
|   +-- logging-sdk/      # TypeScript structured logging client
|   +-- daemons/
|       +-- nginx/        # nginx management daemon
|       +-- docker/       # Docker management daemon
|       +-- monitoring/   # host metrics daemon
|       +-- shared/       # shared Go packages and generated protobuf
+-- proto/                # protobuf service definitions
+-- scripts/              # Gateway and daemon installers
+-- docker-compose.yml    # production compose stack
+-- docker-compose.dev.yml
```

## Backend

The backend lives in `packages/backend`.

Main responsibilities:

- Hono HTTP API.
- OpenAPI documentation.
- OIDC authentication.
- Session handling.
- Permissions and scopes.
- OAuth and MCP.
- PostgreSQL persistence through Drizzle ORM.
- Redis-backed cache/session/rate-limit behavior.
- gRPC server for daemon control.
- Background jobs.
- WebSocket streams.

Useful paths:

| Path | Purpose |
|------|---------|
| `packages/backend/src/modules` | Feature modules and routes. |
| `packages/backend/src/db/schema` | Drizzle schema definitions. |
| `packages/backend/src/db/migrations` | SQL migrations. |
| `packages/backend/src/grpc` | gRPC server and generated TypeScript types. |
| `packages/backend/src/lib/scopes.ts` | Permission scope definitions and helpers. |

## Frontend

The frontend lives in `packages/frontend`.

Main stack:

- React 19.
- Vite.
- Tailwind CSS 4.
- shadcn-style UI components.
- Zustand stores.
- Vitest tests.

Useful paths:

| Path | Purpose |
|------|---------|
| `packages/frontend/src/pages` | Route-level pages. |
| `packages/frontend/src/components` | Shared and feature components. |
| `packages/frontend/src/stores` | Zustand stores. |
| `packages/frontend/src/services` | API and event-stream clients. |
| `packages/frontend/src/lib/scope-utils.ts` | Frontend scope editor helpers. |

## Daemons

Go daemons live under `packages/daemons`.

| Path | Purpose |
|------|---------|
| `packages/daemons/nginx` | nginx management daemon. |
| `packages/daemons/docker` | Docker management daemon. |
| `packages/daemons/monitoring` | metrics daemon. |
| `packages/daemons/shared` | shared Go packages. |
| `packages/daemons/go.work` | Go workspace. |

Run daemon tests:

```bash
cd packages/daemons
go test ./docker/... ./monitoring/... ./nginx/... ./shared/...
```

## Protobuf

Protobuf definitions live in `proto/`.

Regenerate stubs:

```bash
pnpm proto
```

Generated Go stubs are committed under `packages/daemons/shared/gatewayv1`.

## Database Migrations

Generate a migration after schema changes:

```bash
pnpm db:generate
```

Apply migrations locally:

```bash
pnpm db:migrate
```

Open Drizzle Studio:

```bash
pnpm db:studio
```

## Verification

Common verification before submitting changes:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

For daemon-only changes:

```bash
pnpm proto
pnpm test:daemon
pnpm lint:daemon
```

Run `pnpm proto` whenever `proto/gateway/v1/nginx-daemon.proto` changes. The daemon update command schema is part of the signed update trust boundary, so keep generated Go stubs and backend TypeScript command types aligned.

For full release confidence:

```bash
pnpm build:all
```
