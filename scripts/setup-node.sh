#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# ── Gateway Nginx Node Setup ─────────────────────────────────────────
# Installs nginx + nginx-daemon on a host and enrolls it with the Gateway.
#
# Usage:
#   curl -sSL https://gitlab.wiolett.net/wiolett/gateway/-/raw/main/scripts/setup-node.sh | \
#     bash -s -- --gateway gateway.example.com:9443 --token <ENROLLMENT_TOKEN> --gateway-cert-sha256 sha256:<HEX>
#
# Or download and run:
#   bash setup-node.sh --gateway gateway.example.com:9443 --token <TOKEN> --gateway-cert-sha256 sha256:<HEX>
# ──────────────────────────────────────────────────────────────────────

LOG_FILE="/tmp/gateway_node_setup.log"

# ── Colors ───────────────────────────────────────────────────────────
BRAND_MINT='\033[38;2;140;176;132m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
GRAY='\033[0;90m'
NC='\033[0m'
BOLD='\033[1m'
INFO_TAG='\033[48;2;74;74;74m\033[38;2;185;185;185m'
WARN_TAG='\033[48;2;112;97;48m\033[38;2;244;234;198m'
ERROR_TAG='\033[48;2;96;61;43m\033[38;2;245;221;202m'
SUCCESS_TAG='\033[42m\033[97m'
TITLE_TAG='\033[48;2;140;176;132m\033[30m'

# ── Defaults ─────────────────────────────────────────────────────────
GATEWAY_HOST="${GATEWAY_NODE_HOST:-}"
GATEWAY_PORT="${GATEWAY_NODE_PORT:-9443}"
GATEWAY_ADDR="${GATEWAY_NODE_ADDRESS:-}"
ENROLL_TOKEN="${GATEWAY_NODE_TOKEN:-}"
GATEWAY_CERT_SHA256="${GATEWAY_NODE_CERT_SHA256:-}"
DAEMON_VERSION="${GATEWAY_NODE_DAEMON_VERSION:-latest}"
SKIP_NGINX="${GATEWAY_NODE_SKIP_NGINX:-0}"
GITLAB_URL="${GATEWAY_GITLAB_URL:-https://gitlab.wiolett.net}"
GITLAB_PROJECT="${GATEWAY_GITLAB_PROJECT:-wiolett/gateway}"
RUN_USER=""
NGINX_MODE="${GATEWAY_NODE_NGINX_MODE:-}"
NON_INTERACTIVE=0
NO_LOGO=0
DRY_RUN=0
GUIDE_ACTIVE=0
STUB_STATUS_URL="http://127.0.0.1/nginx_status"
INTEGRATED_STUB_STATUS_PORT="8081"
NGINX_SITES_DIR="/etc/nginx/gateway/conf.d"
NGINX_HTPASSWD_DIR="/etc/nginx/gateway/htpasswd"
NGINX_MIN_VERSION="1.25.1"
RESOLVED_DAEMON_VERSION=""
EXISTING_INSTALL=0
EXISTING_VERSION=""
EXISTING_GATEWAY_ADDR=""
EXISTING_ENROLLED=0

# ── Helpers ──────────────────────────────────────────────────────────
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

show_header() {
    local title="$1"
    local subtitle="$2"

    echo -e "${BRAND_MINT}╭───────────────────────────────────╮${NC}"
    printf "${BRAND_MINT}│${NC} ${BOLD}${BRAND_MINT}%-33s${NC} ${BRAND_MINT}│${NC}\n" "$title"
    printf "${BRAND_MINT}│${NC} ${GRAY}%-33s${NC} ${BRAND_MINT}│${NC}\n" "$subtitle"
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
    local reply selected=0 key sequence tty="/dev/tty" index
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        echo "$default"
        return
    fi
    if [[ "${#options[@]}" -gt 0 && -r "$tty" && -w "$tty" && "${TERM:-dumb}" != "dumb" ]]; then
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
            IFS= read -rsn1 key < "$tty" || { echo "$default"; return; }
            if [[ "$key" == $'\e' ]]; then
                IFS= read -rsn2 sequence < "$tty" || sequence=""
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
        read -r -p "$(echo -e "${BRAND_MINT}◆${NC} ${BRAND_MINT}${prompt} [${default}]: ${NC}")" reply < /dev/tty
    else
        reply=""
    fi
    echo "${reply:-$default}"
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
has_existing_nginx_config() {
    [[ -s /etc/nginx/nginx.conf || -s /usr/local/etc/nginx/nginx.conf || -s /usr/local/nginx/conf/nginx.conf ]]
}
has_systemd() { command_exists systemctl; }
has_openrc() { command_exists rc-service && command_exists rc-update; }

check_dependencies() {
    if ! command_exists curl; then
        die "curl is required but not found. Install it and retry."
    fi
}

build_gitlab_api() {
    local encoded_project="${GITLAB_PROJECT//\//%2F}"
    GITLAB_API="${GITLAB_URL}/api/v4/projects/${encoded_project}"
}

normalize_daemon_version() {
    local version="$1"
    version="${version%-nginx}"
    if [[ "$version" != v* ]]; then
        version="v${version}"
    fi
    echo "$version"
}

detect_existing_install() {
    local target="/usr/local/bin/nginx-daemon"
    local config_path="/etc/nginx-daemon/config.yaml"
    local state_path="/var/lib/nginx-daemon/state.json"
    local cert_path="/etc/nginx-daemon/certs/node.pem"
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
    local binary_name="nginx-daemon-linux-${ARCH}"

    if [[ "$version" == "latest" ]]; then
        log "Resolving latest nginx release tag..."
        local latest_tag
        local releases_json
        releases_json=$(curl -fsSL "${GITLAB_API}/releases")
        latest_tag=$(printf '%s' "$releases_json" | grep -o '"tag_name":"v[0-9]*\.[0-9]*\.[0-9]*-nginx"' | head -1 | cut -d'"' -f4 || true)
        if [[ -z "$latest_tag" || "$latest_tag" == "null" ]]; then
            die "Could not resolve latest nginx release tag from ${GITLAB_API}/releases"
        fi
        log "Resolved tag: ${latest_tag}"
        RESOLVED_DAEMON_VERSION="${latest_tag%-nginx}"
        RELEASE_BASE="${GITLAB_API}/releases/${latest_tag}/downloads"
    else
        RESOLVED_DAEMON_VERSION=$(normalize_daemon_version "$version")
        RELEASE_BASE="${GITLAB_API}/releases/${RESOLVED_DAEMON_VERSION}-nginx/downloads"
    fi

    DOWNLOAD_URL="${RELEASE_BASE}/${binary_name}"
}

# ── Parse Arguments ──────────────────────────────────────────────────
show_help() {
    cat <<'HELP'
Gateway Node Setup — installs nginx + nginx-daemon and enrolls with Gateway

Usage:
  setup-node.sh [options]

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
  --skip-nginx             Reuse installed nginx (must be 1.25.1 or newer)
  --nginx-mode <mode>      Nginx config mode: managed or integrate
  --gitlab-url <url>       GitLab instance URL (default: https://gitlab.wiolett.net)
  --gitlab-project <proj>  GitLab project path (default: wiolett/gateway)
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
  GATEWAY_NODE_SKIP_NGINX       Set to 1 to skip nginx install
  GATEWAY_NODE_NGINX_MODE       Same as --nginx-mode
  GATEWAY_GITLAB_URL            Same as --gitlab-url
  GATEWAY_GITLAB_PROJECT        Same as --gitlab-project

Examples:
  # Interactive (prompts for everything):
  sudo bash setup-node.sh

  # Partially interactive (pre-fill host, prompt for token):
  sudo bash setup-node.sh --host gateway.example.com

  # Fully non-interactive:
  sudo bash setup-node.sh -y --host gateway.example.com --token gw_node_abc123 --gateway-cert-sha256 sha256:<HEX>

  # Legacy format (host:port combined):
  sudo bash setup-node.sh --gateway gateway.example.com:9443 --token gw_node_abc123 --gateway-cert-sha256 sha256:<HEX>

  # Custom GitLab and user:
  sudo bash setup-node.sh --gitlab-url https://git.example.com --user www-data --gateway gw:9443 --token TOKEN --gateway-cert-sha256 sha256:<HEX>
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
        --skip-nginx)     SKIP_NGINX=1; shift ;;
        --nginx-mode)     NGINX_MODE="$2"; shift 2 ;;
        --gitlab-url)     GITLAB_URL="$2"; shift 2 ;;
        --gitlab-project) GITLAB_PROJECT="$2"; shift 2 ;;
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
    # If no port in the address, use default
    if [[ "$GATEWAY_PORT" == "$GATEWAY_HOST" ]]; then
        GATEWAY_PORT="9443"
        GATEWAY_ADDR="${GATEWAY_HOST}:${GATEWAY_PORT}"
    fi
fi

# ── Validate ─────────────────────────────────────────────────────────
need_root
detect_os
detect_arch
check_dependencies
build_gitlab_api
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

if [[ "$DRY_RUN" -eq 0 ]]; then
    : > "$LOG_FILE"
fi

# ── Header ───────────────────────────────────────────────────────────
if [[ "$NO_LOGO" -eq 0 ]]; then
    if [ -t 1 ] && command -v clear &>/dev/null; then
        clear
    fi
    show_header "Gateway Node Setup" "Nginx daemon installer"
fi

# ── Interactive configuration ────────────────────────────────────────
if [[ "$NON_INTERACTIVE" -eq 0 ]]; then
    guide_start "${GRAY}This script will:${NC}"
    guide "${GRAY}  1. Install nginx (if not present)${NC}"
    guide "${GRAY}  2. Download and install the nginx-daemon binary${NC}"
    guide "${GRAY}  3. Enroll this node with your Gateway server${NC}"
    guide "${GRAY}  4. Start the daemon as a systemd service${NC}"
    guide_blank

    if [[ "$EXISTING_ENROLLED" -eq 1 && -n "$EXISTING_GATEWAY_ADDR" && -z "$ENROLL_TOKEN" ]]; then
        log "Existing enrolled nginx node detected — reusing current gateway configuration"
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
        [[ -z "$NGINX_MODE" ]] && has_existing_nginx_config && guide_blank
    fi

    if [[ -z "$NGINX_MODE" ]] && has_existing_nginx_config; then
        selector_title "Nginx configuration mode:"
        nginx_mode_choice=$(prompt_choice "Choose" "2" "Managed    — installer owns the base nginx config" "Integrate  — keep existing nginx.conf and add Gateway includes")
        case "$nginx_mode_choice" in
            1|managed)   NGINX_MODE="managed" ;;
            2|integrate) NGINX_MODE="integrate" ;;
            *)           NGINX_MODE="integrate" ;;
        esac
        guide "${GRAY}Selected: ${NC}${NGINX_MODE}"
    elif [[ -z "$NGINX_MODE" ]]; then
        NGINX_MODE="managed"
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
    # Default user to root in non-interactive mode
    [[ -z "$RUN_USER" ]] && RUN_USER="root"
    if [[ -z "$NGINX_MODE" ]]; then
        if has_existing_nginx_config; then
            NGINX_MODE="integrate"
        else
            NGINX_MODE="managed"
        fi
    fi
fi

case "$NGINX_MODE" in
    managed|integrate) ;;
    *) die "Unknown nginx mode: $NGINX_MODE. Use: managed or integrate" ;;
esac

# ── Resolve run user/group ───────────────────────────────────────────
RUN_GROUP=""
if [[ "$RUN_USER" == "root" ]]; then
    RUN_GROUP="root"
else
    # Verify user exists
    if ! id "$RUN_USER" &>/dev/null; then
        die "User '$RUN_USER' does not exist. Create it first or choose a different user."
    fi
    RUN_GROUP=$(id -gn "$RUN_USER" 2>/dev/null)
fi

resolve_download_url "$DAEMON_VERSION"
detect_existing_install

# ── Confirmation ─────────────────────────────────────────────────────
if [[ "$EXISTING_INSTALL" -eq 1 ]]; then
    log "Existing nginx-daemon installation detected"
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
summary_row "Skip nginx:  $([ "$SKIP_NGINX" -eq 1 ] && echo "yes" || echo "no")"
summary_row "Nginx min:   ${NGINX_MIN_VERSION}"
summary_row "Nginx mode:  ${NGINX_MODE}"
summary_row "GitLab:      ${GITLAB_URL}"
summary_end

if ! prompt_yes_no "Proceed with installation?" "Y"; then
    complete_incomplete
    exit 0
fi
guide_blank

dry_run_preview() {
    if command_exists nginx; then
        ok "nginx already installed ($(nginx_version))"
    else
        log "Adding nginx.org stable repository..."
        log "Installing nginx..."
        ok "nginx installed (dry run)"
    fi
    log "Creating required directories..."
    ok "Directories created (dry run)"
    log "Configuring nginx (${NGINX_MODE} mode)..."
    ok "nginx configuration updated (${NGINX_MODE} mode; dry run)"
    log "Downloading nginx-daemon..."
    log "Verifying checksum..."
    ok "Checksum verified (dry run)"
    ok "nginx-daemon installed (${RESOLVED_DAEMON_VERSION}; dry run)"
    log "Writing config and enrolling with Gateway..."
    ok "Config written to /etc/nginx-daemon/config.yaml (dry run)"
    log "Enabling and starting nginx-daemon..."
    ok "nginx-daemon is running (dry run)"
    complete_success "Dry run completed successfully — no host changes were made."
}

if [[ "$DRY_RUN" -eq 1 ]]; then
    dry_run_preview
    exit 0
fi

# ── Step 1: Install nginx ────────────────────────────────────────────
install_nginx_stable_repo() {
    log "Adding nginx.org stable repository..."
    case "$OS_LIKE" in
        *debian*|*ubuntu*)
            apt-get install -y -qq gnupg2 ca-certificates lsb-release >> "$LOG_FILE" 2>&1
            curl -fsSL https://nginx.org/keys/nginx_signing.key | gpg --dearmor -o /usr/share/keyrings/nginx-archive-keyring.gpg 2>> "$LOG_FILE"
            echo "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/$(. /etc/os-release && echo "$ID") $(lsb_release -cs) nginx" \
                > /etc/apt/sources.list.d/nginx.list
            apt-get update -qq >> "$LOG_FILE" 2>&1
            ;;
        *rhel*|*fedora*|*centos*)
            cat > /etc/yum.repos.d/nginx.repo <<'REPO'
[nginx-stable]
name=nginx stable repo
baseurl=http://nginx.org/packages/centos/$releasever/$basearch/
gpgcheck=1
enabled=1
gpgkey=https://nginx.org/keys/nginx_signing.key
module_hotfixes=true
REPO
            ;;
        *)
            warn "Cannot add nginx.org repo for ${OS_ID}. Falling back to system package."
            ;;
    esac
}

nginx_version() {
    nginx -v 2>&1 | sed -n 's#.*nginx/\([0-9.]*\).*#\1#p' | head -n 1
}

nginx_version_at_least() {
    local actual="$1"
    local required="$2"
    local actual_major actual_minor actual_patch required_major required_minor required_patch

    [[ "$actual" =~ ^[0-9]+(\.[0-9]+){1,2}$ ]] || return 1
    IFS='.' read -r actual_major actual_minor actual_patch <<< "$actual"
    IFS='.' read -r required_major required_minor required_patch <<< "$required"
    actual_patch="${actual_patch:-0}"
    required_patch="${required_patch:-0}"

    (( 10#$actual_major > 10#$required_major )) ||
        (( 10#$actual_major == 10#$required_major && 10#$actual_minor > 10#$required_minor )) ||
        (( 10#$actual_major == 10#$required_major && 10#$actual_minor == 10#$required_minor && 10#$actual_patch >= 10#$required_patch ))
}

install_nginx_package() {
    local upgrade_existing="${1:-0}"
    log "$([[ "$upgrade_existing" -eq 1 ]] && echo "Upgrading nginx..." || echo "Installing nginx...")"
    case "$OS_LIKE" in
        *debian*|*ubuntu*)
            apt-get update -qq >> "$LOG_FILE" 2>&1
            apt-get install -y -qq nginx >> "$LOG_FILE" 2>&1
            ;;
        *rhel*|*fedora*|*centos*)
            if command_exists dnf; then
                if [[ "$upgrade_existing" -eq 1 ]]; then
                    dnf upgrade -y -q nginx >> "$LOG_FILE" 2>&1
                else
                    dnf install -y -q nginx >> "$LOG_FILE" 2>&1
                fi
            else
                if [[ "$upgrade_existing" -eq 1 ]]; then
                    yum update -y -q nginx >> "$LOG_FILE" 2>&1
                else
                    yum install -y -q nginx >> "$LOG_FILE" 2>&1
                fi
            fi
            ;;
        *arch*)
            pacman -Sy --noconfirm nginx >> "$LOG_FILE" 2>&1
            ;;
        *alpine*)
            apk add --no-cache --upgrade nginx >> "$LOG_FILE" 2>&1
            ;;
        *)
            die "Cannot auto-install nginx on ${OS_ID}. Install nginx ${NGINX_MIN_VERSION} or newer and rerun."
            ;;
    esac
}

start_nginx_service() {
    if has_systemd; then
        systemctl enable nginx >> "$LOG_FILE" 2>&1 || true
        systemctl start nginx >> "$LOG_FILE" 2>&1 || true
    elif has_openrc; then
        rc-update add nginx default >> "$LOG_FILE" 2>&1 || true
        rc-service nginx start >> "$LOG_FILE" 2>&1 || true
    elif command_exists service; then
        service nginx start >> "$LOG_FILE" 2>&1 || true
    fi
}

install_nginx() {
    if command_exists nginx; then
        local ver
        ver=$(nginx_version)
        ver="${ver:-unknown}"
        if nginx_version_at_least "$ver" "$NGINX_MIN_VERSION"; then
            ok "nginx already installed (${ver})"
            return 0
        fi

        [[ "$SKIP_NGINX" -eq 0 ]] ||
            die "--skip-nginx requires nginx ${NGINX_MIN_VERSION}+; found ${ver}."

        warn "nginx ${ver} is below the required ${NGINX_MIN_VERSION} for Gateway HTTP/2 support."
        if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
            die "nginx ${NGINX_MIN_VERSION}+ is required. Re-run interactively to approve the stable nginx upgrade."
        elif ! prompt_yes_no "Upgrade nginx to the official stable repository now?" "Y"; then
            die "Gateway node setup aborted. nginx ${NGINX_MIN_VERSION}+ is required."
        fi

        install_nginx_stable_repo
        install_nginx_package 1
        start_nginx_service
    else
        [[ "$SKIP_NGINX" -eq 0 ]] || die "--skip-nginx requires nginx ${NGINX_MIN_VERSION}+ to be installed."
        install_nginx_stable_repo
        install_nginx_package
        start_nginx_service
    fi

    local installed_ver
    installed_ver=$(nginx_version)
    installed_ver="${installed_ver:-unknown}"
    if ! nginx_version_at_least "$installed_ver" "$NGINX_MIN_VERSION"; then
        warn "nginx ${installed_ver} is below the required ${NGINX_MIN_VERSION} for Gateway HTTP/2 support."
        if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
            die "nginx ${NGINX_MIN_VERSION}+ is required; found ${installed_ver}."
        elif ! prompt_yes_no "Upgrade nginx to the official stable repository now?" "Y"; then
            die "Gateway node setup aborted. nginx ${NGINX_MIN_VERSION}+ is required."
        fi
        install_nginx_stable_repo
        install_nginx_package 1
        start_nginx_service
        installed_ver=$(nginx_version)
        installed_ver="${installed_ver:-unknown}"
        nginx_version_at_least "$installed_ver" "$NGINX_MIN_VERSION" ||
            die "nginx ${NGINX_MIN_VERSION}+ is required; found ${installed_ver}."
    fi
    ok "nginx ready (${installed_ver})"
}

# ── Step 2: Configure nginx ───────────────────────────────────────────
backup_if_exists() {
    local file="$1"
    if [[ -f "$file" ]]; then
        local backup="${file}.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$file" "$backup"
        log "Backed up ${file} to ${backup}"
    fi
}

ensure_http_include() {
    local include_line="$1"
    local global_conf="/etc/nginx/nginx.conf"
    local tmp_file

    if grep -Fq "$include_line" "$global_conf"; then
        return 0
    fi

    tmp_file=$(mktemp /tmp/nginx-conf-XXXXXX)
    if ! awk -v include_line="$include_line" '
        !inserted && $0 ~ /^[[:space:]]*http[[:space:]]*\{/ {
            print
            print "    " include_line
            inserted = 1
            next
        }
        { print }
        END {
            if (!inserted) {
                exit 1
            }
        }
    ' "$global_conf" > "$tmp_file"; then
        rm -f "$tmp_file"
        return 1
    fi

    mv "$tmp_file" "$global_conf"
    return 0
}

configure_nginx_managed() {
    log "Configuring nginx in managed mode..."
    backup_if_exists "/etc/nginx/nginx.conf"
    backup_if_exists "/etc/nginx/conf.d/default.conf"

    cat > /etc/nginx/nginx.conf << 'EOF'
worker_processes auto;
pid /run/nginx.pid;

events {
    worker_connections 1024;
}

http {
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    client_max_body_size 50m;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    include /etc/nginx/conf.d/*.conf;
    include __GATEWAY_SITES_DIR__/*.conf;
}
EOF
    sed -i "s|__GATEWAY_SITES_DIR__|${NGINX_SITES_DIR}|g" /etc/nginx/nginx.conf

    cat > /etc/nginx/conf.d/default.conf << 'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location /.well-known/acme-challenge/ {
        alias /var/www/acme-challenge/.well-known/acme-challenge/;
    }

    location /health {
        access_log off;
        return 200 "OK\n";
        add_header Content-Type text/plain;
    }

    location /nginx_status {
        stub_status;
        allow 127.0.0.1;
        deny all;
        access_log off;
    }

    location / {
        default_type text/html;
        return 404 '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><meta name="color-scheme" content="light dark"><title>Page not found</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;background:#fff;color:#09090b;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:100%;max-width:560px;text-align:center}.status{color:#71717a;font-size:12px;font-weight:600;letter-spacing:.12em;text-transform:uppercase}h1{margin:16px 0 0;font-size:clamp(40px,8vw,64px);line-height:1.05;font-weight:700;letter-spacing:-.04em}p.message{margin:20px auto 0;max-width:440px;color:#71717a;font-size:15px;line-height:1.6}.footer{margin-top:48px;color:#71717a;font-size:12px}.footer a{color:inherit;text-decoration:none}.footer a:hover{text-decoration:underline}@media(prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}.status,p.message,.footer{color:#a1a1aa}.footer a{color:#fafafa}}</style></head><body><main><section><div class="status">Error 404</div><h1>Page not found</h1><p class="message">The requested host or page is not available.</p></section><div class="footer">Powered by <a href="https://wiolett.net" rel="noopener noreferrer">Wiolett</a></div></main></body></html>';
    }
}
EOF

    STUB_STATUS_URL="http://127.0.0.1/nginx_status"
}

configure_nginx_integrated() {
    local include_file="/etc/nginx/gateway/sites.include.conf"
    local stub_conf="/etc/nginx/gateway/stub_status.conf"

    log "Configuring nginx in integrate mode..."

    cat > "$include_file" << 'EOF'
include __GATEWAY_SITES_DIR__/*.conf;
EOF
    sed -i "s|__GATEWAY_SITES_DIR__|${NGINX_SITES_DIR}|g" "$include_file"

    cat > "$stub_conf" << EOF
server {
    listen 127.0.0.1:${INTEGRATED_STUB_STATUS_PORT};
    server_name localhost;

    location /nginx_status {
        stub_status;
        allow 127.0.0.1;
        deny all;
        access_log off;
    }
}
EOF

    ensure_http_include "include /etc/nginx/gateway/sites.include.conf;" || \
        die "Failed to inject Gateway sites include into /etc/nginx/nginx.conf"
    ensure_http_include "include /etc/nginx/gateway/stub_status.conf;" || \
        die "Failed to inject Gateway stub_status include into /etc/nginx/nginx.conf"

    STUB_STATUS_URL="http://127.0.0.1:${INTEGRATED_STUB_STATUS_PORT}/nginx_status"
}

configure_nginx() {
    if [[ "$NGINX_MODE" == "managed" ]]; then
        configure_nginx_managed
    else
        configure_nginx_integrated
    fi

    if nginx -t >> "$LOG_FILE" 2>&1; then
        if has_systemd; then
            systemctl reload nginx >> "$LOG_FILE" 2>&1 || nginx -s reload >> "$LOG_FILE" 2>&1 || true
        elif has_openrc; then
            rc-service nginx reload >> "$LOG_FILE" 2>&1 || nginx -s reload >> "$LOG_FILE" 2>&1 || true
        else
            nginx -s reload >> "$LOG_FILE" 2>&1 || true
        fi
        ok "nginx configuration updated (${NGINX_MODE} mode)"
    else
        warn "nginx config test failed after configuration changes — check $LOG_FILE"
    fi
}

# ── Step 3: Create directories ───────────────────────────────────────
create_directories() {
    log "Creating required directories..."
    mkdir -p "${NGINX_SITES_DIR}"
    mkdir -p /etc/nginx/certs
    mkdir -p "${NGINX_HTPASSWD_DIR}"
    mkdir -p /etc/nginx/gateway
    mkdir -p /var/www/acme-challenge/.well-known/acme-challenge
    mkdir -p /etc/nginx-daemon/certs
    mkdir -p /var/lib/nginx-daemon

    # Chown if non-root user
    if [[ "$RUN_USER" != "root" ]]; then
        chown -R "${RUN_USER}:${RUN_GROUP}" /etc/nginx-daemon
        chown -R "${RUN_USER}:${RUN_GROUP}" /var/lib/nginx-daemon
    fi

    ok "Directories created"
}

migrate_legacy_gateway_paths() {
    local legacy_dirs=(
        "/etc/nginx/conf.d/sites"
        "/etc/nginx/http.d/gateway"
    )

    for legacy_dir in "${legacy_dirs[@]}"; do
        [[ "$legacy_dir" == "$NGINX_SITES_DIR" ]] && continue
        if [[ -d "$legacy_dir" ]]; then
            find "$legacy_dir" -maxdepth 1 -type f -name '*.conf' -exec mv -f {} "$NGINX_SITES_DIR"/ \; >> "$LOG_FILE" 2>&1 || true
        fi
    done

    if [[ -d /etc/nginx/htpasswd && "/etc/nginx/htpasswd" != "$NGINX_HTPASSWD_DIR" ]]; then
        find /etc/nginx/htpasswd -maxdepth 1 -type f -name 'access-list-*' -exec mv -f {} "$NGINX_HTPASSWD_DIR"/ \; >> "$LOG_FILE" 2>&1 || true
    fi
}

# ── Step 4: Download nginx-daemon binary ─────────────────────────────

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
    local target="/usr/local/bin/nginx-daemon"
    local binary_name="nginx-daemon-linux-${ARCH}"

    if [[ -f "$target" ]]; then
        local existing_ver
        existing_ver=$("$target" version 2>/dev/null | awk '{print $2}' || echo "unknown")
        if [[ "$RESOLVED_DAEMON_VERSION" == "$existing_ver" ]]; then
            ok "nginx-daemon already installed (${existing_ver})"
            return 0
        fi
        log "Upgrading nginx-daemon from ${existing_ver} to ${RESOLVED_DAEMON_VERSION}..."
        # Backup existing binary
        local backup="${target}.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$target" "$backup"
        ok "Backed up existing binary to ${backup}"
    else
        log "Downloading nginx-daemon..."
    fi

    if curl -fsSL "$DOWNLOAD_URL" -o "${target}.tmp" >> "$LOG_FILE" 2>&1; then
        verify_checksum "${target}.tmp" "$binary_name"
        mv "${target}.tmp" "$target"
        chmod +x "$target"
        local ver
        ver=$("$target" version 2>/dev/null | awk '{print $2}' || echo "unknown")
        ok "nginx-daemon installed (${ver})"
    else
        rm -f "${target}.tmp"
        warn "Failed to download from releases — you may need to install the binary manually"
        warn "Place the nginx-daemon binary at ${target}"

        if [[ ! -f "$target" ]]; then
            die "nginx-daemon binary not found at ${target}"
        fi
    fi
}

# ── Step 5: Install and enroll ───────────────────────────────────────
reset_existing_enrollment_for_token() {
    if [[ -z "$ENROLL_TOKEN" ]]; then
        return
    fi

    if [[ ! -d /etc/nginx-daemon/certs && ! -f /var/lib/nginx-daemon/state.json ]]; then
        return
    fi

    local backup_dir="/var/lib/nginx-daemon/enrollment-backup.$(date +%Y%m%d_%H%M%S)"
    log "Fresh enrollment token provided — replacing existing nginx-daemon enrollment state..."
    mkdir -p "$backup_dir"

    if [[ -d /etc/nginx-daemon/certs ]]; then
        cp -a /etc/nginx-daemon/certs "$backup_dir/certs"
        rm -rf /etc/nginx-daemon/certs
    fi

    if [[ -f /var/lib/nginx-daemon/state.json ]]; then
        cp -a /var/lib/nginx-daemon/state.json "$backup_dir/state.json"
        rm -f /var/lib/nginx-daemon/state.json
    fi

    ok "Backed up previous enrollment state to ${backup_dir}"
}

enroll_daemon() {
    local target="/usr/local/bin/nginx-daemon"

    if [[ -f /etc/nginx-daemon/config.yaml ]]; then
        sed -i "s|config_dir: \".*\"|config_dir: \"${NGINX_SITES_DIR}\"|" /etc/nginx-daemon/config.yaml
        sed -i "s|htpasswd_dir: \".*\"|htpasswd_dir: \"${NGINX_HTPASSWD_DIR}\"|" /etc/nginx-daemon/config.yaml
        if [[ "$STUB_STATUS_URL" != "http://127.0.0.1/nginx_status" ]]; then
            sed -i "s|stub_status_url: \".*\"|stub_status_url: \"${STUB_STATUS_URL}\"|" /etc/nginx-daemon/config.yaml
        fi
    fi

    reset_existing_enrollment_for_token

    # Check if already enrolled (certs exist)
    if [[ -f /etc/nginx-daemon/certs/node.pem && -f /var/lib/nginx-daemon/state.json ]]; then
        ok "Node already enrolled — skipping enrollment"
        return 0
    fi

    log "Writing config and enrolling with Gateway..."
    if ! "$target" install --gateway "$GATEWAY_ADDR" --token "$ENROLL_TOKEN" --gateway-cert-sha256 "$GATEWAY_CERT_SHA256" >> "$LOG_FILE" 2>&1; then
        die "Failed to enroll nginx-daemon. Check ${LOG_FILE} for details."
    fi
    sed -i "s|config_dir: \".*\"|config_dir: \"${NGINX_SITES_DIR}\"|" /etc/nginx-daemon/config.yaml
    sed -i "s|htpasswd_dir: \".*\"|htpasswd_dir: \"${NGINX_HTPASSWD_DIR}\"|" /etc/nginx-daemon/config.yaml
    if [[ "$STUB_STATUS_URL" != "http://127.0.0.1/nginx_status" ]]; then
        sed -i "s|stub_status_url: \"http://127.0.0.1/nginx_status\"|stub_status_url: \"${STUB_STATUS_URL}\"|" /etc/nginx-daemon/config.yaml
    fi
    ok "Config written to /etc/nginx-daemon/config.yaml"
}

# ── Step 6: Start the daemon ─────────────────────────────────────────
start_daemon() {
    log "Enabling and starting nginx-daemon..."

    if has_systemd; then
        # Write systemd unit with user/group support
        cat > /etc/systemd/system/nginx-daemon.service <<UNIT
[Unit]
Description=Gateway Nginx Daemon
After=network-online.target nginx.service
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
ExecStart=/usr/local/bin/nginx-daemon run
Restart=always
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT

        systemctl daemon-reload >> "$LOG_FILE" 2>&1
        systemctl enable nginx-daemon >> "$LOG_FILE" 2>&1
        systemctl restart nginx-daemon >> "$LOG_FILE" 2>&1
        sleep 2

        if systemctl is-active --quiet nginx-daemon; then
            ok "nginx-daemon is running"
        else
            warn "nginx-daemon may not have started. Check: journalctl -u nginx-daemon -f"
        fi
    elif has_openrc; then
        cat > /etc/init.d/nginx-daemon <<UNIT
#!/sbin/openrc-run
name="Gateway Nginx Daemon"
description="Gateway Nginx Daemon"
command="/usr/local/bin/nginx-daemon"
command_args="run"
command_user="${RUN_USER}:${RUN_GROUP}"
pidfile="/run/\${RC_SVCNAME}.pid"
supervisor="supervise-daemon"
respawn_delay=5
output_log="/var/log/nginx-daemon.log"
error_log="/var/log/nginx-daemon.err"

depend() {
    need net
    use nginx
}
UNIT
        chmod +x /etc/init.d/nginx-daemon
        rc-update add nginx-daemon default >> "$LOG_FILE" 2>&1
        rc-service nginx-daemon restart >> "$LOG_FILE" 2>&1 || rc-service nginx-daemon start >> "$LOG_FILE" 2>&1
        sleep 2

        if rc-service nginx-daemon status >> "$LOG_FILE" 2>&1; then
            ok "nginx-daemon is running"
        else
            warn "nginx-daemon may not have started. Check: rc-service nginx-daemon status"
        fi
    else
        warn "systemd not found — start the daemon manually: nginx-daemon run"
    fi
}

# ── Run ──────────────────────────────────────────────────────────────
install_nginx
create_directories
migrate_legacy_gateway_paths
configure_nginx
install_daemon
enroll_daemon
start_daemon

echo ""
echo ""
echo -e "  The node should appear as ${GREEN}online${NC} in Gateway within a few seconds."
if has_systemd; then
    echo -e "  Check status:  ${BRAND_MINT}systemctl status nginx-daemon${NC}"
    echo -e "  View logs:     ${BRAND_MINT}journalctl -u nginx-daemon -f${NC}"
elif has_openrc; then
    echo -e "  Check status:  ${BRAND_MINT}rc-service nginx-daemon status${NC}"
    echo -e "  View logs:     ${BRAND_MINT}tail -f /var/log/nginx-daemon.log${NC}"
else
    echo -e "  Start daemon:  ${BRAND_MINT}nginx-daemon run${NC}"
fi
complete_success
