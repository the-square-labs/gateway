#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# ── Gateway Docker Node Setup ────────────────────────────────────────
# Installs docker-daemon on a host and enrolls it with the Gateway.
#
# Usage:
#   curl -sSL https://github.com/wiolett-industries/gateway/releases/latest/download/setup-docker-node.sh | \
#     sudo bash -s -- --gateway gateway.example.com:9443 --token <ENROLLMENT_TOKEN> --gateway-cert-sha256 sha256:<HEX>
#
# Or download and run:
#   bash setup-docker-node.sh --gateway gateway.example.com:9443 --token <TOKEN> --gateway-cert-sha256 sha256:<HEX>
# ──────────────────────────────────────────────────────────────────────

LOG_FILE="/dev/null"

# ── Colors ───────────────────────────────────────────────────────────
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

# ── Defaults ─────────────────────────────────────────────────────────
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
OS_VERSION_CODENAME=""
DOCKER_USE_SUDO=0
DOCKER_SYSTEMD_UNIT=""
DOCKER_SOCKET="unix:///var/run/docker.sock"
DOCKER_MODE="${GATEWAY_DOCKER_MODE:-}"
BUILDER_EGRESS_PROFILE="${GATEWAY_BUILDER_EGRESS_PROFILE:-internet}"
BUILDER_RUNTIME_ROOT="/opt/gateway-builder"
BUILDER_RUNTIME_BIN_DIR="${BUILDER_RUNTIME_ROOT}/bin"
BUILDER_RUNTIME_LEGACY_BIN_DIR="${BUILDER_RUNTIME_ROOT}/legacy-bin"
BUILDER_RUNTIME_MANIFEST="${BUILDER_RUNTIME_ROOT}/runtime-manifest"
BUILDER_RUNTIME_PATH="${BUILDER_RUNTIME_BIN_DIR}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
DATABASE_STORAGE_ROOT="${GATEWAY_DATABASE_STORAGE_ROOT:-}"
RESOLVED_DAEMON_VERSION=""
EXISTING_INSTALL=0
EXISTING_VERSION=""
EXISTING_GATEWAY_ADDR=""
EXISTING_ENROLLED=0
MANUAL_FALLBACK_USED=0
DATABASE_PREFLIGHT_DIR=""
DATABASE_PREFLIGHT_MOUNT_DIR=""
DATABASE_PREFLIGHT_LOOP_DEVICE=""
DATABASE_PREFLIGHT_CREATED_ROOT=0

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

show_logo() {
    local subtitle="Docker daemon installer"
    [[ "$DOCKER_MODE" == "databases" ]] && subtitle="Database daemon installer"
    [[ "$DOCKER_MODE" == "builder" ]] && subtitle="Builder daemon installer"
    echo -e "${BRAND_MINT}╭───────────────────────────────────╮${NC}"
    printf "${BRAND_MINT}│${NC} ${BOLD}${BRAND_MINT}%-33s${NC} ${BRAND_MINT}│${NC}\n" "Gateway Node Setup"
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

database_storage_root_for_mount() {
    local mountpoint="$1"
    if [[ "$mountpoint" == "/" ]]; then
        echo "/var/lib/docker-daemon/databases"
    else
        echo "${mountpoint%/}/gateway-databases"
    fi
}

database_storage_capability_hint() {
    local virtualization=""
    if command_exists systemd-detect-virt; then
        virtualization=$(systemd-detect-virt 2>/dev/null || true)
    fi
    if [[ "$virtualization" == "lxc" ]]; then
        printf '%s' "This host is an LXC guest. Configure the outer host to pass /dev/loop-control and a loop-device pool, allow loop block devices and mounts, or use a VM/bare-metal database node."
        return
    fi
    printf '%s' "The database profile requires usable loop devices plus permission to mount ext4 filesystems."
}

cleanup_database_preflight() {
    local previous_status=$?
    set +e
    if [[ -n "$DATABASE_PREFLIGHT_MOUNT_DIR" ]] && command_exists mountpoint && mountpoint -q "$DATABASE_PREFLIGHT_MOUNT_DIR"; then
        umount "$DATABASE_PREFLIGHT_MOUNT_DIR" >>"$LOG_FILE" 2>&1 || true
    fi
    if [[ -n "$DATABASE_PREFLIGHT_LOOP_DEVICE" ]] && command_exists losetup; then
        losetup -d "$DATABASE_PREFLIGHT_LOOP_DEVICE" >>"$LOG_FILE" 2>&1 || true
    fi
    if [[ -n "$DATABASE_PREFLIGHT_DIR" ]]; then
        rm -f "$DATABASE_PREFLIGHT_DIR/mnt/.write-test" "$DATABASE_PREFLIGHT_DIR/test.img" >/dev/null 2>&1 || true
        rmdir "$DATABASE_PREFLIGHT_DIR/mnt" "$DATABASE_PREFLIGHT_DIR" >/dev/null 2>&1 || true
    fi
    if [[ "$DATABASE_PREFLIGHT_CREATED_ROOT" -eq 1 && -n "$DATABASE_STORAGE_ROOT" ]]; then
        rmdir "$DATABASE_STORAGE_ROOT" >/dev/null 2>&1 || true
    fi
    DATABASE_PREFLIGHT_DIR=""
    DATABASE_PREFLIGHT_MOUNT_DIR=""
    DATABASE_PREFLIGHT_LOOP_DEVICE=""
    DATABASE_PREFLIGHT_CREATED_ROOT=0
    set -e
    return "$previous_status"
}

trap cleanup_database_preflight EXIT

select_database_storage() {
    [[ "$DOCKER_MODE" == "databases" ]] || return 0
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        [[ -n "$DATABASE_STORAGE_ROOT" ]] || DATABASE_STORAGE_ROOT="/var/lib/docker-daemon/databases"
        return
    fi

    selector_title "Database images storage:"
    local -a mounts=() options=()
    local target source fstype candidate entry index mountpoint free storage_default=1 storage_choice custom_choice
    if command_exists findmnt; then
        while IFS=' ' read -r target source fstype; do
            case "$fstype" in tmpfs|devtmpfs|proc|sysfs|cgroup*|overlay|squashfs|ramfs|nsfs) continue ;; esac
            case "$target" in /proc*|/sys*|/dev*|/run*|/snap*) continue ;; esac
            [[ -d "$target" ]] || continue
            candidate=$(database_storage_root_for_mount "$target")
            mounts+=("$target|$candidate")
        done < <(findmnt -rn -o TARGET,SOURCE,FSTYPE)
    fi
    if [[ "${#mounts[@]}" -eq 0 ]]; then
        mounts=("/|/var/lib/docker-daemon/databases")
    fi
    index=1
    for entry in "${mounts[@]}"; do
        candidate="${entry#*|}"
        if [[ -n "$DATABASE_STORAGE_ROOT" && "$candidate" == "$DATABASE_STORAGE_ROOT" ]]; then
            storage_default="$index"
            break
        fi
        index=$((index + 1))
    done
    index=1
    for entry in "${mounts[@]}"; do
        mountpoint="${entry%%|*}"
        candidate="${entry#*|}"
        free=$(df -hP "$mountpoint" | awk 'NR==2 {print $4}')
        options+=("${candidate}  (${mountpoint}, ${free} free)")
        index=$((index + 1))
    done
    custom_choice=$index
    options+=("Custom path")
    storage_choice=$(prompt_choice "Choose disk" "$storage_default" "${options[@]}")
    [[ "$storage_choice" =~ ^[0-9]+$ ]] && (( storage_choice >= 1 && storage_choice <= "$custom_choice" )) || die "Invalid storage choice: $storage_choice"
    if [[ "$storage_choice" -eq "$custom_choice" ]]; then
        guide_blank
        DATABASE_STORAGE_ROOT=$(prompt_input "Database images storage path" "${DATABASE_STORAGE_ROOT:-/var/lib/docker-daemon/databases}")
        [[ -n "$DATABASE_STORAGE_ROOT" ]] || die "Database storage path is required"
        guide_blank
    else
        DATABASE_STORAGE_ROOT="${mounts[$((storage_choice - 1))]#*|}"
    fi
    guide "${GRAY}Selected: ${NC}${DATABASE_STORAGE_ROOT}"
    guide_blank
}

preflight_database_storage() {
    [[ "$DOCKER_MODE" == "databases" ]] || return 0
    [[ -n "$DATABASE_STORAGE_ROOT" && "$DATABASE_STORAGE_ROOT" == /* && "$DATABASE_STORAGE_ROOT" != "/" ]] || die "Database storage root is invalid."
    if [[ "$DRY_RUN" -eq 1 ]]; then
        log "Dry run: skipping disposable storage preflight for ${DATABASE_STORAGE_ROOT}"
        return
    fi
    local required=(awk blockdev chmod df fallocate grep losetup mkfs.ext4 mount mountpoint mktemp resize2fs rm rmdir stat umount)
    local cmd image available_kib available_loop allocated_bytes loop_output
    for cmd in "${required[@]}"; do command_exists "$cmd" || die "Required command '$cmd' is missing; refusing enrollment."; done
    [[ ! -L "$DATABASE_STORAGE_ROOT" ]] || die "Refusing symlink storage root: ${DATABASE_STORAGE_ROOT}"
    if [[ ! -e "$DATABASE_STORAGE_ROOT" ]]; then
        mkdir -p -- "$DATABASE_STORAGE_ROOT"
        DATABASE_PREFLIGHT_CREATED_ROOT=1
    fi
    [[ -d "$DATABASE_STORAGE_ROOT" && -w "$DATABASE_STORAGE_ROOT" ]] || die "Storage root is not writable: ${DATABASE_STORAGE_ROOT}"
    available_kib=$(df -Pk -- "$DATABASE_STORAGE_ROOT" | awk 'NR==2 {print $4}')
    [[ "$available_kib" =~ ^[0-9]+$ && "$available_kib" -ge 163840 ]] || die "Storage root needs at least 160 MiB free to validate the minimum database image lifecycle."

    if ! available_loop=$(losetup -f 2>>"$LOG_FILE"); then
        die "No free loop device is available. $(database_storage_capability_hint)"
    fi
    [[ "$available_loop" == /dev/loop* && -b "$available_loop" ]] || die "losetup returned an unusable loop device. $(database_storage_capability_hint)"

    DATABASE_PREFLIGHT_DIR=$(mktemp -d "$DATABASE_STORAGE_ROOT/.gateway-db-preflight.XXXXXX")
    DATABASE_PREFLIGHT_MOUNT_DIR="$DATABASE_PREFLIGHT_DIR/mnt"
    image="$DATABASE_PREFLIGHT_DIR/test.img"
    mkdir "$DATABASE_PREFLIGHT_MOUNT_DIR"

    fallocate -l 64M "$image" >>"$LOG_FILE" 2>&1 || die "Could not preallocate a fixed-size database image."
    [[ "$(stat -c '%s' "$image")" -eq 67108864 ]] || die "Preflight image has the wrong logical size."
    allocated_bytes=$(( $(stat -c '%b' "$image") * 512 ))
    [[ "$allocated_bytes" -ge 67108864 ]] || die "Storage filesystem created a sparse image instead of reserving the requested capacity."
    mkfs.ext4 -q -F "$image" >>"$LOG_FILE" 2>&1 || die "Could not format the disposable database image as ext4."

    if loop_output=$(losetup --find --show --nooverlap "$image" 2>>"$LOG_FILE"); then
        DATABASE_PREFLIGHT_LOOP_DEVICE=$(printf '%s\n' "$loop_output" | awk '/^\/dev\/loop[0-9]+$/ { print; exit }')
    else
        DATABASE_PREFLIGHT_LOOP_DEVICE=$(losetup -f 2>>"$LOG_FILE") || die "No free loop device is available. $(database_storage_capability_hint)"
        losetup "$DATABASE_PREFLIGHT_LOOP_DEVICE" "$image" >>"$LOG_FILE" 2>&1 || die "Could not attach the disposable database image. $(database_storage_capability_hint)"
    fi
    [[ -n "$DATABASE_PREFLIGHT_LOOP_DEVICE" && -b "$DATABASE_PREFLIGHT_LOOP_DEVICE" ]] || die "losetup did not attach a usable loop device. $(database_storage_capability_hint)"

    mount -o noatime "$DATABASE_PREFLIGHT_LOOP_DEVICE" "$DATABASE_PREFLIGHT_MOUNT_DIR" >>"$LOG_FILE" 2>&1 || die "Could not mount the disposable ext4 database image. $(database_storage_capability_hint)"
    printf 'gateway-db-preflight\n' > "$DATABASE_PREFLIGHT_MOUNT_DIR/.write-test" || die "Mounted database storage is not writable."

    fallocate -l 128M "$image" >>"$LOG_FILE" 2>&1 || die "Could not grow the disposable database image."
    losetup -c "$DATABASE_PREFLIGHT_LOOP_DEVICE" >>"$LOG_FILE" 2>&1 || die "Loop device does not support capacity refresh."
    [[ "$(blockdev --getsize64 "$DATABASE_PREFLIGHT_LOOP_DEVICE")" -eq 134217728 ]] || die "Loop device did not observe expanded image capacity."
    resize2fs "$DATABASE_PREFLIGHT_LOOP_DEVICE" >>"$LOG_FILE" 2>&1 || die "Could not grow the mounted ext4 database filesystem."

    umount "$DATABASE_PREFLIGHT_MOUNT_DIR" >>"$LOG_FILE" 2>&1 || die "Could not unmount the disposable database image."
    DATABASE_PREFLIGHT_MOUNT_DIR=""
    losetup -d "$DATABASE_PREFLIGHT_LOOP_DEVICE" >>"$LOG_FILE" 2>&1 || die "Could not detach the disposable loop device."
    DATABASE_PREFLIGHT_LOOP_DEVICE=""
    rm -f "$image"
    rmdir "$DATABASE_PREFLIGHT_DIR/mnt" "$DATABASE_PREFLIGHT_DIR"
    DATABASE_PREFLIGHT_DIR=""
    DATABASE_PREFLIGHT_CREATED_ROOT=0
    ok "Storage preflight passed for ${DATABASE_STORAGE_ROOT}"
}

preflight_database_docker() {
    [[ "$DOCKER_MODE" == "databases" ]] || return 0
    [[ "$RUN_USER" == "root" ]] || die "Database docker-daemon profile must run as root."
    docker_run info >>"$LOG_FILE" 2>&1 || die "Docker Engine is not reachable; refusing database-node enrollment."
    [[ "$DOCKER_SOCKET" == unix://* ]] || die "Database nodes require a local Docker Engine socket; refusing remote Docker context '${DOCKER_SOCKET}'."
    [[ -S "${DOCKER_SOCKET#unix://}" ]] || die "Docker Engine socket is unavailable at ${DOCKER_SOCKET#unix://}."
    ok "Docker Engine preflight passed (${DOCKER_SOCKET})"
}

preflight_builder_runtime() {
    [[ "$DOCKER_MODE" == "builder" ]] || return 0
    has_systemd || die "Builder nodes require systemd to supervise the isolated containerd and BuildKit services."
    local bundled=(containerd ctr buildkitd buildctl runc containerd-shim-runc-v2 syft grype)
    local system=(git iptables getent)
    local missing=() binary
    for binary in "${bundled[@]}"; do
        [[ -f "${BUILDER_RUNTIME_BIN_DIR}/${binary}" && ! -L "${BUILDER_RUNTIME_BIN_DIR}/${binary}" && -x "${BUILDER_RUNTIME_BIN_DIR}/${binary}" ]] || \
            missing+=("${BUILDER_RUNTIME_BIN_DIR}/${binary}")
    done
    for binary in "${system[@]}"; do
        command_exists "$binary" || missing+=("$binary")
    done
    if [[ "${#missing[@]}" -gt 0 ]]; then
        die "Builder runtime is incomplete. Missing: ${missing[*]}. Re-run the Gateway builder installer before enrollment."
    fi
    if [[ "$BUILDER_EGRESS_PROFILE" == "internet" ]]; then
        local plugin
        for plugin in bridge host-local firewall loopback; do
            [[ -x "/opt/gateway-builder/cni/bin/${plugin}" ]] || die "Builder internet egress requires CNI plugin ${plugin} in /opt/gateway-builder/cni/bin."
        done
    fi
    ok "Builder runtime preflight passed (BuildKit + dedicated containerd + runc)"
}

ensure_builder_system_packages() {
    [[ "$DOCKER_MODE" == "builder" ]] || return 0
    case "$ARCH" in
        amd64|arm64) ;;
        *) die "Builder runtime is supported only on amd64 and arm64 hosts." ;;
    esac
    local missing=() binary
    for binary in git iptables getent tar gzip sha256sum; do
        command_exists "$binary" || missing+=("$binary")
    done
    [[ "${#missing[@]}" -gt 0 ]] || return 0
    log "Installing Build Worker system dependencies..."
    case "$OS_ID" in
        ubuntu|debian)
            install_system_packages git iptables libc-bin tar gzip coreutils ca-certificates
            ;;
        alpine)
            install_system_packages git iptables musl-utils tar gzip coreutils ca-certificates
            ;;
        fedora|rhel|centos|centos_stream)
            install_system_packages git iptables glibc-common tar gzip coreutils ca-certificates
            ;;
        *) die "Automatic Build Worker dependency installation is unsupported on ${OS_ID}." ;;
    esac
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
        OS_VERSION_CODENAME="${VERSION_CODENAME:-}"
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

run_quiet() {
    if "$@" >>"$LOG_FILE" 2>&1; then
        return 0
    fi
    die "Command failed: $*. Check ${LOG_FILE} for details."
}

run_privileged_quiet() {
    if [[ $EUID -eq 0 ]]; then
        run_quiet "$@"
        return
    fi
    if command_exists sudo; then
        run_quiet sudo "$@"
        return
    fi
    die "This step requires root privileges. Re-run as root or install sudo."
}

download_with_progress() {
    local url="$1"
    local output="$2"
    if [[ "$NON_INTERACTIVE" -eq 1 || ! -t 1 ]]; then
        curl -fL --silent --show-error "$url" -o "$output"
    else
        curl -fL --progress-bar "$url" -o "$output"
    fi
}

pkg_update_once() {
    if command_exists apt-get; then
        if [[ "$APT_UPDATED" -eq 0 ]]; then
            run_privileged_quiet apt-get update
            APT_UPDATED=1
        fi
    elif command_exists apk; then
        run_privileged_quiet apk update
    fi
}

install_system_packages() {
    pkg_update_once
    if command_exists apt-get; then
        run_privileged_quiet apt-get install -y "$@"
    elif command_exists yum; then
        run_privileged_quiet yum install -y "$@"
    elif command_exists dnf; then
        run_privileged_quiet dnf install -y "$@"
    elif command_exists apk; then
        run_privileged_quiet apk add "$@"
    else
        die "Could not detect a supported package manager for automatic dependency installation."
    fi
}

ensure_curl_installed() {
    if command_exists curl; then
        return
    fi
    [[ "$DRY_RUN" -eq 0 ]] || die "curl is required to resolve the daemon release during dry run."
    log "curl not found, installing it..."
    install_system_packages curl ca-certificates
}

docker_run() {
    if [[ "$DOCKER_USE_SUDO" -eq 1 ]]; then
        sudo docker "$@"
    else
        docker "$@"
    fi
}

detect_docker_access() {
    if docker info >/dev/null 2>&1; then
        DOCKER_USE_SUDO=0
        detect_docker_socket
        return 0
    fi
    if command_exists sudo && sudo docker info >/dev/null 2>&1; then
        DOCKER_USE_SUDO=1
        detect_docker_socket
        return 0
    fi
    return 1
}

detect_docker_socket() {
    local host
    host="$(docker_run context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)"
    if [[ -n "$host" && "$host" != "<no value>" ]]; then
        DOCKER_SOCKET="$host"
    fi
}

systemd_unit_exists() {
    local unit="$1"
    local output
    if systemctl cat "$unit" >/dev/null 2>&1; then
        return 0
    fi
    output="$(systemctl list-unit-files --type=service --no-legend "$unit" 2>/dev/null || true)"
    [[ "$output" == "$unit "* || "$output" == "$unit"$'\t'* ]]
}

detect_docker_systemd_unit() {
    local unit
    for unit in docker.service snap.docker.dockerd.service; do
        if systemd_unit_exists "$unit"; then
            DOCKER_SYSTEMD_UNIT="$unit"
            return 0
        fi
    done
    DOCKER_SYSTEMD_UNIT=""
    return 1
}

docker_group_exists() {
    getent group docker >/dev/null 2>&1
}

docker_repo_distro_family() {
    case "$OS_ID" in
        ubuntu) echo "ubuntu" ;;
        debian) echo "debian" ;;
        alpine) echo "alpine" ;;
        fedora) echo "fedora" ;;
        rhel) echo "rhel" ;;
        centos|centos_stream) echo "centos" ;;
        *)
            if [[ "$OS_LIKE" == *ubuntu* ]]; then
                echo "ubuntu"
            elif [[ "$OS_LIKE" == *debian* ]]; then
                echo "debian"
            elif [[ "$OS_LIKE" == *fedora* ]]; then
                echo "fedora"
            elif [[ "$OS_LIKE" == *rhel* ]] || [[ "$OS_LIKE" == *centos* ]]; then
                echo "rhel"
            else
                echo ""
            fi
            ;;
    esac
}

setup_docker_apt_repository() {
    local repo_distro="$1"
    install_system_packages ca-certificates curl gnupg
    run_privileged_quiet install -m 0755 -d /etc/apt/keyrings
    run_privileged_quiet curl -fsSL "https://download.docker.com/linux/${repo_distro}/gpg" -o /etc/apt/keyrings/docker.asc
    run_privileged_quiet chmod a+r /etc/apt/keyrings/docker.asc
    local codename="$OS_VERSION_CODENAME"
    if [[ -z "$codename" ]] && command_exists lsb_release; then
        codename=$(lsb_release -cs 2>/dev/null || true)
    fi
    [[ -n "$codename" ]] || die "Could not determine distribution codename for Docker apt repository."
    local arch
    arch=$(dpkg --print-architecture)
    run_privileged_quiet tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/${repo_distro}
Suites: ${codename}
Components: stable
Architectures: ${arch}
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    APT_UPDATED=0
}

setup_docker_rpm_repository() {
    local repo_distro="$1"
    ensure_curl_installed
    if command_exists dnf; then
        install_system_packages dnf-plugins-core
    elif command_exists yum; then
        install_system_packages yum-utils
    fi
    run_privileged_quiet curl -fsSL "https://download.docker.com/linux/${repo_distro}/docker-ce.repo" -o /etc/yum.repos.d/docker-ce.repo
}

remove_conflicting_docker_packages() {
    local repo_family="$1"
    case "$repo_family" in
        ubuntu|debian)
            # A package name absent from this distro's indexes makes apt remove
            # fail even on a clean host. Remove only installed conflicts.
            local package
            local installed_conflicts=()
            for package in docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc; do
                if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -qx 'install ok installed'; then
                    installed_conflicts+=("$package")
                fi
            done
            if (( ${#installed_conflicts[@]} > 0 )); then
                run_privileged_quiet apt-get remove -y "${installed_conflicts[@]}"
            fi
            APT_UPDATED=0
            ;;
        fedora|centos|rhel)
            if command_exists dnf; then
                run_privileged_quiet dnf remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine podman runc || true
            elif command_exists yum; then
                run_privileged_quiet yum remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine podman runc || true
            fi
            ;;
    esac
}

install_docker_engine() {
    local repo_family
    repo_family=$(docker_repo_distro_family)
    [[ -n "$repo_family" ]] || die "Automatic Docker installation is supported only on Alpine/Debian/Ubuntu/Fedora/CentOS/RHEL."
    remove_conflicting_docker_packages "$repo_family"
    case "$repo_family" in
        alpine)
            install_system_packages docker docker-cli-compose
            ;;
        ubuntu|debian)
            setup_docker_apt_repository "$repo_family"
            install_system_packages docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
            ;;
        fedora|centos|rhel)
            setup_docker_rpm_repository "$repo_family"
            install_system_packages docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
            ;;
    esac
}

ensure_docker_running() {
    if detect_docker_access; then
        return
    fi
    log "Starting Docker service..."
    if has_systemd; then
        if detect_docker_systemd_unit; then
            if [[ "$DOCKER_SYSTEMD_UNIT" == "docker.service" ]]; then
                run_privileged_quiet systemctl enable --now containerd || true
                run_privileged_quiet systemctl enable --now "$DOCKER_SYSTEMD_UNIT"
            else
                run_privileged_quiet systemctl start "$DOCKER_SYSTEMD_UNIT"
            fi
        else
            run_privileged_quiet systemctl enable --now containerd || true
            run_privileged_quiet systemctl enable --now docker
        fi
    elif has_openrc; then
        run_privileged_quiet rc-update add containerd default || true
        run_privileged_quiet rc-service containerd start || true
        run_privileged_quiet rc-update add docker default || true
        run_privileged_quiet rc-service docker start
    elif command_exists service; then
        run_privileged_quiet service containerd start || true
        run_privileged_quiet service docker start
    fi
    local retries=5
    while [[ "$retries" -gt 0 ]]; do
        if detect_docker_access; then
            return
        fi
        retries=$((retries - 1))
        sleep 2
    done
    die "Docker is installed but the daemon is not reachable. Check ${LOG_FILE} for details."
}

quarantine_legacy_builder_runtime_conflicts() {
    [[ "$DOCKER_MODE" != "builder" ]] || return 0
    local legacy_containerd="/usr/local/bin/containerd"
    local legacy_shim="/usr/local/bin/containerd-shim-runc-v2"
    local legacy_runc="/usr/local/bin/runc"
    [[ -x "$legacy_containerd" && -x "$legacy_shim" && -x "$legacy_runc" ]] || return 0
    "$legacy_containerd" --version 2>/dev/null | grep -Fq " v2.3.4 " || return 0
    "$legacy_shim" -v 2>/dev/null | grep -Fq "v2.3.4" || return 0
    "$legacy_runc" --version 2>/dev/null | grep -Fq "runc version 1.5.1" || return 0

    local archive_dir="${BUILDER_RUNTIME_LEGACY_BIN_DIR}/$(date +%Y%m%d_%H%M%S)"
    install -d -m 0755 "$archive_dir"
    local binary source
    for binary in containerd ctr containerd-shim-runc-v2 buildkitd buildctl runc syft grype; do
        source="/usr/local/bin/${binary}"
        [[ -f "$source" && ! -L "$source" ]] || continue
        mv "$source" "${archive_dir}/${binary}"
    done
    warn "Moved a legacy Gateway builder runtime out of /usr/local/bin to ${archive_dir}."
    if has_systemd; then
        systemctl try-restart containerd >>"$LOG_FILE" 2>&1 || true
        systemctl try-restart docker >>"$LOG_FILE" 2>&1 || true
    elif has_openrc; then
        rc-service containerd restart >>"$LOG_FILE" 2>&1 || true
        rc-service docker restart >>"$LOG_FILE" 2>&1 || true
    fi
}

ensure_docker_installed() {
    [[ "$DOCKER_MODE" != "builder" ]] || return 0
    ensure_curl_installed
    quarantine_legacy_builder_runtime_conflicts
    if ! command_exists docker; then
        log "Docker not found, installing it..."
        install_docker_engine
    fi
    ensure_docker_running
}

check_dependencies() {
    ensure_curl_installed
}

normalize_daemon_version() {
    local version="$1"
    version="${version%-docker}"
    if [[ "$version" != v* ]]; then
        version="v${version}"
    fi
    echo "$version"
}

detect_existing_install() {
    local target="/usr/local/bin/docker-daemon"
    local config_path="/etc/docker-daemon/config.yaml"
    local state_path="/var/lib/docker-daemon/state.json"
    local cert_path="/etc/docker-daemon/certs/node.pem"
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
    local binary_name="docker-daemon-linux-${ARCH}"

    if [[ "$version" == "latest" ]]; then
        log "Resolving latest docker release tag..."
        local latest_tag
        local releases_json
        releases_json=$(curl -fsSL "${RELEASES_API_URL}?component=docker-daemon")
        latest_tag=$(printf '%s' "$releases_json" | grep -o '"tag_name":"v[0-9]*\.[0-9]*\.[0-9]*-docker"' | head -1 | cut -d'"' -f4 || true)
        if [[ -z "$latest_tag" || "$latest_tag" == "null" ]]; then
            die "Could not resolve latest docker release tag from ${RELEASES_API_URL}"
        fi
        log "Resolved tag: ${latest_tag}"
        RESOLVED_DAEMON_VERSION="${latest_tag%-docker}"
        RELEASE_BASE="${ARTIFACT_BASE_URL}/docker-daemon/${latest_tag}"
    else
        RESOLVED_DAEMON_VERSION=$(normalize_daemon_version "$version")
        RELEASE_BASE="${ARTIFACT_BASE_URL}/docker-daemon/${RESOLVED_DAEMON_VERSION}-docker"
    fi

    DOWNLOAD_URL="${RELEASE_BASE}/${binary_name}"
}

# ── Parse Arguments ──────────────────────────────────────────────────
show_help() {
    cat <<'HELP'
Gateway Docker Node Setup — installs docker-daemon and enrolls with Gateway

Usage:
  setup-docker-node.sh [options]

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
  --mode <profile>         Node profile: docker, builder, or databases (default: docker)
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
  GATEWAY_DOCKER_MODE           Same as --mode
  GATEWAY_BUILDER_EGRESS_PROFILE Same as --builder-egress (internet or offline; default: internet)
  GATEWAY_RELEASES_API_URL      Override the Gateway release feed
  GATEWAY_ARTIFACT_BASE_URL     Override the Gateway artifact base URL

Examples:
  # Interactive (prompts for everything):
  sudo bash setup-docker-node.sh

  # Fully non-interactive:
  sudo bash setup-docker-node.sh -y --host gateway.example.com --token gw_node_abc123 --gateway-cert-sha256 sha256:<HEX>

  # Custom daemon user:
  sudo bash setup-docker-node.sh --user dockeruser --gateway gw:9443 --token TOKEN --gateway-cert-sha256 sha256:<HEX>
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
        --mode)           DOCKER_MODE="$2"; shift 2 ;;
        --builder-egress) BUILDER_EGRESS_PROFILE="$2"; shift 2 ;;
        --user)           RUN_USER="$2"; shift 2 ;;
        --no-logo)        NO_LOGO=1; shift ;;
        --dry-run)        DRY_RUN=1; shift ;;
        -y|--yes)         NON_INTERACTIVE=1; NO_LOGO=1; shift ;;
        -h|--help)        show_help ;;
        *) die "Unknown option: $1. Use --help for usage." ;;
    esac
done

[[ -n "$DOCKER_MODE" ]] || DOCKER_MODE="docker"
case "$DOCKER_MODE" in
    docker|builder|databases) ;;
    *) die "Invalid --mode '${DOCKER_MODE}'. Expected docker, builder, or databases." ;;
esac
case "$BUILDER_EGRESS_PROFILE" in
    internet|offline) ;;
    *) die "Invalid --builder-egress '${BUILDER_EGRESS_PROFILE}'. Expected internet or offline." ;;
esac

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

# ── Validate ─────────────────────────────────────────────────────────
need_root
if [[ "$DRY_RUN" -eq 0 ]]; then
    LOG_FILE=$(mktemp /tmp/gateway_docker_setup.XXXXXX) || die "Could not create installer log file"
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

if [[ "$DOCKER_MODE" == "builder" ]]; then
    DOCKER_VER="not required"
elif command_exists docker; then
    DOCKER_VER=$(docker_run version --format '{{.Server.Version}}' 2>/dev/null || echo "unreachable")
else
    DOCKER_VER="not installed"
fi

# ── Logo ─────────────────────────────────────────────────────────────
if [[ "$NO_LOGO" -eq 0 ]]; then
    if [[ "${GATEWAY_SETUP_NO_CLEAR:-0}" != "1" ]] && [ -t 1 ] && command_exists clear; then
        clear
    fi
    show_logo
fi

# ── Interactive configuration ────────────────────────────────────────
if [[ "$NON_INTERACTIVE" -eq 0 ]]; then
    guide_start "${GRAY}This script will:${NC}"
    guide "${GRAY}  1. Download and install the docker-daemon binary${NC}"
    guide "${GRAY}  2. Enroll this node with your Gateway server${NC}"
    guide "${GRAY}  3. Start the daemon as a systemd service${NC}"
    guide "${GRAY}  Docker ${DOCKER_VER} detected.${NC}"
    guide_blank

    if [[ "$EXISTING_ENROLLED" -eq 1 && -n "$EXISTING_GATEWAY_ADDR" && -z "$ENROLL_TOKEN" ]]; then
        log "Existing enrolled docker node detected — reusing current gateway configuration"
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

    select_database_storage
    preflight_database_storage

    [[ "$DOCKER_MODE" == "databases" ]] || guide_blank

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
    select_database_storage
    preflight_database_storage
fi

if [[ "$DOCKER_MODE" == "builder" && "$RUN_USER" != "root" ]]; then
    die "Builder docker-daemon profile must run as root to manage its dedicated BuildKit/containerd runtime."
fi

# ── Resolve run user/group ───────────────────────────────────────────
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

# ── Confirmation ─────────────────────────────────────────────────────
if [[ "$EXISTING_INSTALL" -eq 1 ]]; then
    log "Existing docker-daemon installation detected"
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
summary_row "Docker:      ${DOCKER_VER}"
summary_row "Install ver: ${RESOLVED_DAEMON_VERSION}"
summary_row "Current ver: $([[ "$EXISTING_INSTALL" -eq 1 ]] && echo "${EXISTING_VERSION}" || echo "not installed")"
summary_row "Mode:        $([[ "$EXISTING_INSTALL" -eq 1 ]] && echo "update" || echo "fresh install")"
summary_row "Profile:     ${DOCKER_MODE}"
summary_row "Run as:      ${RUN_USER}:${RUN_GROUP}"
summary_row "Updates:     ${ARTIFACT_BASE_URL}"
summary_end

if ! prompt_yes_no "Proceed with installation?" "Y"; then
    complete_incomplete
    exit 0
fi
guide_blank

dry_run_preview() {
    if command_exists docker; then
        ok "Docker is available (${DOCKER_VER})"
    else
        log "Docker not found, installing it..."
        ok "Docker installed (dry run)"
    fi
    log "Creating required directories..."
    ok "Directories created (dry run)"
    log "Downloading docker-daemon..."
    log "Verifying checksum..."
    ok "Checksum verified (dry run)"
    ok "docker-daemon installed (${RESOLVED_DAEMON_VERSION}; dry run)"
    if [[ "$DOCKER_MODE" == "builder" ]]; then
        log "Downloading pinned Build Worker runtime components..."
        log "Verifying upstream runtime checksums..."
        ok "Builder runtime installed (dry run)"
    fi
    log "Writing config and enrolling with Gateway..."
    ok "Config written to /etc/docker-daemon/config.yaml (dry run)"
    if [[ "$DOCKER_MODE" == "databases" ]]; then
        ok "Database docker profile written (root daemon, storage: ${DATABASE_STORAGE_ROOT}; dry run)"
    elif [[ "$DOCKER_MODE" == "builder" ]]; then
        ok "Builder docker profile written (no Docker socket; dry run)"
    fi
    log "Enabling and starting docker-daemon..."
    ok "docker-daemon is running (dry run)"
    complete_success "Dry run completed successfully — no host changes were made."
}

if [[ "$DRY_RUN" -eq 1 ]]; then
    dry_run_preview
    exit 0
fi

ensure_docker_installed
preflight_database_docker
ensure_builder_system_packages

if [[ "$RUN_USER" != "root" ]]; then
    if docker_group_exists && ! groups "$RUN_USER" 2>/dev/null | grep -qw docker; then
        warn "User '$RUN_USER' is not in the 'docker' group. Adding it now."
        usermod -aG docker "$RUN_USER" >>"$LOG_FILE" 2>&1 || true
    elif ! docker_group_exists; then
        warn "Docker group was not found. docker-daemon will run without SupplementaryGroups=docker."
    fi
fi

# ── Step 1: Create directories ───────────────────────────────────────
create_directories() {
    log "Creating required directories..."
    mkdir -p /etc/docker-daemon/certs
    mkdir -p /var/lib/docker-daemon

    if [[ "$DOCKER_MODE" == "builder" ]]; then
        mkdir -p /etc/gateway-builder /usr/local/lib/gateway-builder
        mkdir -p /var/lib/docker-daemon/builder /run/gateway-builder/buildkit /run/gateway-builder/containerd
        chmod 700 /etc/gateway-builder /usr/local/lib/gateway-builder /var/lib/docker-daemon/builder
    fi

    if [[ "$RUN_USER" != "root" ]]; then
        chown -R "${RUN_USER}:${RUN_GROUP}" /etc/docker-daemon
        chown -R "${RUN_USER}:${RUN_GROUP}" /var/lib/docker-daemon
    fi

    ok "Directories created"
}

# ── Step 2: Download docker-daemon binary ────────────────────────────

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
    local target="/usr/local/bin/docker-daemon"
    local binary_name="docker-daemon-linux-${ARCH}"

    if [[ -f "$target" ]]; then
        local existing_ver
        existing_ver=$("$target" version 2>/dev/null | awk '{print $2}' || echo "unknown")
        if [[ "$RESOLVED_DAEMON_VERSION" == "$existing_ver" ]]; then
            ok "docker-daemon already installed (${existing_ver})"
            return 0
        fi
        log "Upgrading docker-daemon from ${existing_ver} to ${RESOLVED_DAEMON_VERSION}..."
        # Backup existing binary
        local backup="${target}.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$target" "$backup"
        ok "Backed up existing binary to ${backup}"
    else
        log "Downloading docker-daemon..."
    fi

    if download_with_progress "$DOWNLOAD_URL" "${target}.tmp"; then
        verify_checksum "${target}.tmp" "$binary_name"
        mv "${target}.tmp" "$target"
        chmod +x "$target"
        local ver
        ver=$("$target" version 2>/dev/null | awk '{print $2}' || echo "unknown")
        ok "docker-daemon installed (${ver})"
    else
        rm -f "${target}.tmp"
        die "Failed to download docker-daemon ${RESOLVED_DAEMON_VERSION} from releases"
    fi
}

install_builder_runtime() {
    [[ "$DOCKER_MODE" == "builder" ]] || return 0
    local containerd_version="2.3.4"
    local buildkit_version="0.32.2"
    local runc_version="1.5.1"
    local cni_version="1.9.1"
    local syft_version="1.51.0"
    local grype_version="0.117.0"
    local containerd_sha256 buildkit_sha256 runc_sha256 cni_sha256 syft_sha256 grype_sha256
    case "$ARCH" in
        amd64)
            containerd_sha256="9d68969855fbf676cdb8ed758e420fb048d61f984f61de3e53eddfebe484d168"
            buildkit_sha256="2975d0f651ad96ba8b80b9992ae1f9a964f4408569af5b6dc36544165c3926af"
            cni_sha256="b98f74a0f8522f0a83867178729c1aa70f2158f90c45a2ca8fa791db1c76b303"
            syft_sha256="2a2e837a2c8d59ec9af5472ee22d3b04ee463c4e44476ecf993fd1e5ab6ebc7f"
            grype_sha256="38525dab1e06f162ebaa02f94d82d1f807076b011a44180cf2777edf1a7b9c26"
            runc_sha256="177df879d50c913eb205e898d5c1c05a18f574053c0ce5524c471208eaf06f6f"
            ;;
        arm64)
            containerd_sha256="a985fbb7e18fc0362d31a055338f5d7b0e087a3e27f14c70d1c5965399a29f95"
            buildkit_sha256="9e8f46bf309ec0ab262967be5538a4dbe06be756a82621f98253933bac5dcf92"
            cni_sha256="56171987d3947707c3563db2f4001bccaf50fd63468611b9f3cbecb1375ee7ec"
            syft_sha256="6c0466811541ea03add5213a60a1562f0851e4c0b0ecfdee1a694a9455285900"
            grype_sha256="935f628bdf9331ffdd946931ea5fdb50045d3970ba52670cbeb44a88f127291b"
            runc_sha256="ca70e7dbd6616ca782a59b5d3ac86909123fdaa9fa3f89dcf29051c70eee7ce9"
            ;;
        *) die "Builder runtime is supported only on amd64 and arm64 hosts." ;;
    esac

    local staging_dir download_dir
    local installed_manifest="$BUILDER_RUNTIME_MANIFEST"

    if [[ -f "$installed_manifest" ]] \
        && grep -Fqx "format=3" "$installed_manifest" \
        && grep -Fqx "bin_dir=${BUILDER_RUNTIME_BIN_DIR}" "$installed_manifest" \
        && grep -Fqx "architecture=${ARCH}" "$installed_manifest" \
        && grep -Fqx "containerd=${containerd_version}" "$installed_manifest" \
        && grep -Fqx "buildkit=${buildkit_version}" "$installed_manifest" \
        && grep -Fqx "runc=${runc_version}" "$installed_manifest" \
        && grep -Fqx "cni_plugins=${cni_version}" "$installed_manifest" \
        && grep -Fqx "syft=${syft_version}" "$installed_manifest" \
        && grep -Fqx "grype=${grype_version}" "$installed_manifest"; then
        local complete=1 binary plugin
        for binary in containerd ctr containerd-shim-runc-v2 buildkitd buildctl runc syft grype; do
            [[ -f "${BUILDER_RUNTIME_BIN_DIR}/${binary}" && ! -L "${BUILDER_RUNTIME_BIN_DIR}/${binary}" && -x "${BUILDER_RUNTIME_BIN_DIR}/${binary}" ]] || complete=0
        done
        for plugin in bridge host-local firewall loopback; do
            [[ -x "/opt/gateway-builder/cni/bin/${plugin}" ]] || complete=0
        done
        if [[ "$complete" -eq 1 ]]; then
            ok "Builder runtime already installed for ${RESOLVED_DAEMON_VERSION}"
            return 0
        fi
    fi

    staging_dir=$(mktemp -d /tmp/gateway-builder-runtime.XXXXXX)
    download_dir=$(mktemp -d /tmp/gateway-builder-downloads.XXXXXX)
    trap 'rm -rf "$staging_dir" "$download_dir"' RETURN
    install -d -m 0755 "$staging_dir/bin" "$staging_dir/cni/bin" \
        "$download_dir/containerd" "$download_dir/buildkit" "$download_dir/cni" \
        "$download_dir/syft" "$download_dir/grype"

    download_builder_component() {
        local label="$1" url="$2" expected="$3" target="$4"
        log "Downloading ${label}..."
        download_with_progress "$url" "$target" || die "Failed to download ${label} from its official release."
        printf '%s  %s\n' "$expected" "$target" | sha256sum --check --status || \
            die "Checksum verification failed for ${label}."
    }

    download_builder_component "containerd ${containerd_version}" \
        "https://github.com/containerd/containerd/releases/download/v${containerd_version}/containerd-${containerd_version}-linux-${ARCH}.tar.gz" \
        "$containerd_sha256" "$download_dir/containerd.tar.gz"
    download_builder_component "BuildKit ${buildkit_version}" \
        "https://github.com/moby/buildkit/releases/download/v${buildkit_version}/buildkit-v${buildkit_version}.linux-${ARCH}.tar.gz" \
        "$buildkit_sha256" "$download_dir/buildkit.tar.gz"
    download_builder_component "CNI plugins ${cni_version}" \
        "https://github.com/containernetworking/plugins/releases/download/v${cni_version}/cni-plugins-linux-${ARCH}-v${cni_version}.tgz" \
        "$cni_sha256" "$download_dir/cni.tar.gz"
    download_builder_component "Syft ${syft_version}" \
        "https://github.com/anchore/syft/releases/download/v${syft_version}/syft_${syft_version}_linux_${ARCH}.tar.gz" \
        "$syft_sha256" "$download_dir/syft.tar.gz"
    download_builder_component "Grype ${grype_version}" \
        "https://github.com/anchore/grype/releases/download/v${grype_version}/grype_${grype_version}_linux_${ARCH}.tar.gz" \
        "$grype_sha256" "$download_dir/grype.tar.gz"
    download_builder_component "runc ${runc_version}" \
        "https://github.com/opencontainers/runc/releases/download/v${runc_version}/runc.${ARCH}" \
        "$runc_sha256" "$staging_dir/bin/runc"
    chmod 0755 "$staging_dir/bin/runc"

    tar -xzf "$download_dir/containerd.tar.gz" -C "$download_dir/containerd"
    tar -xzf "$download_dir/buildkit.tar.gz" -C "$download_dir/buildkit"
    tar -xzf "$download_dir/cni.tar.gz" -C "$download_dir/cni"
    tar -xzf "$download_dir/syft.tar.gz" -C "$download_dir/syft"
    tar -xzf "$download_dir/grype.tar.gz" -C "$download_dir/grype"

    local binary plugin
    for binary in containerd ctr containerd-shim-runc-v2; do
        install -m 0755 "$download_dir/containerd/bin/${binary}" "$staging_dir/bin/${binary}"
    done
    for binary in buildkitd buildctl; do
        install -m 0755 "$download_dir/buildkit/bin/${binary}" "$staging_dir/bin/${binary}"
    done
    install -m 0755 "$download_dir/syft/syft" "$staging_dir/bin/syft"
    install -m 0755 "$download_dir/grype/grype" "$staging_dir/bin/grype"
    for plugin in bridge host-local firewall loopback; do
        install -m 0755 "$download_dir/cni/${plugin}" "$staging_dir/cni/bin/${plugin}"
    done

    printf '%s\n' \
        "format=3" \
        "bin_dir=${BUILDER_RUNTIME_BIN_DIR}" \
        "architecture=${ARCH}" \
        "containerd=${containerd_version}" \
        "buildkit=${buildkit_version}" \
        "runc=${runc_version}" \
        "cni_plugins=${cni_version}" \
        "syft=${syft_version}" \
        "grype=${grype_version}" \
        > "$staging_dir/runtime-manifest"

    for binary in containerd ctr containerd-shim-runc-v2 buildkitd buildctl runc syft grype; do
        [[ -f "${staging_dir}/bin/${binary}" && ! -L "${staging_dir}/bin/${binary}" && -x "${staging_dir}/bin/${binary}" ]] || \
            die "Builder runtime staging is missing regular executable bin/${binary}."
    done
    for plugin in bridge host-local firewall loopback; do
        [[ -f "${staging_dir}/cni/bin/${plugin}" && ! -L "${staging_dir}/cni/bin/${plugin}" && -x "${staging_dir}/cni/bin/${plugin}" ]] || \
            die "Builder runtime staging is missing regular CNI plugin ${plugin}."
    done
    [[ -f "${staging_dir}/runtime-manifest" && ! -L "${staging_dir}/runtime-manifest" ]] || die "Builder runtime staging has no regular manifest."

    local legacy_manifest="${installed_manifest}.previous"
    rm -f "$legacy_manifest"
    if [[ -f "$installed_manifest" ]] && grep -Fqx "format=2" "$installed_manifest"; then
        cp -p "$installed_manifest" "$legacy_manifest"
    fi

    install -d -m 0755 "$BUILDER_RUNTIME_BIN_DIR" /opt/gateway-builder/cni/bin
    for binary in containerd ctr containerd-shim-runc-v2 buildkitd buildctl runc syft grype; do
        install -m 0755 "${staging_dir}/bin/${binary}" "${BUILDER_RUNTIME_BIN_DIR}/${binary}"
    done
    for plugin in bridge host-local firewall loopback; do
        install -m 0755 "${staging_dir}/cni/bin/${plugin}" "/opt/gateway-builder/cni/bin/${plugin}"
    done
    install -m 0644 "${staging_dir}/runtime-manifest" "$installed_manifest"

    if [[ -f "$installed_manifest" ]] && grep -Fqx "format=3" "$installed_manifest"; then
        if [[ -f "$legacy_manifest" ]] && grep -Fqx "format=2" "$legacy_manifest"; then
            install -d -m 0755 "$BUILDER_RUNTIME_LEGACY_BIN_DIR"
            for binary in containerd ctr containerd-shim-runc-v2 buildkitd buildctl runc syft grype; do
                local legacy_path="/usr/local/bin/${binary}"
                local archived_path="${BUILDER_RUNTIME_LEGACY_BIN_DIR}/${binary}.format-2"
                [[ -f "$legacy_path" && ! -L "$legacy_path" ]] || continue
                if [[ "$(sha256sum "$legacy_path" | awk '{print $1}')" == "$(sha256sum "${BUILDER_RUNTIME_BIN_DIR}/${binary}" | awk '{print $1}')" ]]; then
                    if [[ -e "$archived_path" ]]; then
                        archived_path="${archived_path}.$(date +%Y%m%d_%H%M%S)"
                    fi
                    mv -f "$legacy_path" "$archived_path"
                    warn "Moved legacy Gateway builder binary ${legacy_path} to ${archived_path}."
                else
                    warn "Left modified legacy builder path ${legacy_path} untouched; remove it manually if it shadows a system binary."
                fi
            done
        fi
        rm -f "$legacy_manifest"
    fi
    rm -rf "$staging_dir" "$download_dir"
    trap - RETURN
    ok "Builder runtime installed for ${RESOLVED_DAEMON_VERSION}"
}

setup_secure_runtime() {
    [[ "$DOCKER_MODE" == "docker" ]] || return 0
    [[ "$EXISTING_INSTALL" -eq 0 ]] || return 0
    local target="/usr/local/bin/docker-daemon"
    local preflight_status=0
    set +e
    "$target" runtime preflight runsc --silent
    preflight_status=$?
    set -e

    case "$preflight_status" in
        0)
            ok "Secure Runtime is ready"
            return 0
            ;;
        10)
            log "Installing Secure Runtime..."
            if "$target" runtime install runsc --non-interactive; then
                ok "Secure Runtime installed and verified"
                return 0
            fi
            warn "Secure Runtime setup failed on this node."
            ;;
        20)
            warn "Current node does not support Secure Runtimes."
            ;;
        *)
            warn "Secure Runtime compatibility could not be verified on this node."
            ;;
    esac

    local continue_default="N"
    [[ "$NON_INTERACTIVE" -eq 1 ]] && continue_default="Y"
    if ! prompt_yes_no "Continue without Secure Runtimes?" "$continue_default"; then
        complete_incomplete
        exit 0
    fi
}

write_database_profile_config() {
    [[ "$DOCKER_MODE" == "databases" ]] || return 0
    [[ "$RUN_USER" == "root" ]] || die "Database docker-daemon profile must run as root."
    [[ -n "$DATABASE_STORAGE_ROOT" && "$DATABASE_STORAGE_ROOT" == /* && "$DATABASE_STORAGE_ROOT" != "/" ]] || die "Database storage root is invalid."
    [[ "$DATABASE_STORAGE_ROOT" =~ ^[A-Za-z0-9._/@+-]+$ ]] || die "Database storage root contains unsupported characters."

    local config_path="/etc/docker-daemon/config.yaml"
    [[ -f "$config_path" ]] || die "docker-daemon config was not created by enrollment."
    grep -q '^docker:$' "$config_path" || die "docker-daemon config has no docker section."

    local has_mode=0
    local has_storage_root=0
    grep -q '^  mode:' "$config_path" && has_mode=1
    grep -q '^    storage_root:' "$config_path" && has_storage_root=1
    if [[ "$has_mode" -eq 1 || "$has_storage_root" -eq 1 ]]; then
        grep -q '^  mode: "databases"$' "$config_path" || die "Refusing to overwrite an existing docker profile."
        grep -q "^    storage_root: \"${DATABASE_STORAGE_ROOT}\"$" "$config_path" || die "Refusing to overwrite an existing database storage root."
        chmod 600 "$config_path"
        ok "Database docker profile already configured (root daemon, storage: ${DATABASE_STORAGE_ROOT})"
        return 0
    fi

    if grep -q '^  database:$' "$config_path"; then
        die "Database config section exists without a storage_root."
    else
        local tmp_config="${config_path}.tmp.$$"
        awk -v root="$DATABASE_STORAGE_ROOT" '
            $0 == "docker:" {
                print
                print "  mode: \"databases\""
                print "  database:"
                print "    storage_root: \"" root "\""
                inserted = 1
                next
            }
            { print }
            END { if (!inserted) exit 1 }
        ' "$config_path" > "$tmp_config" || { rm -f "$tmp_config"; die "Could not write database docker profile."; }
        chmod 600 "$tmp_config"
        mv -f "$tmp_config" "$config_path"
    fi
    chmod 600 "$config_path"
    ok "Database docker profile written (root daemon, storage: ${DATABASE_STORAGE_ROOT})"
}

write_builder_profile_config() {
    [[ "$DOCKER_MODE" == "builder" ]] || return 0
    [[ "$RUN_USER" == "root" ]] || die "Builder docker-daemon profile must run as root."
    local config_path="${1:-/etc/docker-daemon/config.yaml}"
    [[ -f "$config_path" ]] || die "docker-daemon config was not created by enrollment."
    grep -q '^docker:$' "$config_path" || die "docker-daemon config has no docker section."
    grep -Eq '^[[:space:]]+mode:[[:space:]]*"?builder"?[[:space:]]*$' "$config_path" || die "Refusing a builder profile without docker.mode=builder."
    if grep -Eq '^[[:space:]]+(socket|allowlist):' "$config_path"; then
        die "Builder profile must not contain Docker socket or allowlist access."
    fi
    local tmp_config="${config_path}.tmp.$$"
    awk -v profile="$BUILDER_EGRESS_PROFILE" '
        $0 == "docker:" {
            print "docker:"
            print "  mode: \"builder\""
            print "  builder:"
            print "    egress_profile: \"" profile "\""
            rewriting = 1
            replaced = 1
            next
        }
        rewriting {
            # Remove the malformed top-level lines emitted by Gateway v2.9.6,
            # as well as the previous nested docker section.
            if ($0 ~ /^builder:[[:space:]]*$/ || $0 ~ /^[[:space:]]*egress_profile:/) next
            if ($0 ~ /^[^[:space:]]/) {
                rewriting = 0
                print
            }
            next
        }
        { print }
        END { if (!replaced) exit 1 }
    ' "$config_path" > "$tmp_config" || { rm -f "$tmp_config"; die "Could not write builder docker profile."; }
    chmod 600 "$tmp_config"
    mv -f "$tmp_config" "$config_path"
    chmod 600 "$config_path"
    ok "Builder docker profile written without Docker Engine access (egress: ${BUILDER_EGRESS_PROFILE})"
}

# ── Step 3: Install and enroll ───────────────────────────────────────
enroll_daemon() {
    local target="/usr/local/bin/docker-daemon"

    # Check if already enrolled (certs exist)
    if [[ -f /etc/docker-daemon/certs/node.pem && -f /var/lib/docker-daemon/state.json ]]; then
        ok "Node already enrolled — skipping enrollment"
        return 0
    fi

    log "Writing config and enrolling with Gateway..."
    if [[ "$DOCKER_MODE" == "builder" ]]; then
        if ! "$target" install --gateway "$GATEWAY_ADDR" --token "$ENROLL_TOKEN" --gateway-cert-sha256 "$GATEWAY_CERT_SHA256" --mode builder >> "$LOG_FILE" 2>&1; then
            die "Failed to enroll builder docker-daemon. Check ${LOG_FILE} for details."
        fi
    elif ! "$target" install --gateway "$GATEWAY_ADDR" --token "$ENROLL_TOKEN" --gateway-cert-sha256 "$GATEWAY_CERT_SHA256" --docker-socket "$DOCKER_SOCKET" >> "$LOG_FILE" 2>&1; then
        die "Failed to enroll docker-daemon. Check ${LOG_FILE} for details."
    fi
    ok "Config written to /etc/docker-daemon/config.yaml"
}

# ── Step 4: Start the daemon ─────────────────────────────────────────
start_daemon() {
    retire_legacy_update_guard "docker-daemon" "/usr/local/bin/docker-daemon"
    log "Enabling and starting docker-daemon..."

    if has_systemd; then
        detect_docker_systemd_unit || true
        local docker_after="network-online.target"
        local docker_wants="network-online.target"
        local supplementary_groups=""
        local service_environment=""
        if [[ "$DOCKER_MODE" != "builder" && -n "$DOCKER_SYSTEMD_UNIT" ]]; then
            docker_after="${docker_after} ${DOCKER_SYSTEMD_UNIT}"
            docker_wants="${docker_wants} ${DOCKER_SYSTEMD_UNIT}"
        elif [[ "$DOCKER_MODE" != "builder" ]] && detect_docker_access; then
            warn "Docker is reachable, but no systemd Docker unit was detected. docker-daemon will start without a Docker service dependency."
        elif [[ "$DOCKER_MODE" != "builder" ]]; then
            warn "No systemd Docker unit was detected. docker-daemon will start without a Docker service dependency."
        fi
        if [[ "$DOCKER_MODE" != "builder" ]] && docker_group_exists; then
            supplementary_groups="SupplementaryGroups=docker"
        elif [[ "$DOCKER_MODE" == "builder" ]]; then
            service_environment="Environment=\"PATH=${BUILDER_RUNTIME_PATH}\""
        fi

        if ! cat > /etc/systemd/system/docker-daemon.service <<UNIT
[Unit]
Description=Gateway Docker Daemon
After=${docker_after}
Wants=${docker_wants}

[Service]
Type=simple
User=${RUN_USER}
Group=${RUN_GROUP}
ExecStart=/usr/local/bin/docker-daemon run
Restart=always
RestartSec=5
LimitNOFILE=65536
${supplementary_groups}
${service_environment}

[Install]
WantedBy=multi-user.target
UNIT
        then
            warn "Could not write the docker-daemon systemd unit; using manual mode."
            manual_launcher_fallback "docker-daemon" "/usr/local/bin/docker-daemon" "/var/lib/docker-daemon"
            return 0
        fi

        if ! systemctl daemon-reload >> "$LOG_FILE" 2>&1; then
            warn "systemd daemon-reload failed; using manual mode."
            manual_launcher_fallback "docker-daemon" "/usr/local/bin/docker-daemon" "/var/lib/docker-daemon"
            return 0
        fi
        if ! systemctl enable docker-daemon >> "$LOG_FILE" 2>&1; then
            warn "Could not enable docker-daemon; using manual mode."
            manual_launcher_fallback "docker-daemon" "/usr/local/bin/docker-daemon" "/var/lib/docker-daemon"
            return 0
        fi
        if ! systemctl restart docker-daemon >> "$LOG_FILE" 2>&1; then
            warn "Could not start or restart docker-daemon; using manual mode."
            manual_launcher_fallback "docker-daemon" "/usr/local/bin/docker-daemon" "/var/lib/docker-daemon"
            return 0
        fi
        sleep 2

        if systemctl is-active --quiet docker-daemon; then
            ok "docker-daemon is running"
        else
            warn "docker-daemon is not active; using manual mode."
            manual_launcher_fallback "docker-daemon" "/usr/local/bin/docker-daemon" "/var/lib/docker-daemon"
        fi
    elif has_openrc; then
        local openrc_need="net docker"
        [[ "$DOCKER_MODE" != "builder" ]] || openrc_need="net"
        if ! cat > /etc/init.d/docker-daemon <<UNIT
#!/sbin/openrc-run
name="Gateway Docker Daemon"
description="Gateway Docker Daemon"
command="/usr/local/bin/docker-daemon"
command_args="run"
command_user="${RUN_USER}:${RUN_GROUP}"
pidfile="/run/\${RC_SVCNAME}.pid"
supervisor="supervise-daemon"
respawn_delay=5
output_log="/var/log/docker-daemon.log"
error_log="/var/log/docker-daemon.err"

depend() {
    need ${openrc_need}
}
UNIT
        then
            warn "Could not write the docker-daemon OpenRC service; using manual mode."
            manual_launcher_fallback "docker-daemon" "/usr/local/bin/docker-daemon" "/var/lib/docker-daemon"
            return 0
        fi
        if ! chmod +x /etc/init.d/docker-daemon; then
            warn "Could not make the docker-daemon OpenRC service executable; using manual mode."
            manual_launcher_fallback "docker-daemon" "/usr/local/bin/docker-daemon" "/var/lib/docker-daemon"
            return 0
        fi
        if ! rc-update add docker-daemon default >> "$LOG_FILE" 2>&1; then
            warn "Could not enable docker-daemon in OpenRC; using manual mode."
            manual_launcher_fallback "docker-daemon" "/usr/local/bin/docker-daemon" "/var/lib/docker-daemon"
            return 0
        fi
        if ! rc-service docker-daemon restart >> "$LOG_FILE" 2>&1; then
            if ! rc-service docker-daemon start >> "$LOG_FILE" 2>&1; then
                warn "Could not start docker-daemon in OpenRC; using manual mode."
                manual_launcher_fallback "docker-daemon" "/usr/local/bin/docker-daemon" "/var/lib/docker-daemon"
                return 0
            fi
        fi
        sleep 2

        if rc-service docker-daemon status >> "$LOG_FILE" 2>&1; then
            ok "docker-daemon is running"
        else
            warn "docker-daemon is not active in OpenRC; using manual mode."
            manual_launcher_fallback "docker-daemon" "/usr/local/bin/docker-daemon" "/var/lib/docker-daemon"
        fi
    else
        warn "No supported service manager found; using manual mode."
        manual_launcher_fallback "docker-daemon" "/usr/local/bin/docker-daemon" "/var/lib/docker-daemon"
    fi
}

# ── Run ──────────────────────────────────────────────────────────────
create_directories
install_daemon
install_builder_runtime
preflight_builder_runtime
setup_secure_runtime
enroll_daemon
write_database_profile_config
write_builder_profile_config
start_daemon

echo ""
echo ""
echo -e "  The node should appear as ${GREEN}online${NC} in Gateway within a few seconds."
if [[ "$MANUAL_FALLBACK_USED" -eq 1 ]]; then
    echo -e "  Manual mode is not persistent across reboot."
elif has_systemd; then
    echo -e "  Check status:  ${BRAND_MINT}systemctl status docker-daemon${NC}"
    echo -e "  View logs:     ${BRAND_MINT}journalctl -u docker-daemon -f${NC}"
elif has_openrc; then
    echo -e "  Check status:  ${BRAND_MINT}rc-service docker-daemon status${NC}"
    echo -e "  View logs:     ${BRAND_MINT}tail -f /var/log/docker-daemon.log${NC}"
else
    echo -e "  Start daemon:  ${BRAND_MINT}docker-daemon run${NC}"
fi
complete_success
