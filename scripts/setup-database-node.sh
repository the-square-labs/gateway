#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Gateway managed-database node setup.
#
# This is intentionally a thin, root-only wrapper around setup-docker-node.sh:
# the existing docker-daemon remains the only daemon binary. Storage selection
# and the capability preflight are rendered in its shared interactive flow.

RED='\033[0;31m'
GREEN='\033[0;32m'
BRAND_MINT='\033[38;2;140;176;132m'
GRAY='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'

err() { printf '%b\n' "${RED}ERROR${NC} $*" >&2; }
log() { printf '%b\n' "${GREEN}INFO${NC} $*"; }
die() {
    err "$@"
    echo "" >&2
    echo "■ Installation completed with errors." >&2
    echo "" >&2
    exit 1
}
command_exists() { command -v "$1" >/dev/null 2>&1; }

show_header() {
    echo -e "${BRAND_MINT}╭───────────────────────────────────╮${NC}"
    printf "${BRAND_MINT}│${NC} ${BOLD}${BRAND_MINT}%-33s${NC} ${BRAND_MINT}│${NC}\n" "Gateway Node Setup"
    printf "${BRAND_MINT}│${NC} ${GRAY}%-33s${NC} ${BRAND_MINT}│${NC}\n" "Database daemon installer"
    echo -e "${BRAND_MINT}╰───────────────────────────────────╯${NC}"
    echo ""
}

guide() { echo -e "${BRAND_MINT}│${NC} $*"; }
guide_blank() { echo -e "${BRAND_MINT}│${NC}"; }
guide_start() { echo -e "${BRAND_MINT}╭${NC} $*"; }

prompt_choice() {
    local prompt="$1"
    local default="$2"
    local reply
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        echo "$default"
        return
    fi
    if [[ -e /dev/tty ]]; then
        read -r -p "$(echo -e "${BRAND_MINT}◆${NC} ${BRAND_MINT}${prompt} [${default}]: ${NC}")" reply < /dev/tty
    else
        reply=""
    fi
    echo "${reply:-$default}"
}

GITLAB_URL="${GATEWAY_GITLAB_URL:-https://gitlab.wiolett.net}"
GITLAB_PROJECT="${GATEWAY_GITLAB_PROJECT:-wiolett/gateway}"
STORAGE_ROOT="${GATEWAY_DATABASE_STORAGE_ROOT:-}"
RUN_USER="root"
DRY_RUN=0
NON_INTERACTIVE=0
PASSTHROUGH=()
LOCAL_DOCKER_SCRIPT="$(dirname "$0")/setup-docker-node.sh"
DOWNLOADED_DOCKER_SCRIPT=""
PREFLIGHT_DIR=""
LOOP_DEVICE=""
MOUNT_DIR=""

usage() {
    cat <<'HELP'
Gateway Database Node Setup — restricted docker-daemon enrollment

Usage:
  setup-database-node.sh [options]

Options:
  --storage-root <path>   Existing or creatable local storage root used for the
                          disposable ext4 capability preflight (default:
                          /var/lib/docker-daemon/databases)
  --gitlab-url <url>      GitLab instance used to fetch setup-docker-node.sh
  --gitlab-project <proj> GitLab project path
  --user root             Accepted only for compatibility; databases always run as root
  --dry-run               Validate delegated Docker setup without changing the host
  -h, --help              Show this help

All other options are forwarded to setup-docker-node.sh. The node is enrolled
only after the storage preflight succeeds.
HELP
    exit 0
}

cleanup() {
    set +e
    if [[ -n "$MOUNT_DIR" ]] && command_exists mountpoint && mountpoint -q "$MOUNT_DIR"; then
        umount "$MOUNT_DIR" >/dev/null 2>&1
    fi
    if [[ -n "$LOOP_DEVICE" ]]; then
        losetup -d "$LOOP_DEVICE" >/dev/null 2>&1
    fi
    cleanup_preflight
    if [[ -n "$DOWNLOADED_DOCKER_SCRIPT" ]]; then
        rm -f "$DOWNLOADED_DOCKER_SCRIPT"
    fi
}
trap cleanup EXIT INT TERM

cleanup_preflight() {
    [[ -n "$PREFLIGHT_DIR" ]] || return 0
    rm -f "$PREFLIGHT_DIR/test.img" >/dev/null 2>&1 || true
    rmdir "$PREFLIGHT_DIR/mnt" >/dev/null 2>&1 || true
    rmdir "$PREFLIGHT_DIR" >/dev/null 2>&1 || true
    PREFLIGHT_DIR=""
    MOUNT_DIR=""
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --storage-root)
            [[ $# -ge 2 ]] || die "--storage-root requires a path"
            STORAGE_ROOT="$2"
            shift 2
            ;;
        --gitlab-url)
            [[ $# -ge 2 ]] || die "--gitlab-url requires a URL"
            GITLAB_URL="$2"
            PASSTHROUGH+=("--gitlab-url" "$2")
            shift 2
            ;;
        --gitlab-project)
            [[ $# -ge 2 ]] || die "--gitlab-project requires a project path"
            GITLAB_PROJECT="$2"
            PASSTHROUGH+=("--gitlab-project" "$2")
            shift 2
            ;;
        --user)
            [[ $# -ge 2 ]] || die "--user requires a value"
            [[ "$2" == "root" ]] || die "Database nodes must run docker-daemon as root."
            shift 2
            ;;
        --dry-run)
            DRY_RUN=1
            PASSTHROUGH+=("--dry-run")
            shift
            ;;
        -y|--yes)
            NON_INTERACTIVE=1
            PASSTHROUGH+=("$1")
            shift
            ;;
        -h|--help) usage ;;
        *) PASSTHROUGH+=("$1"); shift ;;
    esac
done

[[ "$EUID" -eq 0 ]] || die "This script must be run as root (or with sudo)."

if [[ -x "$LOCAL_DOCKER_SCRIPT" ]]; then
    DOCKER_SCRIPT="$LOCAL_DOCKER_SCRIPT"
else
    command_exists curl || die "curl is required to fetch setup-docker-node.sh."
    url="${GITLAB_URL}/${GITLAB_PROJECT}/-/raw/main/scripts/setup-docker-node.sh"
    DOWNLOADED_DOCKER_SCRIPT=$(mktemp /tmp/gateway-setup-docker.XXXXXX)
    curl -fsSL "$url" -o "$DOWNLOADED_DOCKER_SCRIPT" || die "Could not download setup-docker-node.sh."
    chmod 700 "$DOWNLOADED_DOCKER_SCRIPT"
    DOCKER_SCRIPT="$DOWNLOADED_DOCKER_SCRIPT"
fi

# setup-docker-node performs the actual docker installation and enrollment.
# Force the restricted node's service identity and preserve the caller's flags.
export GATEWAY_DATABASE_STORAGE_ROOT="$STORAGE_ROOT"
export GATEWAY_DOCKER_MODE="databases"
bash "$DOCKER_SCRIPT" "${PASSTHROUGH[@]}" --user "$RUN_USER"
