#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Gateway managed-database node setup.
#
# This is intentionally a thin, root-only wrapper around setup-docker-node.sh:
# the existing docker-daemon remains the only daemon binary. Storage selection
# and the capability preflight are rendered in its shared interactive flow.

GREEN='\033[0;32m'
BRAND_MINT='\033[38;2;140;176;132m'
GRAY='\033[0;90m'
BOLD='\033[1m'
NC='\033[0m'
ERROR_TAG='\033[48;2;96;61;43m\033[38;2;245;221;202m'

err() { printf '%b\n' "${ERROR_TAG} ERROR ${NC} $*" >&2; }
log() { printf '%b\n' "${GREEN}INFO${NC} $*"; }
die() {
    err "$@"
    echo "" >&2
    echo -e "${ERROR_TAG} ■ ${NC} Installation completed with errors." >&2
    echo "" >&2
    exit 1
}
command_exists() { command -v "$1" >/dev/null 2>&1; }

sha256_file() {
    local file="$1"
    if command_exists sha256sum; then
        sha256sum "$file" | awk '{print $1}'
    elif command_exists shasum; then
        shasum -a 256 "$file" | awk '{print $1}'
    elif command_exists openssl; then
        openssl dgst -sha256 "$file" | awk '{print $NF}'
    else
        die "A SHA-256 tool (sha256sum, shasum, or openssl) is required"
    fi
}

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

SETUP_VERSION="${GATEWAY_SETUP_VERSION:-latest}"
RELEASE_DOWNLOAD_BASE="${GATEWAY_RELEASE_DOWNLOAD_BASE:-https://github.com/wiolett-industries/gateway/releases}"
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
    if [[ "$SETUP_VERSION" == "latest" ]]; then
        release_url="${RELEASE_DOWNLOAD_BASE%/}/latest/download"
    else
        [[ "$SETUP_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.-]+)?$ ]] || die "Invalid release tag: ${SETUP_VERSION}"
        release_url="${RELEASE_DOWNLOAD_BASE%/}/download/${SETUP_VERSION}"
    fi
    DOWNLOADED_DOCKER_SCRIPT=$(mktemp /tmp/gateway-setup-docker.XXXXXX)
    checksums=$(mktemp /tmp/gateway-setup-checksums.XXXXXX)
    curl -fsSL "${release_url}/gateway-daemon-installers.sha256" -o "$checksums" ||
        die "Could not download installer checksums."
    curl -fsSL "${release_url}/setup-docker-node.sh" -o "$DOWNLOADED_DOCKER_SCRIPT" ||
        die "Could not download setup-docker-node.sh."
    expected=$(awk '$2 == "setup-docker-node.sh" { print $1 }' "$checksums")
    actual=$(sha256_file "$DOWNLOADED_DOCKER_SCRIPT")
    rm -f "$checksums"
    [[ "$expected" =~ ^[a-f0-9]{64}$ && "$actual" == "$expected" ]] ||
        die "Checksum verification failed for setup-docker-node.sh."
    chmod 700 "$DOWNLOADED_DOCKER_SCRIPT"
    DOCKER_SCRIPT="$DOWNLOADED_DOCKER_SCRIPT"
fi

# setup-docker-node performs the actual docker installation and enrollment.
# Force the restricted node's service identity and preserve the caller's flags.
export GATEWAY_DATABASE_STORAGE_ROOT="$STORAGE_ROOT"
export GATEWAY_DOCKER_MODE="databases"
bash "$DOCKER_SCRIPT" "${PASSTHROUGH[@]}" --user "$RUN_USER"
