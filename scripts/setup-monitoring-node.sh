#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# ── Gateway Monitoring Node Setup ──────────────────────────────────
# Installs monitoring-daemon on a host and enrolls it with the Gateway.
# No nginx or Docker required — this agent reports system metrics only.
#
# Usage:
#   curl -sSL https://github.com/wiolett-industries/gateway/releases/latest/download/setup-monitoring-node.sh | \
#     sudo bash -s -- --gateway gateway.example.com:9443 --token <ENROLLMENT_TOKEN> --gateway-cert-sha256 sha256:<HEX>
# ───────────────────────────────────────────────────────────────────

LOG_FILE="/dev/null"

# ── Colors ────────────────────────────────────────────────────────
BRAND_MINT='\033[38;2;140;176;132m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
GRAY='\033[0;90m'
NC='\033[0m'
BOLD='\033[1m'
TITLE_TAG='\033[48;2;140;176;132m\033[30m'
INFO_TAG='\033[48;2;74;74;74m\033[38;2;185;185;185m'
WARN_TAG='\033[48;2;112;97;48m\033[38;2;244;234;198m'
ERROR_TAG='\033[48;2;96;61;43m\033[38;2;245;221;202m'
SUCCESS_TAG='\033[42m\033[97m'

# ── Defaults ──────────────────────────────────────────────────────
GATEWAY_HOST="${GATEWAY_NODE_HOST:-}"
GATEWAY_PORT="${GATEWAY_NODE_PORT:-9443}"
GATEWAY_ADDR="${GATEWAY_NODE_ADDRESS:-}"
ENROLL_TOKEN="${GATEWAY_NODE_TOKEN:-}"
GATEWAY_CERT_SHA256="${GATEWAY_NODE_CERT_SHA256:-}"
DAEMON_VERSION="${GATEWAY_NODE_DAEMON_VERSION:-latest}"
RELEASES_API_URL="${GATEWAY_RELEASES_API_URL:-https://updates.thesqlabs.com/gateway/releases}"
ARTIFACT_BASE_URL="${GATEWAY_ARTIFACT_BASE_URL:-https://updates.thesqlabs.com/gateway}"
RUN_USER=""
NON_INTERACTIVE=0
NO_LOGO=0
DRY_RUN=0
GUIDE_ACTIVE=0
APT_UPDATED=0
MANUAL_LAUNCH_TIMEOUT_SECONDS="${GATEWAY_MANUAL_LAUNCH_TIMEOUT_SECONDS:-30}"
RESOLVED_DAEMON_VERSION=""
EXISTING_INSTALL=0
EXISTING_VERSION=""
EXISTING_GATEWAY_ADDR=""
EXISTING_ENROLLED=0
MANUAL_FALLBACK_USED=0

# ── Helpers ───────────────────────────────────────────────────────
log()  {
    if [[ "$GUIDE_ACTIVE" -eq 1 && "$NO_LOGO" -eq 0 ]]; then
        echo -e "${BRAND_MINT}│${NC} ${INFO_TAG} INFO ${NC} $*"
    else
        echo -e "${INFO_TAG} INFO ${NC} $*"
    fi
}
warn() { echo -e "${WARN_TAG} WARN ${NC} $*"; }
err()  { echo -e "${ERROR_TAG} ERROR ${NC} $*" >&2; }
ok()   {
    if [[ "$GUIDE_ACTIVE" -eq 1 && "$NO_LOGO" -eq 0 ]]; then
        echo -e "${BRAND_MINT}│${NC} \033[48;2;140;176;132m\033[30m  OK  ${NC} $*"
    else
        echo -e "\033[48;2;140;176;132m\033[30m  OK  ${NC} $*"
    fi
}

die() {
    err "$@"
    echo "" >&2
    echo -e "${ERROR_TAG} ■ ${NC} Installation completed with errors." >&2
    echo "" >&2
    exit 1
}

complete_success() {
    local message="${1:-Installation completed successfully.}"
    if [[ "$GUIDE_ACTIVE" -eq 1 && "$NO_LOGO" -eq 0 ]]; then
        guide_blank
        echo -e "${BRAND_MINT}■${NC} ${BOLD}${message}${NC}"
        echo ""
    else
        echo ""
        echo -e "${BRAND_MINT}■${NC} ${BOLD}${message}${NC}"
        echo ""
    fi
}

complete_incomplete() {
    if [[ "$GUIDE_ACTIVE" -eq 1 && "$NO_LOGO" -eq 0 ]]; then
        guide_blank
        echo -e "${YELLOW}■${NC} ${BOLD}Installation not completed.${NC}"
        echo ""
    else
        echo ""
        echo -e "${YELLOW}■${NC} ${BOLD}Installation not completed.${NC}"
        echo ""
    fi
}

show_logo() {
    echo -e "${BRAND_MINT}╭───────────────────────────────────╮${NC}"
    printf "${BRAND_MINT}│${NC} ${BOLD}${BRAND_MINT}%-33s${NC} ${BRAND_MINT}│${NC}\n" "Gateway Node Setup"
    printf "${BRAND_MINT}│${NC} ${GRAY}%-33s${NC} ${BRAND_MINT}│${NC}\n" "Monitoring daemon installer"
    echo -e "${BRAND_MINT}╰───────────────────────────────────╯${NC}"
    echo ""
}

guide() {
    if [[ "${NO_LOGO:-0}" -eq 1 ]]; then
        echo -e "$*"
    else
        echo -e "${BRAND_MINT}│${NC} $*"
    fi
}

guide_blank() {
    [[ "${NO_LOGO:-0}" -eq 1 ]] || echo -e "${BRAND_MINT}│${NC}"
}
selector_title() { echo -e "${BRAND_MINT}◆${NC} ${GRAY}$*${NC}"; }

guide_start() {
    if [[ "${NO_LOGO:-0}" -eq 1 ]]; then
        echo -e "$*"
    else
        GUIDE_ACTIVE=1
        echo -e "${BRAND_MINT}╭${NC} $*"
    fi
}

guide_end() {
    :
}

summary_start() {
    guide_blank
    if [[ "${NO_LOGO:-0}" -eq 1 ]]; then
        echo -e "${BRAND_MINT}◆${NC} ${BOLD}Configuration Summary${NC}"
    else
        echo -e "${BRAND_MINT}◆${NC} ${BOLD}Configuration Summary${NC}"
    fi
    guide_blank
}

summary_row() {
    guide "  $1"
}

summary_end() {
    guide_blank
}

need_root() {
    if [[ $EUID -ne 0 ]]; then
        die "This script must be run as root (or with sudo)"
    fi
}

detect_os() {
    if [[ -f /etc/os-release ]]; then
        . /etc/os-release
        OS_ID="${ID:-unknown}"
        OS_LIKE="${ID_LIKE:-$OS_ID}"
    else
        OS_ID="unknown"
        OS_LIKE="unknown"
    fi
}

detect_arch() {
    local machine
    machine=$(uname -m)
    case "$machine" in
        x86_64|amd64) ARCH="amd64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        armv7l)        ARCH="armv7" ;;
        *) die "Unsupported architecture: $machine" ;;
    esac
}

command_exists() { command -v "$1" &>/dev/null; }
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
        warn "Could not retire the legacy update guard at ${dropin}; preserving it."
        return 0
    fi
    for marker in \
        "${daemon_binary}.update-state.json" \
        "${daemon_binary}.update-pending" \
        "${daemon_binary}.update-outcome.json"; do
        if legacy_update_marker_is_recognizable "$marker" "$daemon_binary"; then
            rm -f -- "$marker" || warn "Could not retire legacy update marker ${marker}; preserving it."
        fi
    done
    ok "Retired the legacy update guard for ${daemon_binary}; preserved .previous and unknown files."
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
        *) warn "Unknown launcher daemon binary ${daemon_binary}; preserving installed files."; return 0 ;;
    esac

    owner_pid="$(launcher_pid_from_json "${launcher_dir}/owner.json" || true)"
    if launcher_pid_is_live "$owner_pid"; then
        if wait_for_manual_launcher_ready "$launcher_dir" "$daemon_type"; then
            ok "${daemon_name} launcher is already ready (PID ${MANUAL_OWNER_PID}, child PID ${MANUAL_CHILD_PID})."
            echo "Manual launcher log: ${manual_log}"
            echo "Manual mode is not persistent across reboot."
        else
            warn "${daemon_name} has a live launcher owner but no verified ready child; refusing to start a competing launcher."
            echo "Launcher state: ${launcher_dir}"
            echo "Launcher log: ${manual_log}"
        fi
        return 0
    fi

    if ! prepare_manual_launcher_state "$state_dir"; then
        warn "Could not prepare manual launcher state for ${daemon_name}; installed files were preserved."
        echo "Foreground command: $(launcher_foreground_command "$daemon_binary")"
        return 0
    fi
    if ! detach_manual_launcher "$daemon_binary" "$manual_log"; then
        warn "Could not detach ${daemon_name}; installed files and launcher files were preserved."
        echo "Launcher log: ${manual_log}"
        echo "Foreground command: $(launcher_foreground_command "$daemon_binary")"
        return 0
    fi

    if wait_for_manual_launcher_ready "$launcher_dir" "$daemon_type"; then
        ok "${daemon_name} is running in manual mode (launcher PID ${MANUAL_OWNER_PID}, child PID ${MANUAL_CHILD_PID})."
        echo "Launcher PID: ${MANUAL_OWNER_PID}"
        echo "Child PID: ${MANUAL_CHILD_PID}"
        echo "Manual launcher log: ${manual_log}"
        echo "Manual mode is not persistent across reboot."
        return 0
    fi

    warn "Could not verify the detached ${daemon_name} launcher; installed files and launcher files were preserved."
    echo "Launcher state: ${launcher_dir}"
    echo "Launcher log: ${manual_log}"
    echo "Foreground command: $(launcher_foreground_command "$daemon_binary")"
    echo "Manual mode is not persistent across reboot."
    return 0
}

check_dependencies() {
    if command_exists curl; then
        return
    fi
    [[ "$DRY_RUN" -eq 0 ]] || die "curl is required to resolve the daemon release during dry run."
    log "curl not found, installing it..."
    if command_exists apt-get; then
        if [[ "$APT_UPDATED" -eq 0 ]]; then
            apt-get update >>"$LOG_FILE" 2>&1
            APT_UPDATED=1
        fi
        apt-get install -y curl ca-certificates >>"$LOG_FILE" 2>&1
    elif command_exists yum; then
        yum install -y curl ca-certificates >>"$LOG_FILE" 2>&1
    elif command_exists dnf; then
        dnf install -y curl ca-certificates >>"$LOG_FILE" 2>&1
    elif command_exists apk; then
        apk add curl ca-certificates >>"$LOG_FILE" 2>&1
    else
        die "curl is required and no supported package manager was found for automatic installation."
    fi
}

normalize_daemon_version() {
    local version="$1"
    version="${version%-monitoring}"
    if [[ "$version" != v* ]]; then
        version="v${version}"
    fi
    echo "$version"
}

detect_existing_install() {
    local target="/usr/local/bin/monitoring-daemon"
    local config_path="/etc/monitoring-daemon/config.yaml"
    local state_path="/var/lib/monitoring-daemon/state.json"
    local cert_path="/etc/monitoring-daemon/certs/node.pem"
    EXISTING_INSTALL=0
    EXISTING_VERSION=""
    EXISTING_GATEWAY_ADDR=""
    EXISTING_ENROLLED=0

    if [[ -x "$target" ]]; then
        EXISTING_INSTALL=1
        EXISTING_VERSION=$("$target" version 2>/dev/null | awk '{print $2}' || echo "unknown")
    fi

    if [[ -f "$config_path" ]]; then
        EXISTING_GATEWAY_ADDR=$(awk -F'"' '/^[[:space:]]*address:[[:space:]]*"/ {print $2; exit}' "$config_path")
        if [[ -z "$EXISTING_GATEWAY_ADDR" ]]; then
            EXISTING_GATEWAY_ADDR=$(awk '/^[[:space:]]*address:[[:space:]]*/ {print $2; exit}' "$config_path")
        fi
    fi

    if [[ -f "$cert_path" && -f "$state_path" ]]; then
        EXISTING_ENROLLED=1
    fi
}

resolve_download_url() {
    local version="$1"
    local binary_name="monitoring-daemon-linux-${ARCH}"

    if [[ "$version" == "latest" ]]; then
        log "Resolving latest monitoring release tag..."
        local latest_tag
        local releases_json
        releases_json=$(curl -fsSL "${RELEASES_API_URL}?component=monitoring-daemon")
        latest_tag=$(printf '%s' "$releases_json" | grep -o '"tag_name":"v[0-9]*\.[0-9]*\.[0-9]*-monitoring"' | head -1 | cut -d'"' -f4 || true)
        if [[ -z "$latest_tag" || "$latest_tag" == "null" ]]; then
            die "Could not resolve latest monitoring release tag from ${RELEASES_API_URL}"
        fi
        log "Resolved tag: ${latest_tag}"
        RESOLVED_DAEMON_VERSION="${latest_tag%-monitoring}"
        RELEASE_BASE="${ARTIFACT_BASE_URL}/monitoring-daemon/${latest_tag}"
    else
        RESOLVED_DAEMON_VERSION=$(normalize_daemon_version "$version")
        RELEASE_BASE="${ARTIFACT_BASE_URL}/monitoring-daemon/${RESOLVED_DAEMON_VERSION}-monitoring"
    fi

    DOWNLOAD_URL="${RELEASE_BASE}/${binary_name}"
}

prompt_input() {
    local prompt="$1"
    local default="${2:-}"
    local result
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        echo "$default"
        return
    fi
    if [ -e /dev/tty ]; then
        if [ -n "$default" ]; then
            read -r -p "$(echo -e "${BRAND_MINT}◆${NC} ${BRAND_MINT}${prompt} [${default}]: ${NC}")" result < /dev/tty
        else
            read -r -p "$(echo -e "${BRAND_MINT}◆${NC} ${BRAND_MINT}${prompt}: ${NC}")" result < /dev/tty
        fi
    else
        result=""
    fi
    echo "${result:-$default}"
}

prompt_secret() {
    local prompt="$1"
    local result
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        echo ""
        return
    fi
    if [ -e /dev/tty ]; then
        read -rs -p "$(echo -e "${BRAND_MINT}◆${NC} ${BRAND_MINT}${prompt}: ${NC}")" result < /dev/tty
        echo "" >&2
    else
        result=""
    fi
    echo "$result"
}

prompt_yes_no() {
    local prompt="$1"
    local default="${2:-Y}"
    local reply
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        [[ "$default" =~ ^[yY]$ ]]
        return
    fi
    if [ -e /dev/tty ]; then
        if [[ "$default" == "Y" ]]; then
            read -r -p "$(echo -e "${BRAND_MINT}◆${NC} ${BRAND_MINT}${prompt} [Y/n]: ${NC}")" reply < /dev/tty
            reply="${reply:-Y}"
        else
            read -r -p "$(echo -e "${BRAND_MINT}◆${NC} ${BRAND_MINT}${prompt} [y/N]: ${NC}")" reply < /dev/tty
            reply="${reply:-N}"
        fi
    else
        reply="$default"
    fi
    [[ "$reply" =~ ^[yY]$ ]]
}

prompt_choice() {
    local prompt="$1"
    local default="$2"
    shift 2
    local -a options=("$@")
    local reply selected=0 key sequence tty="/dev/tty" tty_device="" supports_arrow_menu=1 index
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        echo "$default"
        return
    fi
    tty_device=$(tty < "$tty" 2>/dev/null || true)
    case "$tty_device" in
        /dev/ttyS*|/dev/hvc*|/dev/xvc*|/dev/console) supports_arrow_menu=0 ;;
    esac
    if [[ "$supports_arrow_menu" -eq 1 && "${#options[@]}" -gt 0 && -r "$tty" && -w "$tty" && "${TERM:-dumb}" != "dumb" ]]; then
        selected=$((default - 1))
        (( selected >= 0 && selected < ${#options[@]} )) || selected=0
        render_menu() {
            local resolved="${1:-0}" rail=" "
            [[ "$resolved" -eq 1 ]] && rail="│"
            for index in "${!options[@]}"; do
                if [[ "$index" -eq "$selected" ]]; then
                    printf "${BRAND_MINT}%s${NC}  ${BRAND_MINT}●${NC} ${BOLD}%d) %s${NC}\033[K\n" "$rail" "$((index + 1))" "${options[$index]}" > "$tty"
                else
                    printf "${BRAND_MINT}%s${NC}  ${GRAY}○${NC} %d) %s\033[K\n" "$rail" "$((index + 1))" "${options[$index]}" > "$tty"
                fi
            done
            [[ "$resolved" -eq 1 ]] || printf "  ${GRAY}Use ↑/↓ and Enter${NC}\033[K\n" > "$tty"
        }
        render_menu
        while true; do
            if ! IFS= read -rsn1 key < "$tty" 2>/dev/null; then
                printf "\033[$(( ${#options[@]} + 1 ))A\r" > "$tty"
                render_menu 1
                printf "\r\033[K" > "$tty"
                break
            fi
            if [[ "$key" == $'\e' ]]; then
                IFS= read -rsn2 sequence < "$tty" 2>/dev/null || sequence=""
                key+="$sequence"
            fi
            case "$key" in
                $'\e[A') selected=$(( (selected + ${#options[@]} - 1) % ${#options[@]} )) ;;
                $'\e[B') selected=$(( (selected + 1) % ${#options[@]} )) ;;
                '')
                    printf "\033[$(( ${#options[@]} + 1 ))A\r" > "$tty"
                    render_menu 1
                    printf "\r\033[K" > "$tty"
                    echo "$((selected + 1))"
                    return
                    ;;
                *) continue ;;
            esac
            printf "\033[$(( ${#options[@]} + 1 ))A\r" > "$tty"
            render_menu
        done
    fi
    if [ -e /dev/tty ]; then
        read -r -p "$(echo -e "${BRAND_MINT}◆${NC} ${BRAND_MINT}${prompt} [${default}]: ${NC}")" reply < /dev/tty 2>/dev/null || reply=""
    else
        reply=""
    fi
    echo "${reply:-$default}"
}

# ── Parse Arguments ───────────────────────────────────────────────
show_help() {
    cat <<'HELP'
Gateway Monitoring Node Setup — installs monitoring-daemon and enrolls with Gateway

Usage:
  setup-monitoring-node.sh [options]

  In interactive mode (default), the script prompts only for missing gateway host,
  enrollment token, and Gateway certificate fingerprint. Port defaults to 9443 and
  daemon version defaults to latest unless supplied.

Options:
  --gateway <addr>         Gateway gRPC address as host:port (e.g. gateway.example.com:9443)
  --host <host>            Gateway hostname or IP (e.g. gateway.example.com)
  --port <port>            Gateway gRPC port (default: 9443)
  --token <token>          Enrollment token from Gateway UI (Admin > Nodes > Add Node)
  --gateway-cert-sha256 <fp>
                           Gateway gRPC TLS leaf fingerprint from the generated setup command
  --version <ver>          Daemon version to install (default: latest)
  --user <user>            Run daemon as this user (default: root)
  --no-logo                Suppress the logo banner
  --dry-run                Validate inputs and show the plan without changing the host
  -y, --yes                Non-interactive mode (no prompts, all values required via flags)
  -h, --help               Show this help

Environment variables:
  GATEWAY_NODE_HOST             Same as --host
  GATEWAY_NODE_PORT             Same as --port (default: 9443)
  GATEWAY_NODE_ADDRESS          Same as --gateway (host:port combined)
  GATEWAY_NODE_TOKEN            Same as --token
  GATEWAY_NODE_CERT_SHA256      Same as --gateway-cert-sha256
  GATEWAY_NODE_DAEMON_VERSION   Same as --version
  GATEWAY_RELEASES_API_URL      Override the Gateway release feed
  GATEWAY_ARTIFACT_BASE_URL     Override the Gateway artifact base URL

Examples:
  # Interactive (prompts for everything):
  sudo bash setup-monitoring-node.sh

  # Partially interactive (pre-fill host, prompt for token):
  sudo bash setup-monitoring-node.sh --host gateway.example.com

  # Fully non-interactive:
  sudo bash setup-monitoring-node.sh -y --host gateway.example.com --token gw_node_abc123 --gateway-cert-sha256 sha256:<HEX>

  # Custom daemon user:
  sudo bash setup-monitoring-node.sh --user monitor --gateway gw:9443 --token TOKEN --gateway-cert-sha256 sha256:<HEX>
HELP
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --gateway)        GATEWAY_ADDR="$2"; shift 2 ;;
        --host)           GATEWAY_HOST="$2"; shift 2 ;;
        --port)           GATEWAY_PORT="$2"; shift 2 ;;
        --token)          ENROLL_TOKEN="$2"; shift 2 ;;
        --gateway-cert-sha256) GATEWAY_CERT_SHA256="$2"; shift 2 ;;
        --version)        DAEMON_VERSION="$2"; shift 2 ;;
        --user)           RUN_USER="$2"; shift 2 ;;
        --no-logo)        NO_LOGO=1; shift ;;
        --dry-run)        DRY_RUN=1; shift ;;
        -y|--yes)         NON_INTERACTIVE=1; NO_LOGO=1; shift ;;
        -h|--help)        show_help ;;
        *) die "Unknown option: $1. Use --help for usage." ;;
    esac
done

# Resolve GATEWAY_ADDR from --host/--port if --gateway not given
if [[ -n "$GATEWAY_HOST" && -z "$GATEWAY_ADDR" ]]; then
    GATEWAY_ADDR="${GATEWAY_HOST}:${GATEWAY_PORT}"
fi
# If --gateway was given, extract host/port for display
if [[ -n "$GATEWAY_ADDR" && -z "$GATEWAY_HOST" ]]; then
    GATEWAY_HOST="${GATEWAY_ADDR%%:*}"
    GATEWAY_PORT="${GATEWAY_ADDR##*:}"
    if [[ "$GATEWAY_PORT" == "$GATEWAY_HOST" ]]; then
        GATEWAY_PORT="9443"
        GATEWAY_ADDR="${GATEWAY_HOST}:${GATEWAY_PORT}"
    fi
fi

# ── Validate ──────────────────────────────────────────────────────
need_root
if [[ "$DRY_RUN" -eq 0 ]]; then
    LOG_FILE=$(mktemp /tmp/gateway_monitoring_setup.XXXXXX) || die "Could not create installer log file"
    chmod 600 "$LOG_FILE" || die "Could not secure installer log file"
fi
detect_os
detect_arch
check_dependencies
detect_existing_install

if [[ -z "$GATEWAY_ADDR" && -n "$EXISTING_GATEWAY_ADDR" ]]; then
    GATEWAY_ADDR="$EXISTING_GATEWAY_ADDR"
    GATEWAY_HOST="${GATEWAY_ADDR%%:*}"
    GATEWAY_PORT="${GATEWAY_ADDR##*:}"
    if [[ "$GATEWAY_PORT" == "$GATEWAY_HOST" ]]; then
        GATEWAY_PORT="9443"
        GATEWAY_ADDR="${GATEWAY_HOST}:${GATEWAY_PORT}"
    fi
fi

# ── Logo ──────────────────────────────────────────────────────────
if [[ "$NO_LOGO" -eq 0 ]]; then
    if [ -t 1 ] && command_exists clear; then
        clear
    fi
    show_logo
fi

# ── Interactive configuration ─────────────────────────────────────
if [[ "$NON_INTERACTIVE" -eq 0 ]]; then
    guide_start "${GRAY}This script will:${NC}"
    guide "${GRAY}  1. Download and install the monitoring-daemon binary${NC}"
    guide "${GRAY}  2. Enroll this node with your Gateway server${NC}"
    guide "${GRAY}  3. Start the daemon as a systemd service${NC}"
    guide "${GRAY}  No nginx or other software is required.${NC}"
    guide_blank

    if [[ "$EXISTING_ENROLLED" -eq 1 && -n "$EXISTING_GATEWAY_ADDR" && -z "$ENROLL_TOKEN" ]]; then
        log "Existing enrolled monitoring node detected — reusing current gateway configuration"
    else
        # Gateway host
        if [[ -z "$GATEWAY_HOST" ]]; then
            GATEWAY_HOST=$(prompt_input "Gateway hostname or IP" "")
            [[ -z "$GATEWAY_HOST" ]] && die "Gateway hostname is required"
        else
            guide "${GRAY}Gateway host: ${BRAND_MINT}${GATEWAY_HOST}${NC}"
        fi

        GATEWAY_ADDR="${GATEWAY_HOST}:${GATEWAY_PORT}"

        guide_blank

        # Enrollment token
        if [[ -z "$ENROLL_TOKEN" ]]; then
            ENROLL_TOKEN=$(prompt_secret "Enrollment token (from Admin > Nodes)")
            [[ -z "$ENROLL_TOKEN" ]] && die "Enrollment token is required"
        else
            guide "${GRAY}Token: ${ENROLL_TOKEN:0:12}...${ENROLL_TOKEN: -4}${NC}"
        fi

        if [[ -z "$GATEWAY_CERT_SHA256" ]]; then
            GATEWAY_CERT_SHA256=$(prompt_input "Gateway certificate SHA-256 fingerprint" "")
            [[ -z "$GATEWAY_CERT_SHA256" ]] && die "Gateway certificate SHA-256 fingerprint is required"
        else
            guide "${GRAY}Gateway cert: ${GATEWAY_CERT_SHA256}${NC}"
        fi

        guide_blank
    fi

    guide_blank

    # User selection
    if [[ -z "$RUN_USER" ]]; then
        selector_title "Run daemon as:"
        user_choice=$(prompt_choice "Choose" "1" "root  [default]" "Current user ($(logname 2>/dev/null || echo "$SUDO_USER"))" "Custom user")
        case "$user_choice" in
            1|root)   RUN_USER="root" ;;
            2)        RUN_USER="$(logname 2>/dev/null || echo "${SUDO_USER:-root}")" ;;
            3)        RUN_USER=$(prompt_input "Username" ""); [[ -z "$RUN_USER" ]] && die "Username is required" ;;
            *)        RUN_USER="root" ;;
        esac
        guide "${GRAY}Selected: ${NC}${RUN_USER}"
    fi
    guide_end
else
    # Non-interactive: validate required fields
    if [[ -z "$GATEWAY_ADDR" && "$EXISTING_ENROLLED" -eq 0 ]]; then
        die "--gateway or --host is required in non-interactive mode"
    fi
    if [[ -z "$ENROLL_TOKEN" && "$EXISTING_ENROLLED" -eq 0 ]]; then
        die "--token is required in non-interactive mode"
    fi
    if [[ -z "$GATEWAY_CERT_SHA256" && "$EXISTING_ENROLLED" -eq 0 ]]; then
        die "--gateway-cert-sha256 is required in non-interactive mode"
    fi
    [[ -z "$RUN_USER" ]] && RUN_USER="root"
fi

# ── Resolve run user/group ────────────────────────────────────────
RUN_GROUP=""
if [[ "$RUN_USER" == "root" ]]; then
    RUN_GROUP="root"
else
    if ! id "$RUN_USER" &>/dev/null; then
        die "User '$RUN_USER' does not exist. Create it first or choose a different user."
    fi
    RUN_GROUP=$(id -gn "$RUN_USER" 2>/dev/null)
fi

resolve_download_url "$DAEMON_VERSION"
detect_existing_install

# ── Confirmation ──────────────────────────────────────────────────
if [[ "$EXISTING_INSTALL" -eq 1 ]]; then
    log "Existing monitoring-daemon installation detected"
    echo -e "  ${GRAY}Current version: ${BRAND_MINT}${EXISTING_VERSION}${NC}"
    echo -e "  ${GRAY}Version to install: ${BRAND_MINT}${RESOLVED_DAEMON_VERSION}${NC}"
    echo ""
fi

summary_start
summary_row "Gateway:     ${GATEWAY_ADDR}"
if [[ -n "$ENROLL_TOKEN" ]]; then
    summary_row "Token:       ${ENROLL_TOKEN:0:12}..."
else
    summary_row "Token:       existing enrollment"
fi
if [[ -n "$GATEWAY_CERT_SHA256" ]]; then
    summary_row "Cert SHA256: ${GATEWAY_CERT_SHA256}"
else
    summary_row "Cert SHA256: existing enrollment"
fi
summary_row "Arch:        ${ARCH}"
summary_row "OS:          ${OS_ID}"
summary_row "Install ver: ${RESOLVED_DAEMON_VERSION}"
summary_row "Current ver: $([[ "$EXISTING_INSTALL" -eq 1 ]] && echo "${EXISTING_VERSION}" || echo "not installed")"
summary_row "Mode:        $([[ "$EXISTING_INSTALL" -eq 1 ]] && echo "update" || echo "fresh install")"
summary_row "Run as:      ${RUN_USER}:${RUN_GROUP}"
summary_row "Updates:     ${ARTIFACT_BASE_URL}"
summary_end

if ! prompt_yes_no "Proceed with installation?" "Y"; then
    complete_incomplete
    exit 0
fi
guide_blank

dry_run_preview() {
    log "Creating required directories..."
    ok "Directories created (dry run)"
    log "Downloading monitoring-daemon..."
    log "Verifying checksum..."
    ok "Checksum verified (dry run)"
    ok "monitoring-daemon installed (${RESOLVED_DAEMON_VERSION}; dry run)"
    log "Writing config and enrolling with Gateway..."
    ok "Config written to /etc/monitoring-daemon/config.yaml (dry run)"
    log "Enabling and starting monitoring-daemon..."
    ok "monitoring-daemon is running (dry run)"
    complete_success "Dry run completed successfully — no host changes were made."
}

if [[ "$DRY_RUN" -eq 1 ]]; then
    dry_run_preview
    exit 0
fi

# ── Step 1: Create directories ────────────────────────────────────
create_directories() {
    log "Creating required directories..."
    mkdir -p /etc/monitoring-daemon/certs
    mkdir -p /var/lib/monitoring-daemon

    if [[ "$RUN_USER" != "root" ]]; then
        chown -R "${RUN_USER}:${RUN_GROUP}" /etc/monitoring-daemon
        chown -R "${RUN_USER}:${RUN_GROUP}" /var/lib/monitoring-daemon
    fi

    ok "Directories created"
}

# ── Step 2: Download monitoring-daemon binary ─────────────────────

verify_checksum() {
    local file="$1"
    local binary_name="$2"

    log "Verifying checksum..."
    local checksums_file="/tmp/gateway_checksums.txt"
    if curl -fsSL "${RELEASE_BASE}/checksums.txt" -o "$checksums_file" >> "$LOG_FILE" 2>&1; then
        local expected actual
        expected=$(grep "$binary_name" "$checksums_file" | awk '{print $1}')
        actual=$(sha256sum "$file" | awk '{print $1}')
        rm -f "$checksums_file"

        if [[ -z "$expected" ]]; then
            die "No checksum found for ${binary_name} in checksums.txt"
        fi

        if [[ "$expected" != "$actual" ]]; then
            die "Checksum verification failed! Expected: ${expected}, Got: ${actual}"
        fi
        ok "Checksum verified"
    else
        rm -f "$checksums_file"
        die "Could not download checksums.txt for checksum verification"
    fi
}

install_daemon() {
    local target="/usr/local/bin/monitoring-daemon"
    local binary_name="monitoring-daemon-linux-${ARCH}"

    if [[ -f "$target" ]]; then
        local existing_ver
        existing_ver=$("$target" version 2>/dev/null | awk '{print $2}' || echo "unknown")
        if [[ "$RESOLVED_DAEMON_VERSION" == "$existing_ver" ]]; then
            ok "monitoring-daemon already installed (${existing_ver})"
            return 0
        fi
        log "Upgrading monitoring-daemon from ${existing_ver} to ${RESOLVED_DAEMON_VERSION}..."
        # Backup existing binary
        local backup="${target}.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$target" "$backup"
        ok "Backed up existing binary to ${backup}"
    else
        log "Downloading monitoring-daemon..."
    fi

    if curl -fsSL "$DOWNLOAD_URL" -o "${target}.tmp" >> "$LOG_FILE" 2>&1; then
        verify_checksum "${target}.tmp" "$binary_name"
        mv "${target}.tmp" "$target"
        chmod +x "$target"
        local ver
        ver=$("$target" version 2>/dev/null | awk '{print $2}' || echo "unknown")
        ok "monitoring-daemon installed (${ver})"
    else
        rm -f "${target}.tmp"
        die "Failed to download monitoring-daemon ${RESOLVED_DAEMON_VERSION} from releases"
    fi
}

# ── Step 3: Install and enroll ────────────────────────────────────
enroll_daemon() {
    local target="/usr/local/bin/monitoring-daemon"

    # Check if already enrolled (certs exist)
    if [[ -f /etc/monitoring-daemon/certs/node.pem && -f /var/lib/monitoring-daemon/state.json ]]; then
        ok "Node already enrolled — skipping enrollment"
        return 0
    fi

    log "Writing config and enrolling with Gateway..."
    if ! "$target" install --gateway "$GATEWAY_ADDR" --token "$ENROLL_TOKEN" --gateway-cert-sha256 "$GATEWAY_CERT_SHA256" >> "$LOG_FILE" 2>&1; then
        die "Failed to enroll monitoring-daemon. Check ${LOG_FILE} for details."
    fi
    ok "Config written to /etc/monitoring-daemon/config.yaml"
}

# ── Step 4: Start the daemon ──────────────────────────────────────
start_daemon() {
    retire_legacy_update_guard "monitoring-daemon" "/usr/local/bin/monitoring-daemon"
    log "Enabling and starting monitoring-daemon..."

    if has_systemd; then
        if ! cat > /etc/systemd/system/monitoring-daemon.service <<UNIT
[Unit]
Description=Gateway Monitoring Daemon
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
ExecStart=/usr/local/bin/monitoring-daemon run
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
        then
            warn "Could not write the monitoring-daemon systemd unit; using manual mode."
            manual_launcher_fallback "monitoring-daemon" "/usr/local/bin/monitoring-daemon" "/var/lib/monitoring-daemon"
            return 0
        fi

        if ! systemctl daemon-reload >> "$LOG_FILE" 2>&1; then
            warn "systemd daemon-reload failed; using manual mode."
            manual_launcher_fallback "monitoring-daemon" "/usr/local/bin/monitoring-daemon" "/var/lib/monitoring-daemon"
            return 0
        fi
        if ! systemctl enable monitoring-daemon >> "$LOG_FILE" 2>&1; then
            warn "Could not enable monitoring-daemon; using manual mode."
            manual_launcher_fallback "monitoring-daemon" "/usr/local/bin/monitoring-daemon" "/var/lib/monitoring-daemon"
            return 0
        fi
        if ! systemctl restart monitoring-daemon >> "$LOG_FILE" 2>&1; then
            warn "Could not start or restart monitoring-daemon; using manual mode."
            manual_launcher_fallback "monitoring-daemon" "/usr/local/bin/monitoring-daemon" "/var/lib/monitoring-daemon"
            return 0
        fi
        sleep 2

        if systemctl is-active --quiet monitoring-daemon; then
            ok "monitoring-daemon is running"
        else
            warn "monitoring-daemon is not active; using manual mode."
            manual_launcher_fallback "monitoring-daemon" "/usr/local/bin/monitoring-daemon" "/var/lib/monitoring-daemon"
        fi
    elif has_openrc; then
        if ! cat > /etc/init.d/monitoring-daemon <<UNIT
#!/sbin/openrc-run
name="Gateway Monitoring Daemon"
description="Gateway Monitoring Daemon"
command="/usr/local/bin/monitoring-daemon"
command_args="run"
command_user="${RUN_USER}:${RUN_GROUP}"
pidfile="/run/\${RC_SVCNAME}.pid"
supervisor="supervise-daemon"
respawn_delay=5
output_log="/var/log/monitoring-daemon.log"
error_log="/var/log/monitoring-daemon.err"

depend() {
    need net
}
UNIT
        then
            warn "Could not write the monitoring-daemon OpenRC service; using manual mode."
            manual_launcher_fallback "monitoring-daemon" "/usr/local/bin/monitoring-daemon" "/var/lib/monitoring-daemon"
            return 0
        fi
        if ! chmod +x /etc/init.d/monitoring-daemon; then
            warn "Could not make the monitoring-daemon OpenRC service executable; using manual mode."
            manual_launcher_fallback "monitoring-daemon" "/usr/local/bin/monitoring-daemon" "/var/lib/monitoring-daemon"
            return 0
        fi
        if ! rc-update add monitoring-daemon default >> "$LOG_FILE" 2>&1; then
            warn "Could not enable monitoring-daemon in OpenRC; using manual mode."
            manual_launcher_fallback "monitoring-daemon" "/usr/local/bin/monitoring-daemon" "/var/lib/monitoring-daemon"
            return 0
        fi
        if ! rc-service monitoring-daemon restart >> "$LOG_FILE" 2>&1; then
            if ! rc-service monitoring-daemon start >> "$LOG_FILE" 2>&1; then
                warn "Could not start monitoring-daemon in OpenRC; using manual mode."
                manual_launcher_fallback "monitoring-daemon" "/usr/local/bin/monitoring-daemon" "/var/lib/monitoring-daemon"
                return 0
            fi
        fi
        sleep 2

        if rc-service monitoring-daemon status >> "$LOG_FILE" 2>&1; then
            ok "monitoring-daemon is running"
        else
            warn "monitoring-daemon is not active in OpenRC; using manual mode."
            manual_launcher_fallback "monitoring-daemon" "/usr/local/bin/monitoring-daemon" "/var/lib/monitoring-daemon"
        fi
    else
        warn "No supported service manager found; using manual mode."
        manual_launcher_fallback "monitoring-daemon" "/usr/local/bin/monitoring-daemon" "/var/lib/monitoring-daemon"
    fi
}

# ── Run ───────────────────────────────────────────────────────────
create_directories
install_daemon
enroll_daemon
start_daemon

echo ""
echo ""
echo -e "  The node should appear as ${GREEN}online${NC} in Gateway within a few seconds."
if [[ "$MANUAL_FALLBACK_USED" -eq 1 ]]; then
    echo -e "  Manual mode is not persistent across reboot."
elif has_systemd; then
    echo -e "  Check status:  ${BRAND_MINT}systemctl status monitoring-daemon${NC}"
    echo -e "  View logs:     ${BRAND_MINT}journalctl -u monitoring-daemon -f${NC}"
elif has_openrc; then
    echo -e "  Check status:  ${BRAND_MINT}rc-service monitoring-daemon status${NC}"
    echo -e "  View logs:     ${BRAND_MINT}tail -f /var/log/monitoring-daemon.log${NC}"
else
    echo -e "  Start daemon:  ${BRAND_MINT}monitoring-daemon run${NC}"
fi
complete_success
