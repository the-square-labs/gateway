#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# ── Gateway Docker Node Setup ────────────────────────────────────────
# Installs docker-daemon on a host and enrolls it with the Gateway.
#
# Usage:
#   curl -sSL https://gitlab.wiolett.net/wiolett/gateway/-/raw/main/scripts/setup-docker-node.sh | \
#     sudo bash -s -- --gateway gateway.example.com:9443 --token <ENROLLMENT_TOKEN> --gateway-cert-sha256 sha256:<HEX>
#
# Or download and run:
#   bash setup-docker-node.sh --gateway gateway.example.com:9443 --token <TOKEN> --gateway-cert-sha256 sha256:<HEX>
# ──────────────────────────────────────────────────────────────────────

LOG_FILE="/tmp/gateway_docker_setup.log"

# ── Colors ───────────────────────────────────────────────────────────
BRAND_MINT='\033[38;2;140;176;132m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
GRAY='\033[0;90m'
NC='\033[0m'
BOLD='\033[1m'
TITLE_TAG='\033[48;2;140;176;132m\033[30m'
INFO_TAG='\033[47m\033[90m'
WARN_TAG='\033[43m\033[30m'
ERROR_TAG='\033[41m\033[97m'
SUCCESS_TAG='\033[42m\033[97m'

# ── Defaults ─────────────────────────────────────────────────────────
GATEWAY_HOST="${GATEWAY_NODE_HOST:-}"
GATEWAY_PORT="${GATEWAY_NODE_PORT:-9443}"
GATEWAY_ADDR="${GATEWAY_NODE_ADDRESS:-}"
ENROLL_TOKEN="${GATEWAY_NODE_TOKEN:-}"
GATEWAY_CERT_SHA256="${GATEWAY_NODE_CERT_SHA256:-}"
DAEMON_VERSION="${GATEWAY_NODE_DAEMON_VERSION:-latest}"
GITLAB_URL="${GATEWAY_GITLAB_URL:-https://gitlab.wiolett.net}"
GITLAB_PROJECT="${GATEWAY_GITLAB_PROJECT:-wiolett/gateway}"
RUN_USER=""
NON_INTERACTIVE=0
NO_LOGO=0
APT_UPDATED=0
OS_VERSION_CODENAME=""
DOCKER_USE_SUDO=0
DOCKER_SYSTEMD_UNIT=""
DOCKER_SOCKET="unix:///var/run/docker.sock"
DOCKER_MODE="${GATEWAY_DOCKER_MODE:-}"
DATABASE_STORAGE_ROOT="${GATEWAY_DATABASE_STORAGE_ROOT:-}"
RESOLVED_DAEMON_VERSION=""
EXISTING_INSTALL=0
EXISTING_VERSION=""
EXISTING_GATEWAY_ADDR=""
EXISTING_ENROLLED=0

# ── Helpers ──────────────────────────────────────────────────────────
log()  { echo -e "${INFO_TAG} INFO ${NC} $*"; }
warn() { echo -e "${WARN_TAG} WARN ${NC} $*"; }
err()  { echo -e "${ERROR_TAG} ERROR ${NC} $*" >&2; }
ok()   { echo -e "${SUCCESS_TAG} OK ${NC} $*"; }

die() { err "$@"; exit 1; }

show_logo() {
    echo ""
    echo '░██       ░██ ░██           ░██               ░██       ░██    '
    echo '░██       ░██               ░██               ░██       ░██    '
    echo '░██  ░██  ░██ ░██ ░███████  ░██  ░███████  ░████████ ░████████ '
    echo '░██ ░████ ░██ ░██░██    ░██ ░██ ░██    ░██    ░██       ░██    '
    echo '░██░██ ░██░██ ░██░██    ░██ ░██ ░█████████    ░██       ░██    '
    echo '░████   ░████ ░██░██    ░██ ░██ ░██           ░██       ░██    '
    echo '░███     ░███ ░██ ░███████  ░██  ░███████      ░████     ░████ '
    echo ""
    echo -e "${BRAND_MINT}░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░${NC}"
    echo -e "${BRAND_MINT}░░░█▀▀░█▀█░▀█▀░█▀▀░█░█░█▀█░█░█░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░${NC}"
    echo -e "${BRAND_MINT}░░░█░█░█▀█░░█░░█▀▀░█▄█░█▀█░░█░░░░▀░▀░▀░▀░▀░▀░▀░▀░▀░▀░▀░▀░▀░░░░${NC}"
    echo -e "${BRAND_MINT}░░░▀▀▀░▀░▀░░▀░░▀▀▀░▀░▀░▀░▀░░▀░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░${NC}"
    echo -e "${BRAND_MINT}░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░${NC}"
    echo ""
}

title() { echo ""; echo -e "${TITLE_TAG} $1 ${NC}"; echo ""; }

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
            read -r -p "$(echo -e "  ${BRAND_MINT}${prompt} [${default}]: ${NC}")" result < /dev/tty
        else
            read -r -p "$(echo -e "  ${BRAND_MINT}${prompt}: ${NC}")" result < /dev/tty
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
        read -rs -p "$(echo -e "  ${BRAND_MINT}${prompt}: ${NC}")" result < /dev/tty
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
            read -r -p "$(echo -e "  ${BRAND_MINT}${prompt} [Y/n]: ${NC}")" reply < /dev/tty
            reply="${reply:-Y}"
        else
            read -r -p "$(echo -e "  ${BRAND_MINT}${prompt} [y/N]: ${NC}")" reply < /dev/tty
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
    local reply
    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        echo "$default"
        return
    fi
    if [ -e /dev/tty ]; then
        read -r -p "$(echo -e "  ${BRAND_MINT}${prompt} [${default}]: ${NC}")" reply < /dev/tty
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
has_systemd() { command_exists systemctl; }
has_openrc() { command_exists rc-service && command_exists rc-update; }

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
            run_privileged_quiet apt remove -y docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc || true
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
    [[ -n "$repo_family" ]] || die "Automatic Docker installation is supported only on Debian/Ubuntu/Fedora/CentOS/RHEL."
    remove_conflicting_docker_packages "$repo_family"
    case "$repo_family" in
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

ensure_docker_installed() {
    ensure_curl_installed
    if ! command_exists docker; then
        log "Docker not found, installing it..."
        install_docker_engine
    fi
    ensure_docker_running
}

check_dependencies() {
    ensure_curl_installed
}

build_gitlab_api() {
    local encoded_project="${GITLAB_PROJECT//\//%2F}"
    GITLAB_API="${GITLAB_URL}/api/v4/projects/${encoded_project}"
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
        releases_json=$(curl -fsSL "${GITLAB_API}/releases")
        latest_tag=$(printf '%s' "$releases_json" | grep -o '"tag_name":"v[0-9]*\.[0-9]*\.[0-9]*-docker"' | head -1 | cut -d'"' -f4 || true)
        if [[ -z "$latest_tag" || "$latest_tag" == "null" ]]; then
            die "Could not resolve latest docker release tag from ${GITLAB_API}/releases"
        fi
        log "Resolved tag: ${latest_tag}"
        RESOLVED_DAEMON_VERSION="${latest_tag%-docker}"
        RELEASE_BASE="${GITLAB_API}/releases/${latest_tag}/downloads"
    else
        RESOLVED_DAEMON_VERSION=$(normalize_daemon_version "$version")
        RELEASE_BASE="${GITLAB_API}/releases/${RESOLVED_DAEMON_VERSION}-docker/downloads"
    fi

    DOWNLOAD_URL="${RELEASE_BASE}/${binary_name}"
}

# ── Parse Arguments ──────────────────────────────────────────────────
show_help() {
    cat <<'HELP'
Gateway Docker Node Setup — installs docker-daemon and enrolls with Gateway

Usage:
  setup-docker-node.sh [options]

  In interactive mode (default), the script prompts for gateway address, port,
  enrollment token, and Gateway certificate fingerprint. Use flags to pre-fill or skip prompts.

Options:
  --gateway <addr>         Gateway gRPC address as host:port (e.g. gateway.example.com:9443)
  --host <host>            Gateway hostname or IP (e.g. gateway.example.com)
  --port <port>            Gateway gRPC port (default: 9443)
  --token <token>          Enrollment token from Gateway UI (Admin > Nodes > Add Node)
  --gateway-cert-sha256 <fp>
                           Gateway gRPC TLS leaf fingerprint from the generated setup command
  --version <ver>          Daemon version to install (default: latest)
  --user <user>            Run daemon as this user (default: root)
  --gitlab-url <url>       GitLab instance URL (default: https://gitlab.wiolett.net)
  --gitlab-project <proj>  GitLab project path (default: wiolett/gateway)
  --no-logo                Suppress the logo banner
  -y, --yes                Non-interactive mode (no prompts, all values required via flags)
  -h, --help               Show this help

Environment variables:
  GATEWAY_NODE_HOST             Same as --host
  GATEWAY_NODE_PORT             Same as --port (default: 9443)
  GATEWAY_NODE_ADDRESS          Same as --gateway (host:port combined)
  GATEWAY_NODE_TOKEN            Same as --token
  GATEWAY_NODE_CERT_SHA256      Same as --gateway-cert-sha256
  GATEWAY_NODE_DAEMON_VERSION   Same as --version
  GATEWAY_GITLAB_URL            Same as --gitlab-url
  GATEWAY_GITLAB_PROJECT        Same as --gitlab-project

Examples:
  # Interactive (prompts for everything):
  sudo bash setup-docker-node.sh

  # Fully non-interactive:
  sudo bash setup-docker-node.sh -y --host gateway.example.com --token gw_node_abc123 --gateway-cert-sha256 sha256:<HEX>

  # Custom GitLab and user:
  sudo bash setup-docker-node.sh --gitlab-url https://git.example.com --user dockeruser --gateway gw:9443 --token TOKEN --gateway-cert-sha256 sha256:<HEX>
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
        --gitlab-url)     GITLAB_URL="$2"; shift 2 ;;
        --gitlab-project) GITLAB_PROJECT="$2"; shift 2 ;;
        --no-logo)        NO_LOGO=1; shift ;;
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

: > "$LOG_FILE"

ensure_docker_installed
DOCKER_VER=$(docker_run version --format '{{.Server.Version}}' 2>/dev/null || echo "unknown")

# ── Logo ─────────────────────────────────────────────────────────────
if [[ "$NO_LOGO" -eq 0 ]]; then
    if [ -t 1 ] && command_exists clear; then
        clear
    fi
    show_logo
    title "Gateway Docker Node Setup"
fi

# ── Interactive configuration ────────────────────────────────────────
if [[ "$NON_INTERACTIVE" -eq 0 ]]; then
    echo -e "  ${GRAY}This script will:${NC}"
    echo -e "  ${GRAY}  1. Download and install the docker-daemon binary${NC}"
    echo -e "  ${GRAY}  2. Enroll this node with your Gateway server${NC}"
    echo -e "  ${GRAY}  3. Start the daemon as a systemd service${NC}"
    echo -e "  ${GRAY}  Docker ${DOCKER_VER} detected.${NC}"
    echo ""

    if [[ "$EXISTING_ENROLLED" -eq 1 && -n "$EXISTING_GATEWAY_ADDR" && -z "$ENROLL_TOKEN" ]]; then
        log "Existing enrolled docker node detected — reusing current gateway configuration"
    else
        # Gateway host
        if [[ -z "$GATEWAY_HOST" ]]; then
            GATEWAY_HOST=$(prompt_input "Gateway hostname or IP" "")
            [[ -z "$GATEWAY_HOST" ]] && die "Gateway hostname is required"
        else
            echo -e "  ${GRAY}Gateway host: ${BRAND_MINT}${GATEWAY_HOST}${NC}"
        fi

        # Gateway port
        GATEWAY_PORT=$(prompt_input "gRPC port" "${GATEWAY_PORT}")
        [[ -z "$GATEWAY_PORT" ]] && GATEWAY_PORT="9443"

        GATEWAY_ADDR="${GATEWAY_HOST}:${GATEWAY_PORT}"

        echo ""

        # Enrollment token
        if [[ -z "$ENROLL_TOKEN" ]]; then
            ENROLL_TOKEN=$(prompt_secret "Enrollment token (from Admin > Nodes)")
            [[ -z "$ENROLL_TOKEN" ]] && die "Enrollment token is required"
        else
            echo -e "  ${GRAY}Token: ${ENROLL_TOKEN:0:12}...${ENROLL_TOKEN: -4}${NC}"
        fi

        if [[ -z "$GATEWAY_CERT_SHA256" ]]; then
            GATEWAY_CERT_SHA256=$(prompt_input "Gateway certificate SHA-256 fingerprint" "")
            [[ -z "$GATEWAY_CERT_SHA256" ]] && die "Gateway certificate SHA-256 fingerprint is required"
        else
            echo -e "  ${GRAY}Gateway cert: ${GATEWAY_CERT_SHA256}${NC}"
        fi

        echo ""
    fi

    # Daemon version
    DAEMON_VERSION=$(prompt_input "Daemon version" "${DAEMON_VERSION}")

    echo ""

    # User selection
    if [[ -z "$RUN_USER" ]]; then
        echo -e "  ${GRAY}Run daemon as:${NC}"
        echo -e "    ${BRAND_MINT}1)${NC} root  ${GRAY}[default]${NC}"
        echo -e "    ${BRAND_MINT}2)${NC} Current user ($(logname 2>/dev/null || echo "$SUDO_USER"))"
        echo -e "    ${BRAND_MINT}3)${NC} Custom user"
        echo ""
        user_choice=$(prompt_choice "Choose" "1")
        case "$user_choice" in
            1|root)   RUN_USER="root" ;;
            2)        RUN_USER="$(logname 2>/dev/null || echo "${SUDO_USER:-root}")" ;;
            3)        RUN_USER=$(prompt_input "Username" ""); [[ -z "$RUN_USER" ]] && die "Username is required" ;;
            *)        RUN_USER="root" ;;
        esac
        echo ""
    fi
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

# ── Resolve run user/group ───────────────────────────────────────────
RUN_GROUP=""
if [[ "$RUN_USER" == "root" ]]; then
    RUN_GROUP="root"
else
    if ! id "$RUN_USER" &>/dev/null; then
        die "User '$RUN_USER' does not exist. Create it first or choose a different user."
    fi
    RUN_GROUP=$(id -gn "$RUN_USER" 2>/dev/null)
    if docker_group_exists && ! groups "$RUN_USER" 2>/dev/null | grep -qw docker; then
        warn "User '$RUN_USER' is not in the 'docker' group. Adding it now."
        usermod -aG docker "$RUN_USER" >>"$LOG_FILE" 2>&1 || true
    elif ! docker_group_exists; then
        warn "Docker group was not found. docker-daemon will run without SupplementaryGroups=docker."
    fi
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

echo -e "  ${BOLD}Configuration Summary${NC}"
echo -e "  ${GRAY}────────────────────────────────────────${NC}"
echo -e "  Gateway:     ${BRAND_MINT}${GATEWAY_ADDR}${NC}"
if [[ -n "$ENROLL_TOKEN" ]]; then
    echo -e "  Token:       ${GRAY}${ENROLL_TOKEN:0:12}...${NC}"
else
    echo -e "  Token:       ${GRAY}existing enrollment${NC}"
fi
if [[ -n "$GATEWAY_CERT_SHA256" ]]; then
    echo -e "  Cert SHA256: ${GRAY}${GATEWAY_CERT_SHA256}${NC}"
else
    echo -e "  Cert SHA256: ${GRAY}existing enrollment${NC}"
fi
echo -e "  Arch:        ${ARCH}"
echo -e "  OS:          ${OS_ID}"
echo -e "  Docker:      ${DOCKER_VER}"
echo -e "  Install ver: ${RESOLVED_DAEMON_VERSION}"
echo -e "  Current ver: $([[ "$EXISTING_INSTALL" -eq 1 ]] && echo "${EXISTING_VERSION}" || echo "not installed")"
echo -e "  Mode:        $([[ "$EXISTING_INSTALL" -eq 1 ]] && echo "update" || echo "fresh install")"
echo -e "  Run as:      ${RUN_USER}:${RUN_GROUP}"
echo -e "  GitLab:      ${GITLAB_URL}"
echo -e "  ${GRAY}────────────────────────────────────────${NC}"
echo ""

if ! prompt_yes_no "Proceed with installation?" "Y"; then
    echo "  Aborted."
    exit 0
fi
echo ""

# ── Step 1: Create directories ───────────────────────────────────────
create_directories() {
    log "Creating required directories..."
    mkdir -p /etc/docker-daemon/certs
    mkdir -p /var/lib/docker-daemon

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

    if curl -fsSL "$DOWNLOAD_URL" -o "${target}.tmp" >> "$LOG_FILE" 2>&1; then
        verify_checksum "${target}.tmp" "$binary_name"
        mv "${target}.tmp" "$target"
        chmod +x "$target"
        local ver
        ver=$("$target" version 2>/dev/null | awk '{print $2}' || echo "unknown")
        ok "docker-daemon installed (${ver})"
    else
        rm -f "${target}.tmp"
        warn "Failed to download from releases — you may need to install the binary manually"
        warn "Place the docker-daemon binary at ${target}"

        if [[ ! -f "$target" ]]; then
            die "docker-daemon binary not found at ${target}"
        fi
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

# ── Step 3: Install and enroll ───────────────────────────────────────
enroll_daemon() {
    local target="/usr/local/bin/docker-daemon"

    # Check if already enrolled (certs exist)
    if [[ -f /etc/docker-daemon/certs/node.pem && -f /var/lib/docker-daemon/state.json ]]; then
        ok "Node already enrolled — skipping enrollment"
        return 0
    fi

    log "Writing config and enrolling with Gateway..."
    "$target" install --gateway "$GATEWAY_ADDR" --token "$ENROLL_TOKEN" --gateway-cert-sha256 "$GATEWAY_CERT_SHA256" --docker-socket "$DOCKER_SOCKET"
    ok "Config written to /etc/docker-daemon/config.yaml"
}

# ── Step 4: Start the daemon ─────────────────────────────────────────
start_daemon() {
    log "Enabling and starting docker-daemon..."

    if has_systemd; then
        detect_docker_systemd_unit || true
        local docker_after="network-online.target"
        local docker_wants="network-online.target"
        local supplementary_groups=""
        if [[ -n "$DOCKER_SYSTEMD_UNIT" ]]; then
            docker_after="${docker_after} ${DOCKER_SYSTEMD_UNIT}"
            docker_wants="${docker_wants} ${DOCKER_SYSTEMD_UNIT}"
        elif detect_docker_access; then
            warn "Docker is reachable, but no systemd Docker unit was detected. docker-daemon will start without a Docker service dependency."
        else
            warn "No systemd Docker unit was detected. docker-daemon will start without a Docker service dependency."
        fi
        if docker_group_exists; then
            supplementary_groups="SupplementaryGroups=docker"
        fi

        cat > /etc/systemd/system/docker-daemon.service <<UNIT
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

[Install]
WantedBy=multi-user.target
UNIT

        systemctl daemon-reload >> "$LOG_FILE" 2>&1
        systemctl enable docker-daemon >> "$LOG_FILE" 2>&1
        systemctl restart docker-daemon >> "$LOG_FILE" 2>&1
        sleep 2

        if systemctl is-active --quiet docker-daemon; then
            ok "docker-daemon is running"
        else
            warn "docker-daemon may not have started. Check: journalctl -u docker-daemon -f"
        fi
    elif has_openrc; then
        cat > /etc/init.d/docker-daemon <<UNIT
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
    need net docker
}
UNIT
        chmod +x /etc/init.d/docker-daemon
        rc-update add docker-daemon default >> "$LOG_FILE" 2>&1
        rc-service docker-daemon restart >> "$LOG_FILE" 2>&1 || rc-service docker-daemon start >> "$LOG_FILE" 2>&1
        sleep 2

        if rc-service docker-daemon status >> "$LOG_FILE" 2>&1; then
            ok "docker-daemon is running"
        else
            warn "docker-daemon may not have started. Check: rc-service docker-daemon status"
        fi
    else
        warn "systemd not found — start the daemon manually: docker-daemon run"
    fi
}

# ── Run ──────────────────────────────────────────────────────────────
create_directories
install_daemon
enroll_daemon
write_database_profile_config
start_daemon

echo ""
echo -e "${GREEN}${BOLD}Docker node setup complete!${NC}"
echo ""
echo -e "  The node should appear as ${GREEN}online${NC} in Gateway within a few seconds."
if has_systemd; then
    echo -e "  Check status:  ${BRAND_MINT}systemctl status docker-daemon${NC}"
    echo -e "  View logs:     ${BRAND_MINT}journalctl -u docker-daemon -f${NC}"
elif has_openrc; then
    echo -e "  Check status:  ${BRAND_MINT}rc-service docker-daemon status${NC}"
    echo -e "  View logs:     ${BRAND_MINT}tail -f /var/log/docker-daemon.log${NC}"
else
    echo -e "  Start daemon:  ${BRAND_MINT}docker-daemon run${NC}"
fi
echo ""
