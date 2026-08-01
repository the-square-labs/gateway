#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# Gateway managed-database node setup.
#
# This is intentionally a thin, root-only wrapper around setup-docker-node.sh:
# the existing docker-daemon remains the only daemon binary.  The capability
# preflight runs before that script can install or enroll the node.

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

err() { printf '%b\n' "${RED}ERROR${NC} $*" >&2; }
log() { printf '%b\n' "${GREEN}INFO${NC} $*"; }
die() { err "$@"; exit 1; }
command_exists() { command -v "$1" >/dev/null 2>&1; }

GITLAB_URL="${GATEWAY_GITLAB_URL:-https://gitlab.wiolett.net}"
GITLAB_PROJECT="${GATEWAY_GITLAB_PROJECT:-wiolett/gateway}"
STORAGE_ROOT="${GATEWAY_DATABASE_STORAGE_ROOT:-/var/lib/docker-daemon/databases}"
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
        -h|--help) usage ;;
        *) PASSTHROUGH+=("$1"); shift ;;
    esac
done

[[ "$EUID" -eq 0 ]] || die "This script must be run as root (or with sudo)."

preflight() {
    local required=(awk blockdev chmod command df dd fallocate grep losetup mkfs.ext4 mount mountpoint mktemp resize2fs rm rmdir stat umount)
    local cmd
    for cmd in "${required[@]}"; do
        command_exists "$cmd" || die "Required command '$cmd' is missing; refusing enrollment."
    done

    [[ "$STORAGE_ROOT" == /* ]] || die "--storage-root must be an absolute path."
    [[ "$STORAGE_ROOT" != "/" ]] || die "Refusing '/' as database storage root."
    [[ ! -L "$STORAGE_ROOT" ]] || die "Refusing symlink storage root: $STORAGE_ROOT"
    mkdir -p -- "$STORAGE_ROOT"
    [[ -d "$STORAGE_ROOT" && -w "$STORAGE_ROOT" ]] || die "Storage root is not writable: $STORAGE_ROOT"

    local available_kib
    available_kib=$(df -Pk -- "$STORAGE_ROOT" | awk 'NR==2 {print $4}')
    [[ "$available_kib" =~ ^[0-9]+$ && "$available_kib" -ge 32768 ]] || die "Storage root needs at least 32 MiB free for preflight."

    PREFLIGHT_DIR=$(mktemp -d "$STORAGE_ROOT/.gateway-db-preflight.XXXXXX")
    MOUNT_DIR="$PREFLIGHT_DIR/mnt"
    mkdir -- "$MOUNT_DIR"
    local image="$PREFLIGHT_DIR/test.img"
    dd if=/dev/zero of="$image" bs=1M count=16 status=none conv=fsync
    [[ "$(stat -c '%s' "$image")" -eq 16777216 ]] || die "Preflight image is sparse or has the wrong size."
    mkfs.ext4 -q -F "$image" >/dev/null 2>&1 || die "Could not format disposable ext4 image."
    LOOP_DEVICE=$(losetup --find --show "$image") || die "No loop device is available."
    [[ -b "$LOOP_DEVICE" ]] || die "losetup did not return a block device."
    mount "$LOOP_DEVICE" "$MOUNT_DIR" || die "Could not mount disposable ext4 image."
    printf 'gateway-db-preflight\n' > "$MOUNT_DIR/.write-test" || die "Mounted storage is not writable."
    fallocate -l 32M "$image" || die "Could not grow disposable ext4 image."
    losetup -c "$LOOP_DEVICE" || die "Loop device does not support capacity refresh."
    [[ "$(blockdev --getsize64 "$LOOP_DEVICE")" -eq 33554432 ]] || die "Loop device did not observe expanded image capacity."
    resize2fs "$LOOP_DEVICE" >/dev/null || die "Could not grow mounted ext4 image."
    sync
    umount "$MOUNT_DIR" || die "Could not unmount disposable ext4 image."
    losetup -d "$LOOP_DEVICE" || die "Could not detach disposable loop device."
    LOOP_DEVICE=""
    log "Storage preflight passed for $STORAGE_ROOT"
}

preflight
cleanup_preflight

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
bash "$DOCKER_SCRIPT" "${PASSTHROUGH[@]}" --user root
