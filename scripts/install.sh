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
SOURCE_DIR="${GATEWAY_SOURCE_DIR:-}"
LOG_FILE="${GATEWAY_INSTALL_LOG_FILE:-/tmp/gateway-install.log}"
UPDATE_SIGNING_PUBLIC_KEY='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAxLXGD8vCYQCYboK301miZXyAaoOLc43zFVnMlH3FeWg=
-----END PUBLIC KEY-----'

# ── Colors ────────────────────────────────────────────────────────────
BRAND_MINT='\033[38;2;140;176;132m'
GRAY='\033[0;90m'
NC='\033[0m'
BOLD='\033[1m'
INFO_TAG='\033[47m\033[90m'
WARN_TAG='\033[43m\033[30m'
ERROR_TAG='\033[41m\033[97m'
SUCCESS_TAG='\033[42m\033[97m'

info() { echo -e "${INFO_TAG} INFO ${NC} $*"; }
ok() { echo -e "${SUCCESS_TAG} OK ${NC} $*"; }
die() { echo -e "${ERROR_TAG} ERROR ${NC} $*" >&2; exit 1; }

show_header() {
  if [[ -t 1 ]] && command -v clear >/dev/null 2>&1; then
    clear
  fi
  echo -e "${BOLD}${BRAND_MINT}Gateway Installer${NC}"
  echo -e "${GRAY}Self-hosted infrastructure control plane${NC}"
  echo ""
}

run_quiet() {
  local label="$1"
  shift
  if "$@" >>"$LOG_FILE" 2>&1; then
    return
  fi
  die "${label} failed. Check ${LOG_FILE} for details."
}

json_string_field() {
  local file="$1" key="$2"
  sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | head -n1
}

decode_base64url() {
  local value="$1" output="$2"
  value="${value//-/+}"
  value="${value//_/\/}"
  case $((${#value} % 4)) in
    0) ;;
    2) value+="==" ;;
    3) value+="=" ;;
    *) return 1 ;;
  esac
  printf '%s' "$value" | openssl base64 -d -A >"$output"
}

verify_signed_release() {
  local version="$1" encoded_project="$2"
  local tmp_dir manifest_file payload_file signature_file key_file
  local payload signature kind manifest_version tag image digest image_ref

  tmp_dir="$(mktemp -d)"
  manifest_file="${tmp_dir}/gateway-image.update.json"
  payload_file="${tmp_dir}/payload.json"
  signature_file="${tmp_dir}/signature.bin"
  key_file="${tmp_dir}/update-signing-public-key.pem"

  info "Verifying signed release manifest for ${version}"
  if ! curl -fsSL "${GITLAB_API_URL}/api/v4/projects/${encoded_project}/packages/generic/gateway/${version}/gateway-image.update.json" -o "$manifest_file" >>"$LOG_FILE" 2>&1; then
    rm -rf "$tmp_dir"
    die "Could not download the signed release manifest. Check ${LOG_FILE} for details."
  fi

  payload="$(json_string_field "$manifest_file" payload)"
  signature="$(json_string_field "$manifest_file" signature)"
  if [[ -z "$payload" || -z "$signature" ]]; then
    rm -rf "$tmp_dir"
    die "Signed release manifest is malformed."
  fi
  if ! decode_base64url "$payload" "$payload_file" 2>>"$LOG_FILE" ||
    ! decode_base64url "$signature" "$signature_file" 2>>"$LOG_FILE"; then
    rm -rf "$tmp_dir"
    die "Signed release manifest contains invalid base64 data."
  fi
  printf '%s\n' "$UPDATE_SIGNING_PUBLIC_KEY" >"$key_file"
  if ! openssl pkeyutl -verify -rawin -pubin -inkey "$key_file" -in "$payload_file" -sigfile "$signature_file" >>"$LOG_FILE" 2>&1; then
    rm -rf "$tmp_dir"
    die "Signed release manifest signature verification failed."
  fi

  kind="$(json_string_field "$payload_file" kind)"
  manifest_version="$(json_string_field "$payload_file" version)"
  tag="$(json_string_field "$payload_file" tag)"
  image="$(json_string_field "$payload_file" image)"
  digest="$(json_string_field "$payload_file" digest)"
  image_ref="$(json_string_field "$payload_file" imageRef)"
  if [[ "$kind" != "gateway-image" || "$manifest_version" != "$version" || "$tag" != "$version" ||
    "$image" != "$IMAGE" || ! "$digest" =~ ^sha256:[a-f0-9]{64}$ || "$image_ref" != "${IMAGE}@${digest}" ]]; then
    rm -rf "$tmp_dir"
    die "Signed release manifest does not match the requested Gateway image."
  fi
  rm -rf "$tmp_dir"

  IMAGE_REF="$image_ref"
  ok "Release ${version} verified (SHA-256: ${digest#sha256:})"
}

local_source_checksum() {
  (
    cd "$SOURCE_DIR"
    find . -type f \
      ! -path './.git/*' \
      ! -path './node_modules/*' \
      ! -path './.memory/*' \
      -print0 |
      LC_ALL=C sort -z |
      xargs -0 sha256sum
  ) | sha256sum | awk '{print $1}'
}

usage() {
  cat <<'EOF'
Usage: install.sh [--install-dir PATH] [--image IMAGE] [--source-dir PATH] [--http|--https]

Installs or updates Gateway. On a fresh interactive install, the only prompt
selects native HTTPS or HTTP for port 3000. Non-interactive installs default
to native HTTPS. All product configuration continues in the browser wizard.

--source-dir builds the Gateway image from a local source checkout on this
host. It is intended for a fresh test installation and skips GitLab release
discovery and image pulls.
EOF
}

while (($#)); do
  case "$1" in
    --install-dir) INSTALL_DIR="${2:?missing path}"; shift 2 ;;
    --image) IMAGE="${2:?missing image}"; shift 2 ;;
    --source-dir) SOURCE_DIR="${2:?missing path}"; shift 2 ;;
    --http) TRANSPORT="http"; shift ;;
    --https) TRANSPORT="https"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

show_header

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
    printf 'Gateway can serve port 3000 with its own System CA certificate.\n' >/dev/tty
    printf 'Use native HTTPS now? [Y/n] ' >/dev/tty
    read -r answer </dev/tty || true
    case "${answer:-Y}" in n|N|no|NO) TRANSPORT="http" ;; esac
    printf '\n' >/dev/tty
  fi
fi
[[ "$TRANSPORT" == "http" || "$TRANSPORT" == "https" || "$FRESH" == 0 ]] || die "GATEWAY_WEB_TRANSPORT must be http or https"
umask 077
: >"$LOG_FILE" 2>/dev/null || die "Unable to create installer log at ${LOG_FILE}"
chmod 600 "$LOG_FILE" 2>/dev/null || true

if [[ -n "$SOURCE_DIR" ]]; then
  [[ "$FRESH" == 1 ]] || die "--source-dir is supported only for a fresh Gateway installation"
  [[ -d "$SOURCE_DIR" && -f "$SOURCE_DIR/Dockerfile" && -f "$SOURCE_DIR/package.json" ]] || \
    die "--source-dir must point to a Gateway source checkout"
  SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
  VERSION="local-$(date -u +%Y%m%d%H%M%S)"
  IMAGE_REF="${IMAGE}:${VERSION}"
  source_checksum="$(local_source_checksum)"
  [[ "$source_checksum" =~ ^[a-f0-9]{64}$ ]] || die "Could not calculate the local source checksum"
  info "Version: ${VERSION} (local source)"
  ok "Local source checksum calculated (SHA-256: ${source_checksum})"
  info "Building Gateway from local source: ${SOURCE_DIR}"
  run_quiet "Gateway image build" "${DOCKER[@]}" build --build-arg "APP_VERSION=${VERSION}" --tag "$IMAGE_REF" "$SOURCE_DIR"
else
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
  info "Version: ${VERSION}"
  verify_signed_release "$VERSION" "$encoded_project"
fi

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

detect_local_host_address_lines() {
  if command -v ip >/dev/null; then
    ip -o addr show up scope global 2>/dev/null | awk '
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
      interface ~ /^cali/ ||
      interface ~ /^kube/ ||
      interface ~ /^tailscale/ ||
      interface ~ /^zt/ ||
      interface ~ /^lxc/ ||
      interface ~ /^incus/ ||
      interface ~ /^vboxnet/ ||
      interface ~ /^vmnet/ { next }
      $3 == "inet" { sub(/\/.*/, "", $4); if ($4 !~ /^127\./) print $4; next }
      $3 == "inet6" {
        sub(/\/.*/, "", $4)
        address = tolower($4)
        if (address != "::1" && address !~ /^fe80:/) print $4
      }
    ' | awk '!seen[$0]++'
  fi
}

detect_local_host_addresses() {
  detect_local_host_address_lines | paste -sd, -
}

format_gateway_url() {
  local address="$1"
  if [[ "$address" == *:* ]]; then
    printf '%s://[%s]:3000' "$TRANSPORT" "$address"
  else
    printf '%s://%s:3000' "$TRANSPORT" "$address"
  fi
}

print_gateway_urls() {
  local address
  echo -e "  ${BRAND_MINT}Open:${NC}"
  echo -e "    ${GRAY}Local:${NC}   ${TRANSPORT}://localhost:3000"
  while IFS= read -r address; do
    [[ -n "$address" ]] || continue
    printf '    %bNetwork:%b %s\n' "$GRAY" "$NC" "$(format_gateway_url "$address")"
  done < <(detect_local_host_address_lines)
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
  run_quiet "Gateway image pull" "${DOCKER[@]}" pull "$IMAGE_REF"
  run_quiet "Gateway foundation migration" "${DOCKER[@]}" run --rm -v "$INSTALL_DIR:/host" "$IMAGE_REF" \
    node dist/foundation-migrator.js \
    --host-dir /host \
    --target-version "$VERSION" \
    --image-ref "$IMAGE_REF"
fi

if [[ -z "$SOURCE_DIR" ]]; then
  info "Pulling ${IMAGE_REF}"
  run_quiet "Gateway service image pull" "${DOCKER[@]}" compose pull
fi
info "Starting Gateway services"
run_quiet "Gateway service startup" "${DOCKER[@]}" compose up -d

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
  run_quiet "Legacy settings migration" "${DOCKER[@]}" compose run --rm -T -v "$INSTALL_DIR:/host" app \
    node dist/cli/migrate-legacy-settings.js /host
  run_quiet "Gateway restart after legacy migration" "${DOCKER[@]}" compose up -d --force-recreate app
fi

printf '\n'
ok "Gateway ${VERSION} is running"
if [[ "$FRESH" == 1 ]]; then
  if ! setup_json="$("${DOCKER[@]}" compose exec -T app node dist/cli/setup-code.js 2>>"$LOG_FILE" | sed -n '/^{"id":/p' | tail -n1)"; then
    die "Gateway started, but the setup code could not be generated. Check ${LOG_FILE} for details."
  fi
  setup_code="$(printf '%s' "$setup_json" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')"
  expires_at="$(printf '%s' "$setup_json" | sed -n 's/.*"expiresAt":"\([^"]*\)".*/\1/p')"
  ca_fingerprint="$(printf '%s' "$setup_json" | sed -n 's/.*"caFingerprint":"\([^"]*\)".*/\1/p')"
  [[ -n "$setup_code" ]] || die "Gateway started, but the setup code could not be generated"
  print_gateway_urls
  printf '  %bSetup code:%b %s\n' "$BRAND_MINT" "$NC" "$setup_code"
  printf '  %bExpires:%b    %s\n' "$GRAY" "$NC" "$expires_at"
  printf '  %bSystem CA:%b  %s\n' "$GRAY" "$NC" "$ca_fingerprint"
  printf '  %bReset:%b      cd %s && docker compose exec app node dist/cli/reset-setup.js\n' "$GRAY" "$NC" "$INSTALL_DIR"
  printf '\n  %bThe setup code is shown once. Finish configuration in the browser.%b\n' "$GRAY" "$NC"
else
  printf '  %bExisting installation updated; persisted Gateway settings were preserved.%b\n' "$GRAY" "$NC"
fi
