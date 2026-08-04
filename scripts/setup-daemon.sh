#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# ── Gateway Daemon Setup — Dispatcher ───────────────────────────────
# Downloads and runs the appropriate setup script for a daemon type.
#
# Usage:
#   curl -sSL https://gitlab.wiolett.net/wiolett/gateway/-/raw/main/scripts/setup-daemon.sh | \
#     sudo bash -s -- --type nginx --gateway gateway.example.com:9443 --token <TOKEN> --gateway-cert-sha256 sha256:<HEX>
# ────────────────────────────────────────────────────────────────────

# ── Colors ──────────────────────────────────────────────────────────
BRAND_MINT='\033[38;2;140;176;132m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
GRAY='\033[0;90m'
NC='\033[0m'
BOLD='\033[1m'
INFO_TAG='\033[47m\033[90m'
WARN_TAG='\033[43m\033[30m'
ERROR_TAG='\033[41m\033[97m'

# ── Defaults ────────────────────────────────────────────────────────
DAEMON_TYPE=""
GITLAB_URL="${GATEWAY_GITLAB_URL:-https://gitlab.wiolett.net}"
GITLAB_PROJECT="${GATEWAY_GITLAB_PROJECT:-wiolett/gateway}"
LOCAL_SCRIPT_DIR="${GATEWAY_SETUP_SCRIPT_DIR:-}"
PASSTHROUGH_ARGS=()

# ── Helpers ─────────────────────────────────────────────────────────
log()  { echo -e "${INFO_TAG} INFO ${NC} $*"; }
warn() { echo -e "${WARN_TAG} WARN ${NC} $*"; }
err()  { echo -e "${ERROR_TAG} ERROR ${NC} $*" >&2; }
die()  { err "$@"; exit 1; }

command_exists() { command -v "$1" &>/dev/null; }

mktemp_compat() {
    local prefix="${1:-/tmp/gateway-tmp}"
    local dir template

    dir="$(dirname "$prefix")"
    template="$(basename "$prefix").XXXXXX"

    mkdir -p "$dir"
    mktemp "${dir}/${template}"
}

show_logo() {
    local title="$1"
    local subtitle="$2"

    echo -e "${BRAND_MINT}╭───────────────────────────────────╮${NC}"
    printf "${BRAND_MINT}│${NC} ${BOLD}${BRAND_MINT}%-33s${NC} ${BRAND_MINT}│${NC}\n" "$title"
    printf "${BRAND_MINT}│${NC} ${GRAY}%-33s${NC} ${BRAND_MINT}│${NC}\n" "$subtitle"
    echo -e "${BRAND_MINT}╰───────────────────────────────────╯${NC}"
    echo ""
}

guide() { echo -e "${BRAND_MINT}│${NC} $*"; }
guide_blank() { echo -e "${BRAND_MINT}│${NC}"; }
guide_end() { echo -e "${BRAND_MINT}╰${NC}"; }
guide_start() { echo -e "${BRAND_MINT}╭${NC} $*"; }
selector_title() { echo -e "${BRAND_MINT}◆${NC} ${GRAY}$*${NC}"; }

prompt_menu() {
    local default="$1"
    shift
    local -a options=("$@")
    local selected=$((default - 1)) key sequence tty="/dev/tty" index
    [[ -r "$tty" && -w "$tty" && "${TERM:-dumb}" != "dumb" ]] || die "Cannot show an interactive menu — use --type flag"
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
        IFS= read -rsn1 key < "$tty" || die "Interactive menu closed"
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
}

# ── Parse Arguments ─────────────────────────────────────────────────
show_help() {
    cat <<'HELP'
Gateway Daemon Setup — downloads and runs the appropriate setup script

Usage:
  setup-daemon.sh --type <nginx|docker|databases|monitoring> [options...]

Options:
  --type <type>            Daemon type: nginx, docker, databases, or monitoring
  --gitlab-url <url>       GitLab instance URL (default: https://gitlab.wiolett.net)
  --gitlab-project <proj>  GitLab project path (default: wiolett/gateway)
  --script-dir <path>      Run a daemon-specific installer from a local directory
  -h, --help               Show this help

All other flags are forwarded to the daemon-specific setup script.

Examples:
  # Interactive type selection:
  sudo bash setup-daemon.sh

  # Direct nginx setup:
  sudo bash setup-daemon.sh --type nginx --gateway gw.example.com:9443 --token <TOKEN> --gateway-cert-sha256 sha256:<HEX>

  # Docker daemon with custom GitLab:
  sudo bash setup-daemon.sh --type docker --gitlab-url https://git.example.com --gateway gw.example.com:9443 --token <TOKEN> --gateway-cert-sha256 sha256:<HEX>
HELP
    exit 0
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --type)           DAEMON_TYPE="$2"; shift 2 ;;
        --gitlab-url)     GITLAB_URL="$2"; PASSTHROUGH_ARGS+=("--gitlab-url" "$2"); shift 2 ;;
        --gitlab-project) GITLAB_PROJECT="$2"; PASSTHROUGH_ARGS+=("--gitlab-project" "$2"); shift 2 ;;
        --script-dir)     LOCAL_SCRIPT_DIR="$2"; shift 2 ;;
        -h|--help)        show_help ;;
        *)                PASSTHROUGH_ARGS+=("$1"); shift ;;
    esac
done

# ── Dependency check ────────────────────────────────────────────────
if ! command_exists curl; then
    die "curl is required but not found. Install it and retry."
fi

# ── Interactive type selection ──────────────────────────────────────
if [[ -z "$DAEMON_TYPE" ]]; then
    if [ -t 1 ] && command_exists clear; then
        clear
    fi
    show_logo "Gateway Daemon Setup" "Choose a node installer"
    selector_title "Select daemon type to install:"
    choice=$(prompt_menu "1" "nginx       — Reverse proxy node (nginx + nginx-daemon)" "docker      — Docker container management node" "databases   — Restricted Docker database node" "monitoring  — System metrics agent (no nginx/docker)")
    case "$choice" in
        1|nginx)      DAEMON_TYPE="nginx" ;;
        2|docker)     DAEMON_TYPE="docker" ;;
        3|databases)   DAEMON_TYPE="databases" ;;
        4|monitoring) DAEMON_TYPE="monitoring" ;;
        *) die "Invalid choice: $choice" ;;
    esac
fi

# ── Validate type ───────────────────────────────────────────────────
case "$DAEMON_TYPE" in
    nginx|docker|databases|monitoring) ;;
    *) die "Unknown daemon type: $DAEMON_TYPE. Use: nginx, docker, databases, or monitoring" ;;
esac

# ── Map type to script name ─────────────────────────────────────────
case "$DAEMON_TYPE" in
    nginx)      SCRIPT_NAME="setup-node.sh" ;;
    docker)     SCRIPT_NAME="setup-docker-node.sh" ;;
    databases)  SCRIPT_NAME="setup-database-node.sh" ;;
    monitoring) SCRIPT_NAME="setup-monitoring-node.sh" ;;
esac

# ── Build GitLab API URL ────────────────────────────────────────────
ENCODED_PROJECT="${GITLAB_PROJECT//\//%2F}"
GITLAB_API="${GITLAB_URL}/api/v4/projects/${ENCODED_PROJECT}"

# ── Resolve and execute ─────────────────────────────────────────────
if [[ -n "$LOCAL_SCRIPT_DIR" ]]; then
    TMPSCRIPT="${LOCAL_SCRIPT_DIR%/}/${SCRIPT_NAME}"
    [[ -f "$TMPSCRIPT" ]] || die "Local installer not found: ${TMPSCRIPT}"
    log "Running local ${SCRIPT_NAME}..."
else
    DOWNLOAD_URL="${GITLAB_URL}/${GITLAB_PROJECT}/-/raw/main/scripts/${SCRIPT_NAME}"
    log "Downloading ${SCRIPT_NAME} from ${GITLAB_URL}..."

    TMPSCRIPT=$(mktemp_compat /tmp/gateway-setup)
    trap 'rm -f "$TMPSCRIPT"' EXIT

    if ! curl -fsSL "$DOWNLOAD_URL" -o "$TMPSCRIPT"; then
        die "Failed to download ${SCRIPT_NAME} from releases. URL: ${DOWNLOAD_URL}"
    fi
    chmod +x "$TMPSCRIPT"
    log "Running ${SCRIPT_NAME}..."
fi
echo ""

exec bash "$TMPSCRIPT" "${PASSTHROUGH_ARGS[@]}"
