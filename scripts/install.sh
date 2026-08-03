#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

DEFAULT_IMAGE="registry.gitlab.wiolett.net/wiolett/gateway"
DEFAULT_INSTALL_DIR="/opt/gateway"
GITLAB_API_URL="${GITLAB_API_URL:-https://gitlab.wiolett.net}"
GITLAB_PROJECT_PATH="${GITLAB_PROJECT_PATH:-wiolett/gateway}"
INSTALL_DIR="${GATEWAY_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
IMAGE="${GATEWAY_IMAGE:-$DEFAULT_IMAGE}"
TRANSPORT="${GATEWAY_WEB_TRANSPORT:-}"

info() { printf '  INFO  %s\n' "$1"; }
ok() { printf '  OK    %s\n' "$1"; }
die() { printf '  ERROR %s\n' "$1" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [--install-dir PATH] [--image IMAGE] [--http|--https]

Installs or updates Gateway. On a fresh interactive install, the only prompt
selects native HTTPS or HTTP for port 3000. Non-interactive installs default
to native HTTPS. All product configuration continues in the browser wizard.
EOF
}

while (($#)); do
  case "$1" in
    --install-dir) INSTALL_DIR="${2:?missing path}"; shift 2 ;;
    --image) IMAGE="${2:?missing image}"; shift 2 ;;
    --http) TRANSPORT="http"; shift ;;
    --https) TRANSPORT="https"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

command -v curl >/dev/null || die "curl is required"
command -v openssl >/dev/null || die "openssl is required"
if ! command -v docker >/dev/null; then
  die "Docker Engine with the Compose plugin is required"
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"

DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  command -v sudo >/dev/null || die "Docker is not accessible by the current user"
  sudo docker info >/dev/null 2>&1 || die "Docker is not accessible"
  DOCKER=(sudo docker)
fi

if [[ ! -d "$INSTALL_DIR" ]]; then
  if mkdir -p "$INSTALL_DIR" 2>/dev/null; then :; else sudo mkdir -p "$INSTALL_DIR"; sudo chown "$(id -u):$(id -g)" "$INSTALL_DIR"; fi
fi
cd "$INSTALL_DIR"
INSTALL_DIR="$(pwd)"

FRESH=0
[[ -f .env ]] || FRESH=1

if [[ "$FRESH" == 1 && -z "$TRANSPORT" ]]; then
  TRANSPORT="https"
  if [[ -r /dev/tty && -w /dev/tty ]]; then
    printf '\nGateway can serve port 3000 with its own System CA certificate.\n' >/dev/tty
    printf 'Use native HTTPS now? [Y/n] ' >/dev/tty
    read -r answer </dev/tty || true
    case "${answer:-Y}" in n|N|no|NO) TRANSPORT="http" ;; esac
  fi
fi
[[ "$TRANSPORT" == "http" || "$TRANSPORT" == "https" || "$FRESH" == 0 ]] || die "GATEWAY_WEB_TRANSPORT must be http or https"

encoded_project="${GITLAB_PROJECT_PATH//\//%2F}"
info "Resolving the latest Gateway release"
release_json="$(curl -fsSL "${GITLAB_API_URL}/api/v4/projects/${encoded_project}/releases?per_page=100")" || die "Unable to query releases"
VERSION="$(
  printf '%s' "$release_json" |
    grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' |
    sed -E 's/^.*"([^"]+)"$/\1/' |
    grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' |
    sort -V |
    tail -n1 || true
)"
[[ -n "$VERSION" ]] || die "The release API did not return an eligible Gateway release"
IMAGE_REF="${IMAGE}:${VERSION}"

env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" .env 2>/dev/null | tail -n1
}

ensure_env() {
  local key="$1" value="$2"
  grep -q "^${key}=" .env 2>/dev/null || printf '%s=%s\n' "$key" "$value" >>.env
}

set_env() {
  local key="$1" value="$2" output
  output="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    index($0, key "=") == 1 { if (!done) { print key "=" value; done=1 } next }
    { print }
    END { if (!done) print key "=" value }
  ' .env >"$output"
  mv "$output" .env
}

detect_local_host_addresses() {
  local addresses=""
  if command -v ip >/dev/null; then
    addresses="$(ip -o addr show up 2>/dev/null | awk '
      {
        interface = $2
        sub(/@.*/, "", interface)
      }
      interface == "lo" ||
      interface ~ /^docker/ ||
      interface ~ /^br-/ ||
      interface ~ /^veth/ ||
      interface ~ /^virbr/ ||
      interface ~ /^podman/ ||
      interface ~ /^cni/ ||
      interface ~ /^flannel/ ||
      interface ~ /^cali/ { next }
      $3 == "inet" || $3 == "inet6" { sub(/\/.*/, "", $4); print $4 }
    ')"
  fi
  printf '%s\n' "$addresses" | sed '/^[[:space:]]*$/d' | paste -sd, -
}

if [[ "$FRESH" == 1 ]]; then
  umask 077
  : >.env
fi
ensure_env GATEWAY_IMAGE_REF "$IMAGE_REF"
ensure_env DB_PASSWORD "$(openssl rand -hex 24)"
ensure_env PKI_MASTER_KEY "$(openssl rand -hex 32)"
ensure_env SETUP_BOOTSTRAP "$([[ "$FRESH" == 1 ]] && printf true || printf false)"
ensure_env WEB_TLS_BOOTSTRAP_MODE "${TRANSPORT:-http}"
ensure_env SANDBOX_RUNNER_WORKSPACE_DIR "/var/lib/gateway/sandbox-workspaces"
local_host_addresses="$(detect_local_host_addresses)"
if [[ -n "$local_host_addresses" ]]; then
  set_env GATEWAY_LOCAL_HOSTS "$local_host_addresses"
else
  ensure_env GATEWAY_LOCAL_HOSTS ""
fi
chmod 600 .env

# Always advance the managed image reference to the latest release.
tmp_env="$(mktemp)"
awk -v ref="$IMAGE_REF" 'BEGIN{done=0} /^GATEWAY_IMAGE_REF=/{if(!done){print "GATEWAY_IMAGE_REF=" ref; done=1} next} {print} END{if(!done) print "GATEWAY_IMAGE_REF=" ref}' .env >"$tmp_env"
mv "$tmp_env" .env
chmod 600 .env

if [[ "$FRESH" == 1 ]]; then
  cat >docker-compose.yml <<'COMPOSE'
services:
  app:
    image: ${GATEWAY_IMAGE_REF}
    restart: unless-stopped
    env_file: .env
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: postgres://gateway:${DB_PASSWORD}@postgres:5432/gateway
      REDIS_URL: redis://redis:6379
      PKI_MASTER_KEY: ${PKI_MASTER_KEY}
      WEB_TLS_AUTO_DIR: /var/lib/gateway/tls
      GRPC_TLS_AUTO_DIR: /var/lib/gateway/tls
      SANDBOX_RUNNER_WORKSPACE_DIR: ${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}
    ports:
      - "3000:3000"
      - "9443:9443"
    volumes:
      - gateway_data:/var/lib/gateway
      - ${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}:${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget --no-check-certificate -qO- https://127.0.0.1:3000/health || wget -qO- http://127.0.0.1:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 20s

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: gateway
      POSTGRES_USER: gateway
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gateway -d gateway"]
      interval: 5s
      timeout: 5s
      retries: 12

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 12

volumes:
  gateway_data:
  postgres_data:
  redis_data:
COMPOSE
else
  info "Migrating the existing installer-managed Compose foundation"
  "${DOCKER[@]}" pull "$IMAGE_REF"
  "${DOCKER[@]}" run --rm -v "$INSTALL_DIR:/host" "$IMAGE_REF" \
    node dist/foundation-migrator.js \
    --host-dir /host \
    --target-version "$VERSION" \
    --image-ref "$IMAGE_REF"
fi

info "Pulling ${IMAGE_REF}"
"${DOCKER[@]}" compose pull
"${DOCKER[@]}" compose up -d

info "Waiting for Gateway"
healthy=0
for _ in $(seq 1 90); do
  if curl -kfsS https://127.0.0.1:3000/health >/dev/null 2>&1 || curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
[[ "$healthy" == 1 ]] || die "Gateway did not become healthy; run: docker compose logs app"

# The first boot imports legacy OIDC_*, CLICKHOUSE_*, and APP_URL values into
# encrypted Gateway settings. The guarded migration command verifies a complete
# legacy tuple before it removes anything from disk.
if grep -Eq '^(OIDC_|CLICKHOUSE_|APP_URL=|SETUP_TOKEN=)' .env; then
  info "Finalizing legacy settings migration"
  "${DOCKER[@]}" compose run --rm -T -v "$INSTALL_DIR:/host" app \
    node dist/cli/migrate-legacy-settings.js /host
  "${DOCKER[@]}" compose up -d --force-recreate app
fi

printf '\n'
ok "Gateway ${VERSION} is running"
if [[ "$FRESH" == 1 ]]; then
  setup_json="$("${DOCKER[@]}" compose exec -T app node dist/cli/setup-code.js | sed -n '/^{"id":/p' | tail -n1)"
  setup_code="$(printf '%s' "$setup_json" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')"
  expires_at="$(printf '%s' "$setup_json" | sed -n 's/.*"expiresAt":"\([^"]*\)".*/\1/p')"
  ca_fingerprint="$(printf '%s' "$setup_json" | sed -n 's/.*"caFingerprint":"\([^"]*\)".*/\1/p')"
  [[ -n "$setup_code" ]] || die "Gateway started, but the setup code could not be generated"
  printf '  Open:       %s://<server-ip>:3000\n' "$TRANSPORT"
  printf '  Setup code: %s\n' "$setup_code"
  printf '  Expires:    %s\n' "$expires_at"
  printf '  System CA:  %s\n' "$ca_fingerprint"
  printf '  Reset:      cd %s && docker compose exec app node dist/cli/reset-setup.js\n' "$INSTALL_DIR"
  printf '\nThe setup code is shown once. Finish configuration in the browser.\n'
else
  printf '  Existing installation updated; persisted Gateway settings were preserved.\n'
fi
