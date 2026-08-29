#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

GATEWAY=""
TOKEN=""
GATEWAY_CERT_SHA256=""
ADVERTISE_ADDRESS=""
SERVICE_PORT="9443"
VERSION="latest"
RELEASES_API_URL="${GATEWAY_RELEASES_API_URL:-https://updates.thesqlabs.com/gateway/releases}"
ARTIFACT_BASE_URL="${GATEWAY_ARTIFACT_BASE_URL:-https://updates.thesqlabs.com/gateway}"

usage() {
  echo "Usage: setup-relay-node.sh --gateway host:port --token TOKEN --gateway-cert-sha256 sha256:HEX --advertise-address HOST [--service-port 9443] [--version vX.Y.Z]"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --gateway) GATEWAY="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --gateway-cert-sha256) GATEWAY_CERT_SHA256="$2"; shift 2 ;;
    --advertise-address) ADVERTISE_ADDRESS="$2"; shift 2 ;;
    --service-port) SERVICE_PORT="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ ${EUID} -eq 0 ]] || { echo "Run this installer as root" >&2; exit 1; }
[[ -n "$GATEWAY" && -n "$TOKEN" && -n "$GATEWAY_CERT_SHA256" && -n "$ADVERTISE_ADDRESS" ]] || { usage >&2; exit 2; }
[[ "$SERVICE_PORT" =~ ^[0-9]+$ && "$SERVICE_PORT" -ge 1 && "$SERVICE_PORT" -le 65535 ]] || { echo "Invalid service port" >&2; exit 2; }
for command in curl jq openssl sha256sum install uname; do command -v "$command" >/dev/null || { echo "$command is required" >&2; exit 1; }; done

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

if [[ "$VERSION" == "latest" ]]; then
  TAG=$(curl -fsSL "${RELEASES_API_URL}?component=relay" | jq -r '.target.tag_name // empty')
  [[ -n "$TAG" ]] || { echo "No Relay release is available" >&2; exit 1; }
  VERSION="${TAG%-relay}"
else
  VERSION="v${VERSION#v}"
  TAG="${VERSION}-relay"
fi

PACKAGE_BASE="${ARTIFACT_BASE_URL}/relay-supervisor/${TAG}"
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

cat >"${TEMP_DIR}/update-public-key.pem" <<'KEY'
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAxLXGD8vCYQCYboK301miZXyAaoOLc43zFVnMlH3FeWg=
-----END PUBLIC KEY-----
KEY

decode_base64url() {
  local value="$1" remainder
  value="${value//-/+}"
  value="${value//_/\/}"
  remainder=$(( ${#value} % 4 ))
  [[ "$remainder" -eq 0 ]] || value="${value}$(printf '=%.0s' $(seq 1 $((4 - remainder))))"
  printf '%s' "$value" | openssl base64 -d -A
}

fetch_verified() {
  local name="$1" daemon_type="$2"
  local manifest="${TEMP_DIR}/${name}.update.json"
  local payload="${TEMP_DIR}/${name}.payload"
  local signature="${TEMP_DIR}/${name}.sig"
  local binary="${TEMP_DIR}/${name}"
  curl -fsSL "${PACKAGE_BASE}/${name}.update.json" -o "$manifest"
  [[ "$(jq -r '.schemaVersion' "$manifest")" == "1" && "$(jq -r '.keyId' "$manifest")" == "wiolett-update-v1" ]] || { echo "Untrusted manifest envelope for ${name}" >&2; exit 1; }
  decode_base64url "$(jq -r '.payload' "$manifest")" >"$payload"
  decode_base64url "$(jq -r '.signature' "$manifest")" >"$signature"
  openssl pkeyutl -verify -pubin -inkey "${TEMP_DIR}/update-public-key.pem" -rawin -in "$payload" -sigfile "$signature" >/dev/null
  [[ "$(jq -r '.kind' "$payload")" == "daemon-binary" && "$(jq -r '.version' "$payload")" == "$VERSION" && "$(jq -r '.tag' "$payload")" == "$TAG" && "$(jq -r '.daemonType' "$payload")" == "$daemon_type" && "$(jq -r '.arch' "$payload")" == "$ARCH" && "$(jq -r '.artifactName' "$payload")" == "$name" ]] || { echo "Manifest scope mismatch for ${name}" >&2; exit 1; }
  curl -fsSL "$(jq -r '.downloadUrl' "$payload")" -o "$binary"
  [[ "$(sha256sum "$binary" | awk '{print $1}')" == "$(jq -r '.sha256' "$payload")" ]] || { echo "Checksum mismatch for ${name}" >&2; exit 1; }
}

SUPERVISOR="relay-supervisor-linux-${ARCH}"
WORKER="relay-worker-linux-${ARCH}"
fetch_verified "$SUPERVISOR" relay
fetch_verified "$WORKER" relay-worker

install -d -m 0700 /etc/gateway-relay-supervisor /var/lib/gateway-relay-supervisor /usr/local/lib/gateway-relay
install -m 0755 "${TEMP_DIR}/${SUPERVISOR}" /usr/local/bin/relay-supervisor
install -m 0755 "${TEMP_DIR}/${WORKER}" /usr/local/lib/gateway-relay/gateway-relay
cat >/usr/local/lib/gateway-relay/run-supervisor <<'RUNNER'
#!/bin/sh
set -eu
binary=/usr/local/bin/relay-supervisor
pending="${binary}.update-pending"
previous="${binary}.previous"
while :; do
  "$binary" "$@" &
  child=$!
  watchdog=""
  if [ -f "$pending" ]; then
    (
      sleep 240
      if [ -f "$pending" ]; then kill -TERM "$child" 2>/dev/null || true; fi
    ) &
    watchdog=$!
  fi
  trap 'kill -TERM "$child" 2>/dev/null || true' TERM INT
  set +e
  wait "$child"
  status=$?
  set -e
  trap - TERM INT
  if [ -n "$watchdog" ]; then
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
  fi
  if [ -f "$pending" ] && [ -f "$previous" ]; then
    mv -f "$previous" "$binary"
    rm -f "$pending"
    continue
  fi
  exit "$status"
done
RUNNER
chmod 0755 /usr/local/lib/gateway-relay/run-supervisor
cat >/etc/gateway-relay-supervisor/config.yaml <<CONFIG
gateway:
  address: ${GATEWAY}
  token: ${TOKEN}
  cert_sha256: ${GATEWAY_CERT_SHA256}
tls:
  ca_cert: /var/lib/gateway-relay-supervisor/supervisor-identity/ca.pem
  client_cert: /var/lib/gateway-relay-supervisor/supervisor-identity/node.pem
  client_key: /var/lib/gateway-relay-supervisor/supervisor-identity/node-key.pem
state_dir: /var/lib/gateway-relay-supervisor
host_identity_path: /var/lib/gateway/host-identity
log_level: info
log_format: json
worker:
  binary_path: /usr/local/lib/gateway-relay/gateway-relay
  identity_dir: /var/lib/gateway-relay-supervisor/worker-identity
  state_dir: /var/lib/gateway-relay-supervisor/worker-state
  service_port: ${SERVICE_PORT}
  advertised_addresses:
    - ${ADVERTISE_ADDRESS}
CONFIG
chmod 0600 /etc/gateway-relay-supervisor/config.yaml

cat >/etc/systemd/system/gateway-relay-supervisor.service <<'UNIT'
[Unit]
Description=Gateway Relay Supervisor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/lib/gateway-relay/run-supervisor
Restart=always
RestartSec=3
NoNewPrivileges=true
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now gateway-relay-supervisor
echo "Relay supervisor ${VERSION} installed. Ensure TCP ${SERVICE_PORT} is reachable at ${ADVERTISE_ADDRESS}."
