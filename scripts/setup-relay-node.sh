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
RUN_USER="${GATEWAY_RELAY_RUN_USER:-root}"
RUN_GROUP="${GATEWAY_RELAY_RUN_GROUP:-root}"
LOG_FILE="${GATEWAY_RELAY_SETUP_LOG:-/dev/null}"
MANUAL_LAUNCH_TIMEOUT_SECONDS="${GATEWAY_MANUAL_LAUNCH_TIMEOUT_SECONDS:-30}"
MANUAL_FALLBACK_USED=0

usage() {
  echo "Usage: setup-relay-node.sh --gateway host:port --token TOKEN --gateway-cert-sha256 sha256:HEX --advertise-address HOST [--service-port 9443] [--version vX.Y.Z]"
}

command_exists() { command -v "$1" >/dev/null 2>&1; }
has_systemd() { command_exists systemctl && [[ -d /run/systemd/system ]]; }
has_openrc() { command_exists rc-service && command_exists rc-update; }

launcher_pid_from_json() {
  local metadata="$1"
  local pid
  [[ -f "$metadata" && ! -L "$metadata" ]] || return 1
  pid=$(sed -nE 's/.*"(pid|launcherPid|launcher_pid)"[[:space:]]*:[[:space:]]*([0-9]+).*/\2/p' "$metadata" | head -n 1 || true)
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  printf '%s\n' "$pid"
}

launcher_pid_is_live() {
  local pid="${1:-}"
  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

launcher_child_is_ready() {
  local metadata="$1"
  [[ -f "$metadata" && ! -L "$metadata" ]] || return 1
  grep -Eq '"ready"[[:space:]]*:[[:space:]]*true' "$metadata" 2>/dev/null
}

legacy_file_owner_is_allowed() {
  local path="$1"
  local owner run_uid
  owner=$(stat -c '%u' "$path" 2>/dev/null || true)
  [[ "$owner" == "0" ]] && return 0
  [[ "$RUN_USER" != "root" ]] || return 1
  run_uid=$(id -u "$RUN_USER" 2>/dev/null || true)
  [[ -n "$run_uid" && "$owner" == "$run_uid" ]]
}

legacy_update_marker_is_recognizable() {
  local marker="$1"
  local daemon_binary="$2"
  [[ -f "$marker" && ! -L "$marker" ]] || return 1
  legacy_file_owner_is_allowed "$marker" || return 1
  case "$marker" in
    "${daemon_binary}.update-pending")
      grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9._-]+)?[[:space:]]*$' "$marker" 2>/dev/null
      ;;
    "${daemon_binary}.update-state.json")
      grep -Eq '"schemaVersion"[[:space:]]*:[[:space:]]*1([,}[:space:]]|$)' "$marker" 2>/dev/null \
        && grep -Eq '"fromVersion"[[:space:]]*:[[:space:]]*"[^"]+"' "$marker" 2>/dev/null \
        && grep -Eq '"targetVersion"[[:space:]]*:[[:space:]]*"[^"]+"' "$marker" 2>/dev/null
      ;;
    "${daemon_binary}.update-outcome.json")
      grep -Eq '"schemaVersion"[[:space:]]*:[[:space:]]*1([,}[:space:]]|$)' "$marker" 2>/dev/null \
        && grep -Eq '"status"[[:space:]]*:[[:space:]]*"rolled_back"' "$marker" 2>/dev/null \
        && grep -Eq '"fromVersion"[[:space:]]*:[[:space:]]*"[^"]+"' "$marker" 2>/dev/null \
        && grep -Eq '"targetVersion"[[:space:]]*:[[:space:]]*"[^"]+"' "$marker" 2>/dev/null
      ;;
    *)
      return 1
      ;;
  esac
}

retire_legacy_update_guard() {
  local unit="$1"
  local daemon_binary="$2"
  local dropin="/etc/systemd/system/${unit}.service.d/20-update-rollback.conf"
  local marker
  local marker_found=0
  local dropin_owner

  [[ -f "$dropin" && ! -L "$dropin" ]] || return 0
  dropin_owner=$(stat -c '%u' "$dropin" 2>/dev/null || true)
  [[ "$dropin_owner" == "0" ]] || return 0
  grep -Fq -- "update-guard" "$dropin" || return 0
  grep -Fq -- "$daemon_binary" "$dropin" || return 0
  grep -Eq -- "(^|[[:space:]=])${daemon_binary}([[:space:]]|$)" "$dropin" || return 0

  for marker in \
    "${daemon_binary}.update-state.json" \
    "${daemon_binary}.update-pending" \
    "${daemon_binary}.update-outcome.json"; do
    if legacy_update_marker_is_recognizable "$marker" "$daemon_binary"; then
      marker_found=1
      break
    fi
  done
  [[ "$marker_found" -eq 1 ]] || return 0

  if ! rm -f -- "$dropin"; then
    echo "Could not retire the legacy update guard at ${dropin}; preserving it." >&2
    return 0
  fi
  for marker in \
    "${daemon_binary}.update-state.json" \
    "${daemon_binary}.update-pending" \
    "${daemon_binary}.update-outcome.json"; do
    if legacy_update_marker_is_recognizable "$marker" "$daemon_binary"; then
      rm -f -- "$marker" || echo "Could not retire legacy update marker ${marker}; preserving it." >&2
    fi
  done
  echo "Retired the legacy update guard for ${daemon_binary}; preserved .previous and unknown files."
}

launcher_foreground_command() {
  local daemon_binary="$1"
  if [[ "$RUN_USER" == "root" ]]; then
    printf '%q run' "$daemon_binary"
  elif command_exists runuser; then
    printf 'runuser -u %q -g %q -- %q run' "$RUN_USER" "$RUN_GROUP" "$daemon_binary"
  elif command_exists sudo; then
    printf 'sudo -n -u %q -g %q -- %q run' "$RUN_USER" "$RUN_GROUP" "$daemon_binary"
  elif command_exists setpriv; then
    printf 'setpriv --reuid=%q --regid=%q --init-groups -- %q run' "$RUN_USER" "$RUN_GROUP" "$daemon_binary"
  else
    printf '%q run' "$daemon_binary"
  fi
}

prepare_manual_launcher_state() {
  local state_dir="$1"
  local launcher_dir="${state_dir}/launcher"
  local manual_log="${launcher_dir}/manual.log"

  [[ ! -L "$launcher_dir" ]] || return 1
  mkdir -p "$launcher_dir" || return 1
  chmod 0700 "$launcher_dir" || return 1
  if [[ "$RUN_USER" != "root" ]] && ! chown "${RUN_USER}:${RUN_GROUP}" "$launcher_dir"; then
    return 1
  fi
  [[ ! -L "$manual_log" ]] || return 1
  touch "$manual_log" || return 1
  chmod 0640 "$manual_log" || return 1
  if [[ "$RUN_USER" != "root" ]] && ! chown "${RUN_USER}:${RUN_GROUP}" "$manual_log"; then
    return 1
  fi
}

detach_manual_launcher() {
  local daemon_binary="$1"
  local manual_log="$2"
  local -a user_prefix=()

  if [[ "$RUN_USER" != "root" ]]; then
    if command_exists runuser; then
      user_prefix=(runuser -u "$RUN_USER" -g "$RUN_GROUP" --)
    elif command_exists sudo; then
      user_prefix=(sudo -n -u "$RUN_USER" -g "$RUN_GROUP" --)
    elif command_exists setpriv; then
      user_prefix=(setpriv "--reuid=${RUN_USER}" "--regid=${RUN_GROUP}" --init-groups --)
    else
      return 1
    fi
  fi

  if command_exists setsid && command_exists nohup; then
    setsid nohup "${user_prefix[@]}" "$daemon_binary" run </dev/null >>"$manual_log" 2>&1 &
  elif command_exists nohup; then
    nohup "${user_prefix[@]}" "$daemon_binary" run </dev/null >>"$manual_log" 2>&1 &
  else
    return 1
  fi
  MANUAL_LAUNCH_PID=$!
}

wait_for_manual_launcher_ready() {
  local launcher_dir="$1"
  local daemon_type="$2"
  local owner_json="${launcher_dir}/owner.json"
  local child_json="${launcher_dir}/child.json"
  local owner_pid child_pid attempts=0

  while (( attempts < MANUAL_LAUNCH_TIMEOUT_SECONDS )); do
    owner_pid="$(launcher_pid_from_json "$owner_json" || true)"
    child_pid="$(launcher_pid_from_json "$child_json" || true)"
    if grep -Eq '"protocolVersion"[[:space:]]*:[[:space:]]*1([,}[:space:]]|$)' "$owner_json" 2>/dev/null \
      && grep -Fq -- "\"daemonType\":\"${daemon_type}\"" "$owner_json" 2>/dev/null \
      && launcher_pid_is_live "$owner_pid" \
      && launcher_pid_is_live "$child_pid" \
      && launcher_child_is_ready "$child_json"; then
      MANUAL_OWNER_PID="$owner_pid"
      MANUAL_CHILD_PID="$child_pid"
      return 0
    fi
    attempts=$((attempts + 1))
    sleep 1
  done
  return 1
}

manual_launcher_fallback() {
  local daemon_name="$1"
  local daemon_binary="$2"
  local state_dir="$3"
  local launcher_dir="${state_dir}/launcher"
  local manual_log="${launcher_dir}/manual.log"
  local owner_pid daemon_type
  MANUAL_FALLBACK_USED=1

  case "$daemon_binary" in
    */docker-daemon) daemon_type="docker" ;;
    */nginx-daemon) daemon_type="nginx" ;;
    */monitoring-daemon) daemon_type="monitoring" ;;
    */relay-supervisor) daemon_type="relay" ;;
    *) echo "Unknown launcher daemon binary ${daemon_binary}; preserving installed files." >&2; return 0 ;;
  esac

  owner_pid="$(launcher_pid_from_json "${launcher_dir}/owner.json" || true)"
  if launcher_pid_is_live "$owner_pid"; then
    if wait_for_manual_launcher_ready "$launcher_dir" "$daemon_type"; then
      echo "${daemon_name} launcher is already ready (PID ${MANUAL_OWNER_PID}, child PID ${MANUAL_CHILD_PID})."
      echo "Manual launcher log: ${manual_log}"
      echo "Manual mode is not persistent across reboot."
    else
      echo "${daemon_name} has a live launcher owner but no verified ready child; refusing to start a competing launcher." >&2
      echo "Launcher state: ${launcher_dir}"
      echo "Launcher log: ${manual_log}"
    fi
    return 0
  fi

  if ! prepare_manual_launcher_state "$state_dir"; then
    echo "Could not prepare manual launcher state for ${daemon_name}; installed files were preserved." >&2
    echo "Foreground command: $(launcher_foreground_command "$daemon_binary")"
    return 0
  fi
  if ! detach_manual_launcher "$daemon_binary" "$manual_log"; then
    echo "Could not detach ${daemon_name}; installed files and launcher files were preserved." >&2
    echo "Launcher log: ${manual_log}"
    echo "Foreground command: $(launcher_foreground_command "$daemon_binary")"
    return 0
  fi

  if wait_for_manual_launcher_ready "$launcher_dir" "$daemon_type"; then
    echo "${daemon_name} is running in manual mode (launcher PID ${MANUAL_OWNER_PID}, child PID ${MANUAL_CHILD_PID})."
    echo "Launcher PID: ${MANUAL_OWNER_PID}"
    echo "Child PID: ${MANUAL_CHILD_PID}"
    echo "Manual launcher log: ${manual_log}"
    echo "Manual mode is not persistent across reboot."
    return 0
  fi

  echo "Could not verify the detached ${daemon_name} launcher; installed files and launcher files were preserved." >&2
  echo "Launcher state: ${launcher_dir}"
  echo "Launcher log: ${manual_log}"
  echo "Foreground command: $(launcher_foreground_command "$daemon_binary")"
  echo "Manual mode is not persistent across reboot."
  return 0
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
exec /usr/local/bin/relay-supervisor run "$@"
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

start_relay_supervisor() {
  retire_legacy_update_guard "gateway-relay-supervisor" "/usr/local/bin/relay-supervisor"

  if has_systemd; then
    if ! cat >/etc/systemd/system/gateway-relay-supervisor.service <<UNIT
[Unit]
Description=Gateway Relay Supervisor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
ExecStart=/usr/local/lib/gateway-relay/run-supervisor
Restart=always
RestartSec=3
NoNewPrivileges=true
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
UNIT
    then
      echo "Could not write the relay supervisor systemd unit; using manual mode." >&2
      manual_launcher_fallback "relay-supervisor" "/usr/local/bin/relay-supervisor" "/var/lib/gateway-relay-supervisor"
      return 0
    fi
    if ! systemctl daemon-reload >>"$LOG_FILE" 2>&1 \
      || ! systemctl enable gateway-relay-supervisor >>"$LOG_FILE" 2>&1 \
      || ! systemctl restart gateway-relay-supervisor >>"$LOG_FILE" 2>&1; then
      echo "Could not register or start the relay supervisor with systemd; using manual mode." >&2
      manual_launcher_fallback "relay-supervisor" "/usr/local/bin/relay-supervisor" "/var/lib/gateway-relay-supervisor"
      return 0
    fi
    sleep 2
    if systemctl is-active --quiet gateway-relay-supervisor; then
      echo "Relay supervisor is running."
      return 0
    fi
    echo "Relay supervisor is not active; using manual mode." >&2
  elif has_openrc; then
    if ! cat >/etc/init.d/gateway-relay-supervisor <<UNIT
#!/sbin/openrc-run
name="Gateway Relay Supervisor"
description="Gateway Relay Supervisor"
command="/usr/local/lib/gateway-relay/run-supervisor"
command_user="${RUN_USER}:${RUN_GROUP}"
pidfile="/run/\${RC_SVCNAME}.pid"
supervisor="supervise-daemon"
respawn_delay=3
output_log="/var/log/gateway-relay-supervisor.log"
error_log="/var/log/gateway-relay-supervisor.err"

depend() {
    need net
}
UNIT
    then
      echo "Could not write the relay supervisor OpenRC service; using manual mode." >&2
      manual_launcher_fallback "relay-supervisor" "/usr/local/bin/relay-supervisor" "/var/lib/gateway-relay-supervisor"
      return 0
    fi
    if ! chmod +x /etc/init.d/gateway-relay-supervisor \
      || ! rc-update add gateway-relay-supervisor default >>"$LOG_FILE" 2>&1 \
      || { ! rc-service gateway-relay-supervisor restart >>"$LOG_FILE" 2>&1 && ! rc-service gateway-relay-supervisor start >>"$LOG_FILE" 2>&1; }; then
      echo "Could not register or start the relay supervisor with OpenRC; using manual mode." >&2
      manual_launcher_fallback "relay-supervisor" "/usr/local/bin/relay-supervisor" "/var/lib/gateway-relay-supervisor"
      return 0
    fi
    sleep 2
    if rc-service gateway-relay-supervisor status >>"$LOG_FILE" 2>&1; then
      echo "Relay supervisor is running."
      return 0
    fi
    echo "Relay supervisor is not active in OpenRC; using manual mode." >&2
  else
    echo "No supported service manager found; using manual mode." >&2
  fi
  manual_launcher_fallback "relay-supervisor" "/usr/local/bin/relay-supervisor" "/var/lib/gateway-relay-supervisor"
}

start_relay_supervisor
echo "Relay supervisor ${VERSION} installed. Ensure TCP ${SERVICE_PORT} is reachable at ${ADVERTISE_ADDRESS}."
