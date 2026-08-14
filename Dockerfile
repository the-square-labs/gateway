ARG NODE_IMAGE=docker.io/library/node:24-alpine@sha256:d1b3b4da11eefd5941e7f0b9cf17783fc99d9c6fc34884a665f40a06dbdfc94f
ARG GO_IMAGE=docker.io/library/golang:1.24@sha256:d2d2bc1c84f7e60d7d2438a3836ae7d0c847f4888464e7ec9ba3a1339a1ee804
ARG APP_VERSION=dev

FROM ${GO_IMAGE} AS relay-bridge-builder
WORKDIR /src
COPY packages/daemons/shared/go.mod packages/daemons/shared/go.sum ./packages/daemons/shared/
COPY packages/relay/go.mod packages/relay/go.sum ./packages/relay/
WORKDIR /src/packages/relay
RUN go mod download
WORKDIR /src
COPY packages/daemons/shared ./packages/daemons/shared
COPY packages/relay ./packages/relay
WORKDIR /src/packages/relay
ARG APP_VERSION
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.buildVersion=${APP_VERSION}-relay" -o /gateway-relay ./cmd/gateway-relay

FROM ${NODE_IMAGE} AS base

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

# Copy workspace root files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./

# Copy package.json files for all packages
COPY packages/backend/package.json packages/backend/
COPY packages/frontend/package.json packages/frontend/
COPY packages/status-page/package.json packages/status-page/

# Install all dependencies from the committed lockfile.
RUN pnpm install --frozen-lockfile

# ── Build frontend ──────────────────────────────────────────────────
FROM base AS frontend-builder

COPY packages/frontend/ packages/frontend/
RUN pnpm --filter frontend build

# ── Build public status page ────────────────────────────────────────
FROM base AS status-page-builder

COPY packages/status-page/ packages/status-page/
RUN pnpm --filter status-page build

# ── Build backend ───────────────────────────────────────────────────
FROM base AS backend-builder

COPY packages/backend/ packages/backend/
RUN pnpm --filter backend build

# ── Production image ────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS production

RUN apk add --no-cache git nginx && \
    mkdir -p /var/lib/gateway/tls /var/lib/gateway/sandbox-workspaces && \
    corepack enable && \
    corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/backend/package.json packages/backend/
RUN pnpm --filter backend install --prod --frozen-lockfile

WORKDIR /app/packages/backend

# Copy backend build
COPY --from=backend-builder /app/packages/backend/dist ./dist
COPY --from=backend-builder /app/packages/backend/src/db/migrations ./src/db/migrations
COPY config/update-trust/update-signing-public-key.pem ./dist/lib/update-signing-public-key.pem

# Copy proto file (loaded at runtime by @grpc/proto-loader)
COPY proto/ /app/proto/

# Copy frontend build into public/ for the backend to serve
COPY --from=frontend-builder /app/packages/frontend/dist ./public

# Copy public status page build into status-public/
COPY --from=status-page-builder /app/packages/status-page/dist ./status-public
# Pre-generic Gateway releases pass the signed app image to the relay service
# during the first self-update, so keep a one-hop relay binary in that image.
COPY --from=relay-bridge-builder /gateway-relay /gateway-relay

ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
ENV NODE_ENV=production
ENV PORT=3000
ENV GRPC_PORT=9443

EXPOSE 3000
EXPOSE 9443

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-check-certificate -qO- https://127.0.0.1:3000/health || wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "dist/index.js"]
