#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

# ── Defaults ──────────────────────────────────────────────────────────
DEFAULT_IMAGE="registry.gitlab.wiolett.net/wiolett/gateway"
CLICKHOUSE_IMAGE_REF="${CLICKHOUSE_IMAGE_REF:-clickhouse/clickhouse-server:26.2.10.10}"
GITLAB_API_URL="${GITLAB_API_URL:-https://gitlab.wiolett.net}"
GITLAB_PROJECT_PATH="${GITLAB_PROJECT_PATH:-wiolett/gateway}"
GITLAB_API="${GITLAB_API_URL}/api/v4/projects/$(echo "$GITLAB_PROJECT_PATH" | sed 's|/|%2F|g')"
DEFAULT_TAGLINE="Unified PKI, Proxy & Container Control Plane"
VERSION=""
LOG_FILE="/tmp/gateway_install.log"
NO_LOGO=0
NON_INTERACTIVE=0
APT_UPDATED=0
OS_RELEASE_LOADED=0
OS_ID=""
OS_ID_LIKE=""
OS_VERSION_CODENAME=""
DOCKER_USE_SUDO=0
DOCKER_SYSTEMD_UNIT=""

# Non-interactive config (set via flags or env vars)
OPT_DOMAIN="${GATEWAY_DOMAIN:-}"
OPT_ACME_EMAIL="${GATEWAY_ACME_EMAIL:-}"
OPT_OIDC_ISSUER="${GATEWAY_OIDC_ISSUER:-}"
OPT_OIDC_CLIENT_ID="${GATEWAY_OIDC_CLIENT_ID:-}"
OPT_OIDC_CLIENT_SECRET="${GATEWAY_OIDC_CLIENT_SECRET:-}"
OPT_ACME_STAGING="${GATEWAY_ACME_STAGING:-}"
OPT_SKIP_START="${GATEWAY_SKIP_START:-0}"
OPT_SSL_CERT="${GATEWAY_SSL_CERT:-}"
OPT_SSL_KEY="${GATEWAY_SSL_KEY:-}"
OPT_SSL_CHAIN="${GATEWAY_SSL_CHAIN:-}"
OPT_WITH_DOMAIN="${GATEWAY_WITH_DOMAIN:-}"

# Storage topology
OPT_DATABASE_MODE="${GATEWAY_DATABASE_MODE:-local}"
OPT_DATABASE_URL="${GATEWAY_DATABASE_URL:-}"
OPT_LOGGING_MODE="${GATEWAY_LOGGING_MODE:-local}"
OPT_CLICKHOUSE_URL="${GATEWAY_CLICKHOUSE_URL:-${CLICKHOUSE_URL:-}}"
OPT_CLICKHOUSE_USERNAME="${GATEWAY_CLICKHOUSE_USERNAME:-${CLICKHOUSE_USERNAME:-gateway}}"
OPT_CLICKHOUSE_PASSWORD="${GATEWAY_CLICKHOUSE_PASSWORD:-${CLICKHOUSE_PASSWORD:-}}"
OPT_CLICKHOUSE_DATABASE="${GATEWAY_CLICKHOUSE_DATABASE:-${CLICKHOUSE_DATABASE:-gateway_logs}}"
OPT_CLICKHOUSE_LOGS_TABLE="${GATEWAY_CLICKHOUSE_LOGS_TABLE:-${CLICKHOUSE_LOGS_TABLE:-logs}}"
OPT_DISABLE_LOGGING="${GATEWAY_DISABLE_LOGGING:-0}"

# Resource profile: small, medium, large, custom (default: medium)
OPT_RESOURCE_PROFILE="${GATEWAY_RESOURCE_PROFILE:-medium}"

# Logging driver config
OPT_LOG_ROTATION="${GATEWAY_LOG_ROTATION:-Y}"
OPT_LOG_MAX_SIZE="${GATEWAY_LOG_MAX_SIZE:-50m}"
OPT_LOG_MAX_FILE="${GATEWAY_LOG_MAX_FILE:-3}"

# .env permissions
OPT_RESTRICT_ENV="${GATEWAY_RESTRICT_ENV:-Y}"

# Nginx version: system, stable, custom
OPT_NGINX_VERSION="${GATEWAY_NGINX_VERSION:-system}"

# Resolved during install
SETUP_WITH_DOMAIN=0
EXISTING_ENV_DETECTED=0
DATABASE_MODE="local"
LOGGING_MODE="local"
DATABASE_URL=""
CLICKHOUSE_URL=""
CLICKHOUSE_USERNAME="gateway"
CLICKHOUSE_DATABASE="gateway_logs"
CLICKHOUSE_LOGS_TABLE="logs"

# Resource limits (set by profile)
APP_MEM_LIMIT=""
PG_MEM_LIMIT=""
REDIS_MEM_LIMIT=""
CLICKHOUSE_MEM_LIMIT=""

# ── Colors & Tags ─────────────────────────────────────────────────────
BRAND_MINT='\033[38;2;140;176;132m'
GRAY='\033[0;90m'
NC='\033[0m'
INFO_TAG='\033[47m\033[90m'       # light gray bg, dark gray text
WARN_TAG='\033[43m\033[30m'       # yellow bg, black text
ERROR_TAG='\033[41m\033[97m'      # red bg, white text
SUCCESS_TAG='\033[42m\033[97m'    # green bg, white text
TITLE_TAG='\033[48;2;140;176;132m\033[30m'  # brand mint bg, black text

# ── Logo ──────────────────────────────────────────────────────────────
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

# ── Helpers ───────────────────────────────────────────────────────────
info()    { echo -e "${INFO_TAG} INFO ${NC} $1"; }
warn()    { echo -e "${WARN_TAG} WARN ${NC} $1"; }
success() { echo -e "${SUCCESS_TAG} OK ${NC} $1"; }
title()   { echo ""; echo -e "${TITLE_TAG} $1 ${NC}"; echo ""; }

error() {
    echo -e "${ERROR_TAG} ERROR ${NC} $1"
    exit 1
}

validate_clickhouse_image_ref() {
    if [[ -z "${CLICKHOUSE_IMAGE_REF}" ]]; then
        error "CLICKHOUSE_IMAGE_REF must not be empty."
    fi

    if [[ "${CLICKHOUSE_IMAGE_REF}" =~ [[:space:][:cntrl:]] ]]; then
        error "CLICKHOUSE_IMAGE_REF must not contain whitespace or control characters."
    fi

    if [[ ! "${CLICKHOUSE_IMAGE_REF}" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@+-]*$ ]]; then
        error "CLICKHOUSE_IMAGE_REF contains unsupported characters."
    fi

    if [[ "${CLICKHOUSE_IMAGE_REF}" == *"@"* ]]; then
        if [[ ! "${CLICKHOUSE_IMAGE_REF}" =~ ^[A-Za-z0-9][A-Za-z0-9._/:+-]*@sha256:[A-Fa-f0-9]{64}$ ]]; then
            error "CLICKHOUSE_IMAGE_REF digest must use @sha256:<64 hex characters>."
        fi
        return
    fi

    local image_leaf="${CLICKHOUSE_IMAGE_REF##*/}"
    if [[ ! "${image_leaf}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*:([A-Za-z0-9_][A-Za-z0-9._-]{0,127})$ ]]; then
        error "CLICKHOUSE_IMAGE_REF must include exactly one explicit tag on the image name, or a sha256 digest."
    fi

    if [[ "${image_leaf##*:}" == "latest" ]]; then
        error "CLICKHOUSE_IMAGE_REF must not use the mutable latest tag."
    fi
}

validate_single_line_value() {
    local name="$1"
    local value="$2"
    if [[ "$value" =~ [[:cntrl:]] ]]; then
        error "${name} must not contain control characters."
    fi
}

validate_database_url() {
    validate_single_line_value "DATABASE_URL" "$1"
    if [[ -z "$1" ]]; then
        error "Remote database mode requires DATABASE_URL."
    fi
    if [[ ! "$1" =~ ^postgres(ql)?://[^[:space:]]+$ ]]; then
        error "DATABASE_URL must be a postgres:// or postgresql:// URL without whitespace."
    fi
}

validate_clickhouse_url() {
    validate_single_line_value "CLICKHOUSE_URL" "$1"
    if [[ -z "$1" ]]; then
        error "Remote ClickHouse mode requires CLICKHOUSE_URL."
    fi
    if [[ ! "$1" =~ ^https?://[^[:space:]]+$ ]]; then
        error "CLICKHOUSE_URL must be an http:// or https:// URL without whitespace."
    fi
}

validate_clickhouse_identifier() {
    local name="$1"
    local value="$2"
    validate_single_line_value "$name" "$value"
    if [[ ! "$value" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
        error "${name} must be a valid ClickHouse identifier."
    fi
}

normalize_storage_config() {
    DATABASE_MODE="${OPT_DATABASE_MODE:-local}"
    LOGGING_MODE="${OPT_LOGGING_MODE:-local}"

    if [[ -n "$OPT_DATABASE_URL" ]]; then
        DATABASE_MODE="remote"
    fi

    if [[ "$OPT_DISABLE_LOGGING" =~ ^(1|true|TRUE|yes|YES|y|Y)$ ]]; then
        LOGGING_MODE="disabled"
    elif [[ -n "$OPT_CLICKHOUSE_URL" && "${OPT_LOGGING_MODE:-local}" = "local" ]]; then
        LOGGING_MODE="remote"
    fi

    case "$DATABASE_MODE" in
        local)
            DATABASE_URL=""
            ;;
        remote)
            validate_database_url "$OPT_DATABASE_URL"
            DATABASE_URL="$OPT_DATABASE_URL"
            ;;
        *)
            error "GATEWAY_DATABASE_MODE must be local or remote."
            ;;
    esac

    case "$LOGGING_MODE" in
        local)
            CLICKHOUSE_URL="http://clickhouse:8123"
            CLICKHOUSE_USERNAME="gateway"
            CLICKHOUSE_DATABASE="gateway_logs"
            CLICKHOUSE_LOGS_TABLE="logs"
            ;;
        remote)
            validate_clickhouse_url "$OPT_CLICKHOUSE_URL"
            validate_single_line_value "CLICKHOUSE_USERNAME" "$OPT_CLICKHOUSE_USERNAME"
            validate_single_line_value "CLICKHOUSE_PASSWORD" "$OPT_CLICKHOUSE_PASSWORD"
            validate_clickhouse_identifier "CLICKHOUSE_DATABASE" "$OPT_CLICKHOUSE_DATABASE"
            validate_clickhouse_identifier "CLICKHOUSE_LOGS_TABLE" "$OPT_CLICKHOUSE_LOGS_TABLE"
            CLICKHOUSE_URL="$OPT_CLICKHOUSE_URL"
            CLICKHOUSE_USERNAME="$OPT_CLICKHOUSE_USERNAME"
            CLICKHOUSE_PASSWORD="$OPT_CLICKHOUSE_PASSWORD"
            CLICKHOUSE_DATABASE="$OPT_CLICKHOUSE_DATABASE"
            CLICKHOUSE_LOGS_TABLE="$OPT_CLICKHOUSE_LOGS_TABLE"
            ;;
        disabled)
            CLICKHOUSE_URL=""
            CLICKHOUSE_USERNAME="${OPT_CLICKHOUSE_USERNAME:-gateway}"
            CLICKHOUSE_DATABASE="${OPT_CLICKHOUSE_DATABASE:-gateway_logs}"
            CLICKHOUSE_LOGS_TABLE="${OPT_CLICKHOUSE_LOGS_TABLE:-logs}"
            ;;
        *)
            error "GATEWAY_LOGGING_MODE must be local, remote, or disabled."
            ;;
    esac
}

env_value() {
    local name="$1"
    [ -f .env ] || return 0
    grep -E "^${name}=" .env | tail -1 | cut -d= -f2- || true
}

set_env_value() {
    local name="$1"
    local value="$2"
    local tmp

    [ -f .env ] || return 0
    tmp=$(mktemp_compat /tmp/gateway-env)
    if grep -q "^${name}=" .env; then
        sed "s|^${name}=.*|${name}=${value}|" .env > "$tmp"
        cat "$tmp" > .env
    else
        printf '\n%s=%s\n' "$name" "$value" >> .env
    fi
    rm -f "$tmp"
}

infer_storage_config_from_env() {
    local existing_database_url existing_clickhouse_url
    existing_database_url="$(env_value "DATABASE_URL")"
    existing_clickhouse_url="$(env_value "CLICKHOUSE_URL")"

    DATABASE_MODE="local"
    if [[ -n "$existing_database_url" && ! "$existing_database_url" =~ @postgres(:|/) ]]; then
        DATABASE_MODE="remote"
    fi

    LOGGING_MODE="local"
    if grep -q '^CLICKHOUSE_URL=' .env; then
        if [[ -z "$existing_clickhouse_url" ]]; then
            LOGGING_MODE="disabled"
        elif [[ "$existing_clickhouse_url" != "http://clickhouse:8123" ]]; then
            LOGGING_MODE="remote"
        fi
    fi
}

prompt_required_input() {
    local prompt="$1"
    local default="${2:-}"
    local value
    while true; do
        value=$(prompt_input "$prompt" "$default")
        if [ -n "$value" ]; then
            echo "$value"
            return
        fi
        warn "A value is required." >&2
    done
}

run_quiet() {
    if "$@" >>"$LOG_FILE" 2>&1; then
        return 0
    fi
    error "Command failed: $*\n  Check ${LOG_FILE} for details."
}

apt_install_quiet() {
    DEBIAN_FRONTEND=noninteractive run_quiet apt-get \
        -o Dpkg::Options::=--force-confnew \
        -o Dpkg::Options::=--force-confmiss \
        install -y "$@"
}

run_privileged_quiet() {
    if [ "$(id -u)" -eq 0 ]; then
        run_quiet "$@"
        return
    fi

    if command -v sudo &>/dev/null; then
        run_quiet sudo "$@"
        return
    fi

    error "This step requires root privileges. Re-run as root or install sudo."
}

docker_run() {
    if [ "$DOCKER_USE_SUDO" -eq 1 ]; then
        sudo docker "$@"
    else
        docker "$@"
    fi
}

docker_compose_run() {
    if [ "$DOCKER_USE_SUDO" -eq 1 ]; then
        sudo docker compose "$@"
    else
        docker compose "$@"
    fi
}

mktemp_compat() {
    local prefix="${1:-/tmp/gateway-tmp}"
    local dir template

    dir="$(dirname "$prefix")"
    template="$(basename "$prefix").XXXXXX"

    mkdir -p "$dir"
    mktemp "${dir}/${template}"
}

detect_docker_access() {
    if docker info >/dev/null 2>&1; then
        DOCKER_USE_SUDO=0
        return 0
    fi

    if [ "$(id -u)" -eq 0 ]; then
        return 1
    fi

    if command -v sudo &>/dev/null && sudo docker info >/dev/null 2>&1; then
        DOCKER_USE_SUDO=1
        return 0
    fi

    return 1
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
    local default="${2:-N}"
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

pkg_update_once() {
    if command -v apt-get &>/dev/null; then
        if [ "$APT_UPDATED" -eq 0 ]; then
            run_privileged_quiet apt-get update
            APT_UPDATED=1
        fi
    elif command -v apk &>/dev/null; then
        run_privileged_quiet apk update
    fi
}

load_os_release() {
    if [ "$OS_RELEASE_LOADED" -eq 1 ]; then
        return
    fi

    if [ ! -f /etc/os-release ]; then
        error "Cannot detect operating system: /etc/os-release not found."
    fi

    # shellcheck disable=SC1091
    . /etc/os-release
    OS_ID="${ID:-}"
    OS_ID_LIKE="${ID_LIKE:-}"
    OS_VERSION_CODENAME="${VERSION_CODENAME:-}"
    OS_RELEASE_LOADED=1
}

docker_repo_distro_family() {
    load_os_release

    case "$OS_ID" in
        ubuntu) echo "ubuntu" ;;
        debian) echo "debian" ;;
        fedora) echo "fedora" ;;
        rhel) echo "rhel" ;;
        centos|centos_stream) echo "centos" ;;
        *)
            if [[ "$OS_ID_LIKE" == *ubuntu* ]]; then
                echo "ubuntu"
            elif [[ "$OS_ID_LIKE" == *debian* ]]; then
                echo "debian"
            elif [[ "$OS_ID_LIKE" == *fedora* ]]; then
                echo "fedora"
            elif [[ "$OS_ID_LIKE" == *rhel* ]] || [[ "$OS_ID_LIKE" == *centos* ]]; then
                echo "rhel"
            else
                echo ""
            fi
            ;;
    esac
}

setup_docker_apt_repository() {
    local repo_distro="$1"

    info "Configuring Docker apt repository..."
    install_system_packages ca-certificates curl gnupg

    run_privileged_quiet install -m 0755 -d /etc/apt/keyrings
    run_privileged_quiet curl -fsSL "https://download.docker.com/linux/${repo_distro}/gpg" -o /etc/apt/keyrings/docker.asc
    run_privileged_quiet chmod a+r /etc/apt/keyrings/docker.asc

    local codename="$OS_VERSION_CODENAME"
    if [ -z "$codename" ] && command -v lsb_release &>/dev/null; then
        codename=$(lsb_release -cs 2>/dev/null || true)
    fi
    [ -n "$codename" ] || error "Could not determine distribution codename for Docker apt repository."

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
    pkg_update_once
}

setup_docker_rpm_repository() {
    local repo_distro="$1"
    local repo_url="https://download.docker.com/linux/${repo_distro}/docker-ce.repo"

    info "Configuring Docker rpm repository..."
    ensure_curl_installed

    if command -v dnf &>/dev/null; then
        install_system_packages dnf-plugins-core
    elif command -v yum &>/dev/null; then
        install_system_packages yum-utils
    fi

    run_privileged_quiet curl -fsSL "$repo_url" -o /etc/yum.repos.d/docker-ce.repo
}

remove_conflicting_docker_packages() {
    local repo_family="$1"

    case "$repo_family" in
        ubuntu)
            info "Removing conflicting Docker packages..."
            local packages=()
            while IFS= read -r package; do
                [ -n "$package" ] && packages+=("$package")
            done < <(dpkg --get-selections docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc 2>/dev/null | awk '{print $1}')
            if [ "${#packages[@]}" -gt 0 ]; then
                run_privileged_quiet apt remove -y "${packages[@]}"
                APT_UPDATED=0
            fi
            ;;
        debian)
            info "Removing conflicting Docker packages..."
            local packages=()
            while IFS= read -r package; do
                [ -n "$package" ] && packages+=("$package")
            done < <(dpkg --get-selections docker.io docker-compose docker-doc podman-docker containerd runc 2>/dev/null | awk '{print $1}')
            if [ "${#packages[@]}" -gt 0 ]; then
                run_privileged_quiet apt remove -y "${packages[@]}"
                APT_UPDATED=0
            fi
            ;;
        fedora|centos|rhel)
            info "Removing conflicting Docker packages..."
            if command -v dnf &>/dev/null; then
                run_privileged_quiet dnf remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine podman runc || true
            elif command -v yum &>/dev/null; then
                run_privileged_quiet yum remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine podman runc || true
            fi
            ;;
    esac
}

install_docker_engine_from_official_repo() {
    local repo_family
    repo_family=$(docker_repo_distro_family)

    [ -n "$repo_family" ] || error "Automatic Docker installation is only supported for Debian/Ubuntu/Fedora/CentOS/RHEL hosts."

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
        *)
            error "Unsupported Docker repository family: ${repo_family}"
            ;;
    esac
}

install_system_packages() {
    if [ "$#" -eq 0 ]; then
        return
    fi

    pkg_update_once

    if command -v apt-get &>/dev/null; then
        run_privileged_quiet apt-get install -y "$@"
    elif command -v yum &>/dev/null; then
        run_privileged_quiet yum install -y "$@"
    elif command -v dnf &>/dev/null; then
        run_privileged_quiet dnf install -y "$@"
    elif command -v apk &>/dev/null; then
        run_privileged_quiet apk add "$@"
    else
        error "Could not detect a supported package manager for automatic dependency installation."
    fi
}

ensure_docker_service_running() {
    if ! command -v docker &>/dev/null; then
        return
    fi

    if detect_docker_access; then
        return
    fi

    info "Starting Docker service..."
    if command -v systemctl &>/dev/null; then
        if detect_docker_systemd_unit; then
            if [ "$DOCKER_SYSTEMD_UNIT" = "docker.service" ]; then
                run_privileged_quiet systemctl enable --now containerd || true
                run_privileged_quiet systemctl enable --now "$DOCKER_SYSTEMD_UNIT"
            else
                run_privileged_quiet systemctl start "$DOCKER_SYSTEMD_UNIT"
            fi
        else
            run_privileged_quiet systemctl enable --now containerd || true
            run_privileged_quiet systemctl enable --now docker
        fi
    elif command -v service &>/dev/null; then
        run_privileged_quiet service containerd start || true
        run_privileged_quiet service docker start
    fi

    local retries=5
    while [ "$retries" -gt 0 ]; do
        if detect_docker_access; then
            return
        fi
        retries=$((retries - 1))
        sleep 2
    done

    if command -v systemctl &>/dev/null; then
        if detect_docker_systemd_unit; then
            run_privileged_quiet systemctl status "$DOCKER_SYSTEMD_UNIT" --no-pager >>"$LOG_FILE" 2>&1 || true
        else
            run_privileged_quiet systemctl status docker --no-pager >>"$LOG_FILE" 2>&1 || true
        fi
        run_privileged_quiet systemctl status containerd --no-pager >>"$LOG_FILE" 2>&1 || true
    elif command -v service &>/dev/null; then
        run_privileged_quiet service docker status >>"$LOG_FILE" 2>&1 || true
        run_privileged_quiet service containerd status >>"$LOG_FILE" 2>&1 || true
    fi

    error "Docker is installed but the daemon is not reachable. Check docker/containerd service status in ${LOG_FILE}."
}

ensure_curl_installed() {
    if command -v curl &>/dev/null; then
        return
    fi

    info "curl not found, installing it..."
    install_system_packages curl ca-certificates
    command -v curl &>/dev/null || error "Failed to install curl."
}

ensure_docker_installed() {
    if command -v docker &>/dev/null; then
        ensure_docker_service_running
        return
    fi

    info "Docker not found, installing it..."
    install_docker_engine_from_official_repo

    ensure_docker_service_running
}

ensure_docker_compose_installed() {
    if command -v docker &>/dev/null && docker_compose_run version &>/dev/null; then
        return
    fi

    info "Docker Compose v2 not found, installing it from Docker's repository..."
    install_docker_engine_from_official_repo
    ensure_docker_service_running

    docker_compose_run version &>/dev/null || error "Docker Compose v2 is still unavailable after installation."
}

ensure_openssl_installed() {
    if command -v openssl &>/dev/null; then
        return
    fi

    info "OpenSSL not found, installing it..."
    install_system_packages openssl
    command -v openssl &>/dev/null || error "Failed to install OpenSSL."
}

# ── Health check helper ───────────────────────────────────────────────
check_health() {
    local url="$1"
    if command -v curl &>/dev/null; then
        curl -sf "$url" > /dev/null 2>&1
    elif command -v wget &>/dev/null; then
        wget -qO /dev/null "$url" 2>/dev/null
    else
        docker_compose_run exec -T app wget -qO- http://127.0.0.1:3000/health > /dev/null 2>&1
    fi
}

# ── Backup helper ─────────────────────────────────────────────────────
backup_if_exists() {
    local file="$1"
    if [ -f "$file" ]; then
        local backup="${file}.backup.$(date +%Y%m%d_%H%M%S)"
        cp "$file" "$backup"
        info "Backed up ${file} -> ${backup}"
    fi
}

# ── Resource profile helper ──────────────────────────────────────────
apply_resource_profile() {
    local profile="$1"
    case "$profile" in
        small)
            APP_MEM_LIMIT="1g"
            PG_MEM_LIMIT="512m"
            REDIS_MEM_LIMIT="256m"
            CLICKHOUSE_MEM_LIMIT="1g"
            ;;
        medium)
            APP_MEM_LIMIT="2g"
            PG_MEM_LIMIT="1g"
            REDIS_MEM_LIMIT="512m"
            CLICKHOUSE_MEM_LIMIT="2g"
            ;;
        large)
            APP_MEM_LIMIT="4g"
            PG_MEM_LIMIT="2g"
            REDIS_MEM_LIMIT="1g"
            CLICKHOUSE_MEM_LIMIT="4g"
            ;;
        custom)
            # Caller must set APP_MEM_LIMIT, PG_MEM_LIMIT, REDIS_MEM_LIMIT, CLICKHOUSE_MEM_LIMIT
            ;;
        *)
            warn "Unknown resource profile '${profile}', defaulting to medium."
            apply_resource_profile "medium"
            ;;
    esac
}

# ── Prerequisites ─────────────────────────────────────────────────────
check_prerequisites() {
    title "Prerequisites"

    ensure_docker_installed
    info "Docker $(docker_run --version | awk '{print $3}' | tr -d ',')"

    ensure_docker_compose_installed
    info "Docker Compose $(docker_compose_run version --short 2>/dev/null || echo 'v2')"

    ensure_openssl_installed
    info "OpenSSL $(openssl version 2>/dev/null | awk '{print $2}')"
}

# ── Intro ─────────────────────────────────────────────────────────────
show_intro() {
    echo -e "  ${GRAY}${DEFAULT_TAGLINE}${NC}"
    echo -e "  ${GRAY}Version to install: ${BRAND_MINT}${VERSION}${NC}"
    echo ""
    echo -e "  ${GRAY}This installer will set up Gateway in the current directory:${NC}"
    echo -e "  ${GRAY}  1. Verify prerequisites (Docker, Docker Compose, OpenSSL)${NC}"
    echo -e "  ${GRAY}  2. Choose deployment mode (with or without domain)${NC}"
    echo -e "  ${GRAY}  3. Configure authentication and security${NC}"
    echo -e "  ${GRAY}  4. Generate configuration files${NC}"
    echo -e "  ${GRAY}  5. Pull images and start services${NC}"
    echo ""

    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        info "Running in non-interactive mode."
        return
    fi

    if ! prompt_yes_no "Continue?" "Y"; then
        info "Cancelled."
        exit 0
    fi
}

resolve_version() {
    if [ -n "$VERSION" ]; then
        info "Install version: ${VERSION}"
        return
    fi

    ensure_curl_installed

    info "Fetching latest version..."
    VERSION=$(curl -sf "${GITLAB_API}/releases" 2>/dev/null \
        | grep -o '"tag_name":"v[0-9]*\.[0-9]*\.[0-9]*"' | head -1 | cut -d'"' -f4) || true

    if [ -z "$VERSION" ]; then
        error "Could not fetch latest version from ${GITLAB_API}/releases. Retry later or pass --version <tag> explicitly; use --version latest only if you intentionally want the mutable latest tag."
    fi

    info "Install version: ${VERSION}"
}

# ── Configuration ─────────────────────────────────────────────────────
gather_config() {
    title "Configuration"

    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        # Non-interactive: decide mode from flags
        if [ -n "$OPT_DOMAIN" ] && [ "$OPT_DOMAIN" != "localhost" ]; then
            SETUP_WITH_DOMAIN=1
            DOMAIN="$OPT_DOMAIN"
            APP_URL="https://${DOMAIN}"
            ACME_EMAIL="${OPT_ACME_EMAIL:-admin@example.com}"
            ACME_STAGING="${OPT_ACME_STAGING:-false}"
        else
            SETUP_WITH_DOMAIN=0
            DOMAIN="localhost"
            APP_URL="http://localhost:3000"
            ACME_EMAIL="${OPT_ACME_EMAIL:-admin@example.com}"
            ACME_STAGING="true"
        fi

        OIDC_ISSUER="${OPT_OIDC_ISSUER:-}"
        OIDC_CLIENT_ID="${OPT_OIDC_CLIENT_ID:-gateway}"
        OIDC_CLIENT_SECRET="${OPT_OIDC_CLIENT_SECRET:-}"
        OIDC_REDIRECT_URI="${APP_URL}/auth/callback"

        normalize_storage_config

        # Resource profile from env/flag
        apply_resource_profile "$OPT_RESOURCE_PROFILE"

        info "Mode: $([ "$SETUP_WITH_DOMAIN" -eq 1 ] && echo "domain + nginx" || echo "direct access")"
        [ "$SETUP_WITH_DOMAIN" -eq 1 ] && info "Domain: ${DOMAIN}"
        [ -n "$OIDC_ISSUER" ] && info "OIDC issuer: ${OIDC_ISSUER}" || warn "OIDC not configured. Set OIDC_* variables in .env before starting."
        info "Database: ${DATABASE_MODE}"
        info "Structured logging: ${LOGGING_MODE}"
        info "Resource profile: ${OPT_RESOURCE_PROFILE} (app=${APP_MEM_LIMIT}, pg=${PG_MEM_LIMIT}, redis=${REDIS_MEM_LIMIT}, clickhouse=${CLICKHOUSE_MEM_LIMIT})"
        return
    fi

    # Interactive: ask about domain setup
    echo -e "  ${BRAND_MINT}Deployment mode:${NC}"
    echo -e "  ${GRAY}  1) Set up with domain — installs nginx on this host,${NC}"
    echo -e "  ${GRAY}     serves the management UI via HTTPS on your domain${NC}"
    echo -e "  ${GRAY}  2) Direct access — no domain, access the management UI${NC}"
    echo -e "  ${GRAY}     directly on port 3000 (you can add a domain later)${NC}"
    echo ""
    local mode_choice
    mode_choice=$(prompt_input "Choose" "1")

    if [ "$mode_choice" = "1" ]; then
        SETUP_WITH_DOMAIN=1
        DOMAIN=$(prompt_input "Domain (e.g. gateway.example.com)" "")
        if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "localhost" ]; then
            warn "No valid domain entered, falling back to direct access mode."
            SETUP_WITH_DOMAIN=0
            DOMAIN="localhost"
            APP_URL="http://localhost:3000"
        else
            APP_URL="https://${DOMAIN}"
            ACME_EMAIL=$(prompt_input "Email for Let's Encrypt" "admin@example.com")

            # ACME staging
            if prompt_yes_no "Use Let's Encrypt staging? (for testing only)" "N"; then
                ACME_STAGING="true"
            else
                ACME_STAGING="false"
            fi
        fi
    else
        SETUP_WITH_DOMAIN=0
        DOMAIN="localhost"
        APP_URL="http://localhost:3000"
        ACME_STAGING="true"
    fi

    ACME_EMAIL="${ACME_EMAIL:-admin@example.com}"

    echo ""

    # OIDC
    OIDC_ISSUER=""
    OIDC_CLIENT_ID=""
    OIDC_CLIENT_SECRET=""

    if prompt_yes_no "Configure OIDC authentication now?" "Y"; then
        OIDC_ISSUER=$(prompt_input "OIDC Issuer URL" "")
        OIDC_CLIENT_ID=$(prompt_input "OIDC Client ID" "gateway")
        OIDC_CLIENT_SECRET=$(prompt_secret "OIDC Client Secret")

        if [ -z "$OIDC_ISSUER" ]; then
            warn "No issuer URL entered. Set OIDC_ISSUER in .env before starting."
        fi
    else
        warn "OIDC not configured. Set OIDC_* variables in .env before starting."
    fi

    OIDC_REDIRECT_URI="${APP_URL}/auth/callback"

    echo ""

    # Database
    echo -e "  ${BRAND_MINT}Database:${NC}"
    echo -e "  ${GRAY}  1) Install and configure PostgreSQL here  [default]${NC}"
    echo -e "  ${GRAY}  2) Use a remote PostgreSQL database${NC}"
    echo ""
    local database_choice
    database_choice=$(prompt_input "Choose" "1")
    if [ "$database_choice" = "2" ]; then
        DATABASE_MODE="remote"
        DATABASE_URL=$(prompt_required_input "PostgreSQL URL" "")
        validate_database_url "$DATABASE_URL"
    else
        DATABASE_MODE="local"
        DATABASE_URL=""
    fi

    echo ""

    # Structured logging
    echo -e "  ${BRAND_MINT}Structured logging:${NC}"
    echo -e "  ${GRAY}  1) Install and configure ClickHouse here  [default]${NC}"
    echo -e "  ${GRAY}  2) Use a remote ClickHouse database${NC}"
    echo -e "  ${GRAY}  3) Disable structured logging${NC}"
    echo ""
    local logging_choice
    logging_choice=$(prompt_input "Choose" "1")
    case "$logging_choice" in
        2)
            LOGGING_MODE="remote"
            CLICKHOUSE_URL=$(prompt_required_input "ClickHouse URL" "")
            CLICKHOUSE_USERNAME=$(prompt_input "ClickHouse username" "gateway")
            CLICKHOUSE_PASSWORD=$(prompt_secret "ClickHouse password")
            CLICKHOUSE_DATABASE=$(prompt_input "ClickHouse database" "gateway_logs")
            CLICKHOUSE_LOGS_TABLE=$(prompt_input "ClickHouse logs table" "logs")
            validate_clickhouse_url "$CLICKHOUSE_URL"
            validate_single_line_value "CLICKHOUSE_USERNAME" "$CLICKHOUSE_USERNAME"
            validate_single_line_value "CLICKHOUSE_PASSWORD" "$CLICKHOUSE_PASSWORD"
            validate_clickhouse_identifier "CLICKHOUSE_DATABASE" "$CLICKHOUSE_DATABASE"
            validate_clickhouse_identifier "CLICKHOUSE_LOGS_TABLE" "$CLICKHOUSE_LOGS_TABLE"
            ;;
        3)
            LOGGING_MODE="disabled"
            CLICKHOUSE_URL=""
            CLICKHOUSE_USERNAME="gateway"
            CLICKHOUSE_DATABASE="gateway_logs"
            CLICKHOUSE_LOGS_TABLE="logs"
            ;;
        *)
            LOGGING_MODE="local"
            CLICKHOUSE_URL="http://clickhouse:8123"
            CLICKHOUSE_USERNAME="gateway"
            CLICKHOUSE_DATABASE="gateway_logs"
            CLICKHOUSE_LOGS_TABLE="logs"
            ;;
    esac

    echo ""

    # Resource profile
    echo -e "  ${BRAND_MINT}Resource profile:${NC}"
    echo -e "  ${GRAY}  1) Small  — App: 1GB, Postgres: 512MB, Redis: 256MB, ClickHouse: 1GB${NC}"
    echo -e "  ${GRAY}  2) Medium — App: 2GB, Postgres: 1GB,   Redis: 512MB, ClickHouse: 2GB  [default]${NC}"
    echo -e "  ${GRAY}  3) Large  — App: 4GB, Postgres: 2GB,   Redis: 1GB,   ClickHouse: 4GB${NC}"
    echo -e "  ${GRAY}  4) Custom — Enter limits manually${NC}"
    echo ""
    local profile_choice
    profile_choice=$(prompt_input "Choose" "2")

    case "$profile_choice" in
        1) apply_resource_profile "small" ;;
        3) apply_resource_profile "large" ;;
        4)
            APP_MEM_LIMIT=$(prompt_input "App memory limit (e.g. 2g, 512m)" "2g")
            PG_MEM_LIMIT=$(prompt_input "Postgres memory limit" "1g")
            REDIS_MEM_LIMIT=$(prompt_input "Redis memory limit" "512m")
            CLICKHOUSE_MEM_LIMIT=$(prompt_input "ClickHouse memory limit" "2g")
            ;;
        *) apply_resource_profile "medium" ;;
    esac

    info "Resources: app=${APP_MEM_LIMIT}, postgres=${PG_MEM_LIMIT}, redis=${REDIS_MEM_LIMIT}, clickhouse=${CLICKHOUSE_MEM_LIMIT}"
    info "Database: ${DATABASE_MODE}"
    info "Structured logging: ${LOGGING_MODE}"

    echo ""

    # Log rotation
    if prompt_yes_no "Configure log rotation?" "Y"; then
        OPT_LOG_ROTATION="Y"
        OPT_LOG_MAX_SIZE=$(prompt_input "Max log file size" "50m")
        OPT_LOG_MAX_FILE=$(prompt_input "Max number of log files" "3")
    else
        OPT_LOG_ROTATION="N"
    fi

    echo ""

    # .env permissions
    if prompt_yes_no "Restrict .env permissions to owner-only?" "Y"; then
        OPT_RESTRICT_ENV="Y"
    else
        OPT_RESTRICT_ENV="N"
    fi
}

# ── Generate Secrets ──────────────────────────────────────────────────
generate_secrets() {
    title "Security"

    PKI_MASTER_KEY=$(openssl rand -hex 32)
    DB_PASSWORD=$(openssl rand -hex 16)
    if [ "$DATABASE_MODE" = "local" ]; then
        DATABASE_URL="postgres://gateway:${DB_PASSWORD}@postgres:5432/gateway"
    fi

    if [ "$LOGGING_MODE" = "local" ]; then
        CLICKHOUSE_PASSWORD=$(openssl rand -hex 16)
    else
        CLICKHOUSE_PASSWORD="${CLICKHOUSE_PASSWORD:-${OPT_CLICKHOUSE_PASSWORD:-}}"
    fi
    SETUP_TOKEN=$(openssl rand -hex 32)
    SETUP_BOOTSTRAP="true"
    if [ "$EXISTING_ENV_DETECTED" -eq 1 ]; then
        SETUP_BOOTSTRAP="false"
    fi

    info "PKI Master Key generated"
    [ "$DATABASE_MODE" = "local" ] && info "Database password generated"
    [ "$LOGGING_MODE" = "local" ] && info "ClickHouse password generated"
    info "Setup token generated"

    # Build gRPC TLS SANs (domain + public IP so external daemons can connect)
    GRPC_EXTRA_SANS=""
    if [ -n "${DOMAIN:-}" ] && [ "$DOMAIN" != "localhost" ]; then
        GRPC_EXTRA_SANS="$DOMAIN"
    fi
    local public_ip
    public_ip=$(curl -sf --max-time 5 https://api.ipify.org 2>/dev/null || curl -sf --max-time 5 https://ifconfig.me 2>/dev/null || true)
    if [ -n "$public_ip" ]; then
        GRPC_EXTRA_SANS="${GRPC_EXTRA_SANS:+${GRPC_EXTRA_SANS},}${public_ip}"
    fi
}

# ── Write .env ────────────────────────────────────────────────────────
write_env() {
    backup_if_exists ".env"

    cat > .env << ENVEOF
# Gateway Configuration
# Generated $(date -u +"%Y-%m-%d %H:%M:%S UTC")

# Image
GATEWAY_IMAGE=${GATEWAY_IMAGE:-$DEFAULT_IMAGE}
GATEWAY_VERSION=${VERSION}
GATEWAY_IMAGE_REF=${GATEWAY_IMAGE:-$DEFAULT_IMAGE}:${VERSION}

# Compose project directory (used by self-update)
COMPOSE_PROJECT_DIR=$(pwd)

# Server
PORT=3000
NODE_ENV=production
APP_URL=${APP_URL}
BIND_HOST=0.0.0.0

# Database
DB_PASSWORD=${DB_PASSWORD}
DATABASE_URL=${DATABASE_URL}

# Redis
REDIS_URL=redis://redis:6379

# ClickHouse (external structured logging)
CLICKHOUSE_URL=${CLICKHOUSE_URL}
CLICKHOUSE_USERNAME=${CLICKHOUSE_USERNAME}
CLICKHOUSE_PASSWORD=${CLICKHOUSE_PASSWORD}
CLICKHOUSE_DATABASE=${CLICKHOUSE_DATABASE}
CLICKHOUSE_LOGS_TABLE=${CLICKHOUSE_LOGS_TABLE}
CLICKHOUSE_REQUEST_TIMEOUT_MS=5000
CLICKHOUSE_MANAGED_INTERNAL_LOGS=$([ "$LOGGING_MODE" = "local" ] && printf true || printf false)

# Logging ingest guardrails
LOGGING_INGEST_MAX_BODY_BYTES=1048576
LOGGING_INGEST_MAX_BATCH_SIZE=500
LOGGING_INGEST_MAX_MESSAGE_BYTES=16384
LOGGING_INGEST_MAX_LABELS=32
LOGGING_INGEST_MAX_FIELDS=64
LOGGING_INGEST_MAX_KEY_LENGTH=100
LOGGING_INGEST_MAX_VALUE_BYTES=8192
LOGGING_INGEST_MAX_JSON_DEPTH=5
LOGGING_RATE_LIMIT_WINDOW_SECONDS=60
LOGGING_GLOBAL_REQUESTS_PER_WINDOW=600
LOGGING_GLOBAL_EVENTS_PER_WINDOW=60000
LOGGING_TOKEN_REQUESTS_PER_WINDOW=300
LOGGING_TOKEN_EVENTS_PER_WINDOW=10000

# OIDC Authentication
OIDC_ISSUER=${OIDC_ISSUER}
OIDC_CLIENT_ID=${OIDC_CLIENT_ID}
OIDC_CLIENT_SECRET=${OIDC_CLIENT_SECRET}
OIDC_REDIRECT_URI=${OIDC_REDIRECT_URI}
OIDC_SCOPES=openid email profile

# Session
SESSION_EXPIRY=2592000

# PKI Master Key (DO NOT CHANGE after initial setup)
PKI_MASTER_KEY=${PKI_MASTER_KEY}

# ACME / Let's Encrypt
ACME_EMAIL=${ACME_EMAIL}
ACME_STAGING=${ACME_STAGING}

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=1200
RATE_LIMIT_AUTH_MAX_REQUESTS=120
RATE_LIMIT_AUTH_LOGIN_MAX_REQUESTS=20
RATE_LIMIT_AUTH_CALLBACK_MAX_REQUESTS=60
RATE_LIMIT_SETUP_MAX_REQUESTS=20
RATE_LIMIT_PUBLIC_STATUS_MAX_REQUESTS=600
RATE_LIMIT_PUBLIC_WEBHOOK_MAX_REQUESTS=60
RATE_LIMIT_PKI_MAX_REQUESTS=600
RATE_LIMIT_STREAM_MAX_REQUESTS=120
RATE_LIMIT_AI_WS_MAX_REQUESTS=30

# PKI Defaults
DEFAULT_CRL_VALIDITY_HOURS=24
DEFAULT_OCSP_VALIDITY_MINUTES=60
EXPIRY_WARNING_DAYS=30
EXPIRY_CRITICAL_DAYS=7

# Background Jobs
HEALTH_CHECK_INTERVAL_SECONDS=30
ACME_RENEWAL_CRON=0 3 * * *
EXPIRY_CHECK_CRON=0 6 * * *

# gRPC (daemon communication)
GRPC_PORT=9443
GRPC_TLS_EXTRA_SANS=${GRPC_EXTRA_SANS}

# AI sandbox runner
SANDBOX_RUNNER_WORKSPACE_DIR=/var/lib/gateway/sandbox-workspaces

# Setup token (for bootstrap API — management SSL provisioning)
SETUP_TOKEN=${SETUP_TOKEN}
SETUP_BOOTSTRAP=${SETUP_BOOTSTRAP:-false}

# Updates
APP_VERSION=\${GATEWAY_VERSION}

# DNS (optional)
# DNS_RESOLVERS=8.8.8.8,1.1.1.1
# DNS_CHECK_INTERVAL_SECONDS=300
# PUBLIC_IPV4=
# PUBLIC_IPV6=
ENVEOF

    if [[ "$OPT_RESTRICT_ENV" =~ ^[yY]$ ]]; then
        chmod 600 .env
        info ".env (permissions: 600)"
    else
        info ".env"
    fi
}

ensure_clickhouse_env() {
    [ -f .env ] || return

    local clickhouse_password
    clickhouse_password=$(openssl rand -hex 16)

    local additions=""
    local reset_managed_internal_logs=0
    if [ "$LOGGING_MODE" != "local" ] && grep -q '^CLICKHOUSE_MANAGED_INTERNAL_LOGS=' .env; then
        if [ "$(env_value "CLICKHOUSE_MANAGED_INTERNAL_LOGS")" != "false" ]; then
            reset_managed_internal_logs=1
        fi
    fi
    grep -q '^CLICKHOUSE_URL=' .env || additions="${additions}
CLICKHOUSE_URL=http://clickhouse:8123"
    grep -q '^CLICKHOUSE_USERNAME=' .env || additions="${additions}
CLICKHOUSE_USERNAME=gateway"
    grep -q '^CLICKHOUSE_PASSWORD=' .env || additions="${additions}
CLICKHOUSE_PASSWORD=${clickhouse_password}"
    grep -q '^CLICKHOUSE_DATABASE=' .env || additions="${additions}
CLICKHOUSE_DATABASE=gateway_logs"
    grep -q '^CLICKHOUSE_LOGS_TABLE=' .env || additions="${additions}
CLICKHOUSE_LOGS_TABLE=logs"
    grep -q '^CLICKHOUSE_REQUEST_TIMEOUT_MS=' .env || additions="${additions}
CLICKHOUSE_REQUEST_TIMEOUT_MS=5000"
    grep -q '^CLICKHOUSE_MANAGED_INTERNAL_LOGS=' .env || additions="${additions}
CLICKHOUSE_MANAGED_INTERNAL_LOGS=$([ "$LOGGING_MODE" = "local" ] && printf true || printf false)"
    grep -q '^LOGGING_INGEST_MAX_BODY_BYTES=' .env || additions="${additions}
LOGGING_INGEST_MAX_BODY_BYTES=1048576"
    grep -q '^LOGGING_INGEST_MAX_BATCH_SIZE=' .env || additions="${additions}
LOGGING_INGEST_MAX_BATCH_SIZE=500"
    grep -q '^LOGGING_INGEST_MAX_MESSAGE_BYTES=' .env || additions="${additions}
LOGGING_INGEST_MAX_MESSAGE_BYTES=16384"
    grep -q '^LOGGING_INGEST_MAX_LABELS=' .env || additions="${additions}
LOGGING_INGEST_MAX_LABELS=32"
    grep -q '^LOGGING_INGEST_MAX_FIELDS=' .env || additions="${additions}
LOGGING_INGEST_MAX_FIELDS=64"
    grep -q '^LOGGING_INGEST_MAX_KEY_LENGTH=' .env || additions="${additions}
LOGGING_INGEST_MAX_KEY_LENGTH=100"
    grep -q '^LOGGING_INGEST_MAX_VALUE_BYTES=' .env || additions="${additions}
LOGGING_INGEST_MAX_VALUE_BYTES=8192"
    grep -q '^LOGGING_INGEST_MAX_JSON_DEPTH=' .env || additions="${additions}
LOGGING_INGEST_MAX_JSON_DEPTH=5"
    grep -q '^LOGGING_RATE_LIMIT_WINDOW_SECONDS=' .env || additions="${additions}
LOGGING_RATE_LIMIT_WINDOW_SECONDS=60"
    grep -q '^LOGGING_GLOBAL_REQUESTS_PER_WINDOW=' .env || additions="${additions}
LOGGING_GLOBAL_REQUESTS_PER_WINDOW=600"
    grep -q '^LOGGING_GLOBAL_EVENTS_PER_WINDOW=' .env || additions="${additions}
LOGGING_GLOBAL_EVENTS_PER_WINDOW=60000"
    grep -q '^LOGGING_TOKEN_REQUESTS_PER_WINDOW=' .env || additions="${additions}
LOGGING_TOKEN_REQUESTS_PER_WINDOW=300"
    grep -q '^LOGGING_TOKEN_EVENTS_PER_WINDOW=' .env || additions="${additions}
LOGGING_TOKEN_EVENTS_PER_WINDOW=10000"
    grep -q '^SANDBOX_RUNNER_WORKSPACE_DIR=' .env || additions="${additions}
SANDBOX_RUNNER_WORKSPACE_DIR=/var/lib/gateway/sandbox-workspaces"

    if [ -n "$additions" ] || [ "$reset_managed_internal_logs" -eq 1 ]; then
        backup_if_exists ".env"
        if [ "$reset_managed_internal_logs" -eq 1 ]; then
            set_env_value "CLICKHOUSE_MANAGED_INTERNAL_LOGS" "false"
            warn "Disabled managed ClickHouse internal-log cleanup for ${LOGGING_MODE} logging storage."
        fi
    fi
    if [ -n "$additions" ]; then
        {
            echo ""
            echo "# Added defaults"
            printf "%s\n" "$additions" | sed '/^$/d'
        } >> .env
        info "Added missing defaults to .env"
    fi
}

# ── Compose logging block helper ─────────────────────────────────────
_compose_logging() {
    if [[ "$OPT_LOG_ROTATION" =~ ^[yY]$ ]]; then
        cat << LOGEOF
    logging:
      driver: json-file
      options:
        max-size: "${OPT_LOG_MAX_SIZE}"
        max-file: "${OPT_LOG_MAX_FILE}"
LOGEOF
    fi
}

compose_depends_on() {
    echo "    depends_on:"
    if [ "$DATABASE_MODE" = "local" ]; then
        echo "      postgres:"
        echo "        condition: service_healthy"
    fi
    echo "      redis:"
    echo "        condition: service_healthy"
    if [ "$LOGGING_MODE" = "local" ]; then
        echo "      clickhouse:"
        echo "        condition: service_healthy"
    fi
}

compose_postgres_service() {
    [ "$DATABASE_MODE" = "local" ] || return 0
    cat << COMPOSEEOF

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: gateway
      POSTGRES_USER: gateway
      POSTGRES_PASSWORD: \${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    mem_limit: ${PG_MEM_LIMIT}
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gateway -d gateway"]
      interval: 5s
      timeout: 5s
      retries: 5
${logging_block}
COMPOSEEOF
}

compose_redis_service() {
    cat << COMPOSEEOF

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    mem_limit: ${REDIS_MEM_LIMIT}
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 5
${logging_block}
COMPOSEEOF
}

compose_clickhouse_service() {
    [ "$LOGGING_MODE" = "local" ] || return 0
    cat << COMPOSEEOF

  clickhouse:
    image: "${CLICKHOUSE_IMAGE_REF}"
    restart: unless-stopped
    environment:
      CLICKHOUSE_DB: \${CLICKHOUSE_DATABASE:-gateway_logs}
      CLICKHOUSE_USER: \${CLICKHOUSE_USERNAME:-gateway}
      CLICKHOUSE_PASSWORD: \${CLICKHOUSE_PASSWORD:-gateway}
    volumes:
      - clickhouse_data:/var/lib/clickhouse
      - ./clickhouse-config/gateway-safety.xml:/etc/clickhouse-server/config.d/gateway-safety.xml:ro
    mem_limit: ${CLICKHOUSE_MEM_LIMIT}
    healthcheck:
      test:
        [
          "CMD-SHELL",
          "clickhouse-client --user \"\$\${CLICKHOUSE_USER:-gateway}\" --password \"\$\${CLICKHOUSE_PASSWORD:-gateway}\" --query 'SELECT 1'",
        ]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 20s
${logging_block}
COMPOSEEOF
}

compose_volumes() {
    echo "volumes:"
    if [ "$DATABASE_MODE" = "local" ]; then
        echo "  postgres_data:"
    fi
    echo "  redis_data:"
    if [ "$LOGGING_MODE" = "local" ]; then
        echo "  clickhouse_data:"
    fi
}

write_clickhouse_safety_config() {
    [ "$LOGGING_MODE" = "local" ] || return 0
    mkdir -p clickhouse-config
    cat > clickhouse-config/gateway-safety.xml <<'CLICKHOUSECONFIG'
<clickhouse>
    <logger>
        <level>information</level>
        <size>50M</size>
        <count>3</count>
    </logger>
    <trace_log remove="1" />
    <text_log remove="1" />
    <part_log remove="1" />
    <metric_log remove="1" />
    <asynchronous_metric_log remove="1" />
    <query_metric_log remove="1" />
    <processors_profile_log remove="1" />
    <background_schedule_pool_log remove="1" />
    <query_log>
        <database>system</database>
        <table>query_log</table>
        <partition_by>toDate(event_date)</partition_by>
        <ttl>event_date + INTERVAL 1 DAY DELETE</ttl>
        <flush_interval_milliseconds>7500</flush_interval_milliseconds>
    </query_log>
</clickhouse>
CLICKHOUSECONFIG
    info "clickhouse-config/gateway-safety.xml"
}

# ── Write docker-compose.yml ─────────────────────────────────────────
write_compose() {
    if [ "$LOGGING_MODE" = "local" ]; then
        validate_clickhouse_image_ref
    fi
    backup_if_exists "docker-compose.yml"

    local logging_block=""
    if [[ "$OPT_LOG_ROTATION" =~ ^[yY]$ ]]; then
        logging_block="    logging:
      driver: json-file
      options:
        max-size: \"${OPT_LOG_MAX_SIZE}\"
        max-file: \"${OPT_LOG_MAX_FILE}\""
    fi

    local app_port
    if [ "$SETUP_WITH_DOMAIN" -eq 1 ]; then
        app_port='      - "127.0.0.1:3000:3000"'
    else
        app_port='      - "${BIND_HOST:-0.0.0.0}:3000:3000"'
    fi

    {
        cat << COMPOSEEOF
services:
  app:
    image: \${GATEWAY_IMAGE_REF}
    restart: unless-stopped
    ports:
${app_port}
      - "\${BIND_HOST:-0.0.0.0}:9443:9443"
    env_file: .env
    mem_limit: ${APP_MEM_LIMIT}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      # gateway-managed:start sandbox-workspace
      - \${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}:\${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}
      # gateway-managed:end sandbox-workspace
      - ./docker-compose.yml:/app/docker-compose.yml:ro
$(compose_depends_on)
    healthcheck:
      test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/health || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 30s
${logging_block}
COMPOSEEOF
        compose_postgres_service
        compose_redis_service
        compose_clickhouse_service
        compose_volumes
    } > docker-compose.yml

    info "docker-compose.yml"
}

# ── Start Services ────────────────────────────────────────────────────
start_services() {
    title "Starting Services"

    info "Pulling Docker images..."
    run_quiet docker_compose_run pull

    info "Starting services..."
    run_quiet docker_compose_run up -d

    info "Waiting for services to become healthy (this may take a minute on first start)..."
    local retries=60
    printf "  "
    while [ $retries -gt 0 ]; do
        if check_health "http://localhost:3000/health"; then
            break
        fi
        retries=$((retries - 1))
        printf "."
        sleep 3
    done
    echo ""

    if [ $retries -eq 0 ]; then
        echo ""
        warn "Services did not become healthy within 3 minutes."
        echo -e "  ${GRAY}Check logs:  docker compose logs${NC}"
        echo -e "  ${GRAY}Retry:       docker compose up -d${NC}"
        exit 1
    fi

    echo ""
    success "All services are healthy!"
}

# ── Add official nginx.org repository ────────────────────────────────
add_nginx_stable_repo() {
    if command -v apt-get &>/dev/null; then
        # Debian/Ubuntu
        run_quiet apt-get install -y curl gnupg2 ca-certificates lsb-release
        local distro
        distro=$(. /etc/os-release && echo "$ID")
        local codename
        codename=$(lsb_release -cs 2>/dev/null || . /etc/os-release && echo "${VERSION_CODENAME:-}")
        curl -fsSL "https://nginx.org/keys/nginx_signing.key" | gpg --dearmor -o /usr/share/keyrings/nginx-archive-keyring.gpg 2>>"$LOG_FILE"
        echo "deb [signed-by=/usr/share/keyrings/nginx-archive-keyring.gpg] http://nginx.org/packages/${distro} ${codename} nginx" \
            > /etc/apt/sources.list.d/nginx.list
        # Pin nginx.org packages higher
        cat > /etc/apt/preferences.d/99nginx << 'PINEOF'
Package: *
Pin: origin nginx.org
Pin-Priority: 900
PINEOF
        run_quiet apt-get update
    elif command -v yum &>/dev/null || command -v dnf &>/dev/null; then
        # RHEL/CentOS/Fedora
        cat > /etc/yum.repos.d/nginx.repo << 'YUMEOF'
[nginx-stable]
name=nginx stable repo
baseurl=http://nginx.org/packages/centos/$releasever/$basearch/
gpgcheck=1
enabled=1
gpgkey=https://nginx.org/keys/nginx_signing.key
module_hotfixes=true
YUMEOF
    else
        warn "Could not add nginx.org repo for this distro. Falling back to system package."
    fi
}

# ── Install Nginx on Host ────────────────────────────────────────────
install_nginx() {
    title "Installing Nginx"

    local nginx_version_choice="system"

    if command -v nginx &>/dev/null; then
        info "Nginx already installed: $(nginx -v 2>&1 | grep -o 'nginx/[0-9.]*')"
    else
        if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
            nginx_version_choice="$OPT_NGINX_VERSION"
        else
            echo -e "  ${BRAND_MINT}Nginx version:${NC}"
            echo -e "  ${GRAY}  1) System default  [default]${NC}"
            echo -e "  ${GRAY}  2) Stable (nginx.org repo)${NC}"
            echo -e "  ${GRAY}  3) Custom version${NC}"
            echo ""
            local nv_choice
            nv_choice=$(prompt_input "Choose" "1")
            case "$nv_choice" in
                2) nginx_version_choice="stable" ;;
                3) nginx_version_choice="custom" ;;
                *) nginx_version_choice="system" ;;
            esac
        fi

        if [ "$nginx_version_choice" = "stable" ]; then
            info "Adding official nginx.org repository..."
            add_nginx_stable_repo
        fi

        if [ "$nginx_version_choice" = "custom" ]; then
            local custom_pkg
            custom_pkg=$(prompt_input "Nginx package name or version (e.g. nginx=1.26.0-1~jammy)" "nginx")
            info "Installing ${custom_pkg}..."
            if command -v apt-get &>/dev/null; then
                run_quiet apt-get update
                apt_install_quiet "$custom_pkg"
            elif command -v yum &>/dev/null; then
                run_quiet yum install -y "$custom_pkg"
            elif command -v dnf &>/dev/null; then
                run_quiet dnf install -y "$custom_pkg"
            else
                error "Could not detect package manager. Install nginx manually and re-run."
            fi
        else
            info "Installing nginx..."
            if command -v apt-get &>/dev/null; then
                run_quiet apt-get update
                apt_install_quiet nginx
            elif command -v yum &>/dev/null; then
                run_quiet yum install -y nginx
            elif command -v dnf &>/dev/null; then
                run_quiet dnf install -y nginx
            elif command -v apk &>/dev/null; then
                run_quiet apk add nginx
            else
                error "Could not detect package manager. Install nginx manually and re-run."
            fi
        fi

        success "Nginx installed"
    fi

    # Write base nginx configs
    info "Writing nginx configuration..."

    mkdir -p /etc/nginx/conf.d/sites
    mkdir -p /etc/nginx/certs
    mkdir -p /etc/nginx/htpasswd
    mkdir -p /var/log/nginx
    mkdir -p /var/www/acme-challenge/.well-known/acme-challenge

    cat > /etc/nginx/nginx.conf << 'NGINXEOF'
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

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types
        text/plain
        text/css
        text/xml
        text/javascript
        application/json
        application/javascript
        application/xml
        application/xml+rss
        image/svg+xml;

    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;

    map $http_upgrade $connection_upgrade {
        default upgrade;
        ''      close;
    }

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/conf.d/sites/*.conf;
}
NGINXEOF

    cat > /etc/nginx/conf.d/default.conf << 'DEFAULTEOF'
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
DEFAULTEOF

    # Test and start nginx
    nginx -t >>"$LOG_FILE" 2>&1 || error "Nginx config test failed. Check ${LOG_FILE}."
    systemctl enable nginx >>"$LOG_FILE" 2>&1 || true
    systemctl restart nginx >>"$LOG_FILE" 2>&1 || nginx -s reload >>"$LOG_FILE" 2>&1 || true
    success "Nginx configured and running"

    # Auto-enroll and install the nginx daemon
    echo ""
    title "Installing Nginx Daemon"

    info "Creating node enrollment via Gateway API..."
    local enroll_response
    enroll_response=$(curl -s -X POST "http://localhost:3000/api/setup/enroll-node" \
        -H "Authorization: Bearer ${SETUP_TOKEN}" \
        -H "Content-Type: application/json" \
        -d '{"type":"nginx","hostname":"'"$(hostname -f 2>/dev/null || hostname)"'"}' \
        --max-time 15 2>>"$LOG_FILE") || true

    local enroll_token
    enroll_token=$(echo "$enroll_response" | grep -o '"enrollmentToken":"[^"]*"' | cut -d'"' -f4) || true
    local gateway_cert_sha256
    gateway_cert_sha256=$(echo "$enroll_response" | grep -o '"gatewayCertSha256":"[^"]*"' | cut -d'"' -f4) || true

    if [ -z "$enroll_token" ] || [ -z "$gateway_cert_sha256" ]; then
        warn "Could not auto-enroll node. You can install the daemon manually:"
        echo -e "  ${GRAY}curl -sSL ${GITLAB_API_URL}/${GITLAB_PROJECT_PATH}/-/raw/main/scripts/setup-daemon.sh | sudo bash${NC}"
        return 1
    else
        info "Downloading and running daemon setup script..."
        local daemon_script
        local setup_status=1
        daemon_script=$(mktemp_compat /tmp/gateway-setup-daemon)
        if curl -fsSL "${GITLAB_API_URL}/${GITLAB_PROJECT_PATH}/-/raw/main/scripts/setup-node.sh" -o "$daemon_script" 2>>"$LOG_FILE"; then
            chmod +x "$daemon_script"
            if bash "$daemon_script" -y --gateway "127.0.0.1:9443" --token "$enroll_token" --gateway-cert-sha256 "$gateway_cert_sha256" 2>>"$LOG_FILE"; then
                success "Nginx daemon installed and enrolled"
                setup_status=0
            else
                warn "Daemon setup failed. Check ${LOG_FILE} and retry manually."
            fi
        else
            warn "Could not download daemon setup script."
        fi
        rm -f "$daemon_script"
        return "$setup_status"
    fi
}

# ── Bootstrap Management SSL ──────────────────────────────────────────
bootstrap_ssl() {
    local domain="$1"
    local token="${SETUP_TOKEN}"

    # Only for FQDN domains
    if [ "$domain" = "localhost" ] || ! echo "$domain" | grep -q '\.'; then
        return 0
    fi

    echo ""

    # Determine SSL method
    local ssl_method="letsencrypt"

    if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
        if [ -n "${OPT_SSL_CERT:-}" ] && [ -n "${OPT_SSL_KEY:-}" ]; then
            ssl_method="custom"
            info "Using custom certificate for ${domain}..."
        else
            info "Issuing Let's Encrypt certificate for ${domain}..."
        fi
    else
        echo -e "  ${BRAND_MINT}SSL certificate for ${domain}:${NC}"
        echo -e "  ${GRAY}  1) Let's Encrypt (automatic, requires DNS pointing here)${NC}"
        echo -e "  ${GRAY}  2) Custom certificate (e.g. Cloudflare Origin, self-signed)${NC}"
        echo -e "  ${GRAY}  3) Skip (configure later from UI)${NC}"
        echo ""
        local choice
        choice=$(prompt_input "Choose" "1")
        case "$choice" in
            2) ssl_method="custom" ;;
            3) info "Skipping SSL setup."; return 0 ;;
            *) ssl_method="letsencrypt" ;;
        esac
    fi

    local http_code

    if [ "$ssl_method" = "custom" ]; then
        local cert_file key_file chain_file=""

        if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
            cert_file="${OPT_SSL_CERT}"
            key_file="${OPT_SSL_KEY}"
            chain_file="${OPT_SSL_CHAIN:-}"
        else
            cert_file=$(prompt_input "Path to certificate PEM file" "")
            key_file=$(prompt_input "Path to private key PEM file" "")
            chain_file=$(prompt_input "Path to chain PEM file (optional, press Enter to skip)" "")
        fi

        if [ ! -f "$cert_file" ]; then
            warn "Certificate file not found: ${cert_file}"
            return 1
        fi
        if [ ! -f "$key_file" ]; then
            warn "Key file not found: ${key_file}"
            return 1
        fi

        info "Uploading custom certificate for ${domain}..."

        local cert_pem key_pem chain_pem=""
        cert_pem=$(cat "$cert_file")
        key_pem=$(cat "$key_file")
        if [ -n "$chain_file" ] && [ -f "$chain_file" ]; then
            chain_pem=$(cat "$chain_file")
        fi

        local payload
        payload=$(python3 -c "
import json, sys
d = {'domain': sys.argv[1], 'certificatePem': sys.argv[2], 'privateKeyPem': sys.argv[3]}
if sys.argv[4]: d['chainPem'] = sys.argv[4]
print(json.dumps(d))
" "$domain" "$cert_pem" "$key_pem" "$chain_pem" 2>/dev/null) || \
        payload=$(node -e "
const d = {domain:process.argv[1],certificatePem:process.argv[2],privateKeyPem:process.argv[3]};
if(process.argv[4]) d.chainPem=process.argv[4];
console.log(JSON.stringify(d));
" "$domain" "$cert_pem" "$key_pem" "$chain_pem" 2>/dev/null) || {
            warn "Failed to encode certificate. Ensure python3 or node is available."
            return 1
        }

        http_code=$(curl -s -o /tmp/gateway_ssl_response.json -w "%{http_code}" \
            -X POST "http://localhost:3000/api/setup/management-ssl-upload" \
            -H "Authorization: Bearer ${token}" \
            -H "Content-Type: application/json" \
            -d "$payload" \
            --max-time 30 2>>"$LOG_FILE") || true
    else
        info "Requesting ACME certificate for ${domain}..."
        info "This may take up to 60 seconds..."

        http_code=$(curl -s -o /tmp/gateway_ssl_response.json -w "%{http_code}" \
            -X POST "http://localhost:3000/api/setup/management-ssl" \
            -H "Authorization: Bearer ${token}" \
            -H "Content-Type: application/json" \
            -d "{\"domain\":\"${domain}\"}" \
            --max-time 120 2>>"$LOG_FILE") || true
    fi

    if [ "$http_code" = "200" ]; then
        success "SSL certificate configured!"
        info "Management UI is now accessible at https://${domain}"
        rm -f /tmp/gateway_ssl_response.json
        return 0
    else
        local response
        response=$(cat /tmp/gateway_ssl_response.json 2>/dev/null || echo "No response")
        warn "SSL setup failed (HTTP ${http_code})."
        echo -e "  ${GRAY}Response: ${response}${NC}"
        if [ "$http_code" = "404" ]; then
            echo -e "  ${GRAY}The setup API is already locked or expired. Configure SSL from the authenticated Gateway UI.${NC}"
        elif [ "$ssl_method" = "letsencrypt" ]; then
            echo -e "  ${GRAY}Ensure DNS for ${domain} points to this server.${NC}"
        fi
        echo -e "  ${GRAY}You can configure SSL later from the Gateway UI.${NC}"
    fi

    rm -f /tmp/gateway_ssl_response.json
    return 1
}

mark_setup_complete() {
    local http_code
    http_code=$(curl -s -o /tmp/gateway_setup_complete_response.json -w "%{http_code}" \
        -X POST "http://localhost:3000/api/setup/complete" \
        -H "Authorization: Bearer ${SETUP_TOKEN}" \
        -H "Content-Type: application/json" \
        --max-time 15 2>>"$LOG_FILE") || true

    if [ "$http_code" = "200" ]; then
        info "Setup API locked."
        SETUP_BOOTSTRAP=false
        set_env_value SETUP_BOOTSTRAP false
    else
        local response
        response=$(cat /tmp/gateway_setup_complete_response.json 2>/dev/null || echo "No response")
        warn "Could not lock setup API automatically (HTTP ${http_code})."
        echo -e "  ${GRAY}Response: ${response}${NC}"
        echo -e "  ${GRAY}Setup API also locks automatically one hour after first start.${NC}"
    fi

    rm -f /tmp/gateway_setup_complete_response.json
}

# ── Summary ───────────────────────────────────────────────────────────
show_summary() {
    echo ""
    echo -e "${SUCCESS_TAG} SUCCESS ${NC} Gateway is running!"
    echo ""
    echo -e "  Management UI   ${BRAND_MINT}${APP_URL}${NC}"

    if [ "$SETUP_WITH_DOMAIN" -eq 1 ]; then
        echo -e "  Proxy (HTTP)    ${BRAND_MINT}:80${NC}"
        echo -e "  Proxy (HTTPS)   ${BRAND_MINT}:443${NC}"
        echo -e "  gRPC (daemons)  ${BRAND_MINT}:9443${NC}"
    else
        echo -e "  gRPC (daemons)  ${BRAND_MINT}:9443${NC}"
    fi

    echo ""
    echo -e "  ${GRAY}Useful commands:${NC}"
    echo -e "  ${GRAY}  docker compose logs -f          View logs${NC}"
    echo -e "  ${GRAY}  docker compose restart           Restart services${NC}"
    echo -e "  ${GRAY}  docker compose pull && ${NC}"
    echo -e "  ${GRAY}    docker compose up -d           Update to latest version${NC}"

    if [ "$SETUP_WITH_DOMAIN" -eq 1 ]; then
        echo ""
        echo -e "  ${GRAY}Service status:${NC}"
        echo -e "  ${GRAY}  systemctl status nginx-daemon     Daemon status${NC}"
        echo -e "  ${GRAY}  systemctl status nginx             Nginx status${NC}"
    fi

    echo ""
    echo -e "  ${WARN_TAG} IMPORTANT ${NC}"
    echo -e "  ${GRAY}  PKI Master Key is stored in .env — back it up securely!${NC}"
    echo -e "  ${GRAY}  First OIDC login automatically becomes admin.${NC}"
    echo ""
    info "Log file: ${LOG_FILE}"
    echo ""
}

# ── Main ──────────────────────────────────────────────────────────────
main() {
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --version|-v)
                VERSION="$2"
                shift 2
                ;;
            --image)
                GATEWAY_IMAGE="$2"
                shift 2
                ;;
            --gitlab-url)
                GITLAB_API_URL="$2"
                GITLAB_API="${GITLAB_API_URL}/api/v4/projects/$(echo "$GITLAB_PROJECT_PATH" | sed 's|/|%2F|g')"
                shift 2
                ;;
            --gitlab-project)
                GITLAB_PROJECT_PATH="$2"
                GITLAB_API="${GITLAB_API_URL}/api/v4/projects/$(echo "$GITLAB_PROJECT_PATH" | sed 's|/|%2F|g')"
                shift 2
                ;;
            --domain)
                OPT_DOMAIN="$2"
                shift 2
                ;;
            --acme-email)
                OPT_ACME_EMAIL="$2"
                shift 2
                ;;
            --oidc-issuer)
                OPT_OIDC_ISSUER="$2"
                shift 2
                ;;
            --oidc-client-id)
                OPT_OIDC_CLIENT_ID="$2"
                shift 2
                ;;
            --oidc-client-secret)
                OPT_OIDC_CLIENT_SECRET="$2"
                shift 2
                ;;
            --acme-staging)
                OPT_ACME_STAGING="true"
                shift
                ;;
            --ssl-cert)
                OPT_SSL_CERT="$2"
                shift 2
                ;;
            --ssl-key)
                OPT_SSL_KEY="$2"
                shift 2
                ;;
            --ssl-chain)
                OPT_SSL_CHAIN="$2"
                shift 2
                ;;
            --resource-profile)
                OPT_RESOURCE_PROFILE="$2"
                shift 2
                ;;
            --remote-database)
                OPT_DATABASE_MODE="remote"
                shift
                ;;
            --database-url)
                OPT_DATABASE_URL="$2"
                OPT_DATABASE_MODE="remote"
                shift 2
                ;;
            --logging-mode)
                OPT_LOGGING_MODE="$2"
                shift 2
                ;;
            --clickhouse-url)
                OPT_CLICKHOUSE_URL="$2"
                OPT_LOGGING_MODE="remote"
                shift 2
                ;;
            --clickhouse-username)
                OPT_CLICKHOUSE_USERNAME="$2"
                shift 2
                ;;
            --clickhouse-password)
                OPT_CLICKHOUSE_PASSWORD="$2"
                shift 2
                ;;
            --clickhouse-database)
                OPT_CLICKHOUSE_DATABASE="$2"
                shift 2
                ;;
            --clickhouse-table)
                OPT_CLICKHOUSE_LOGS_TABLE="$2"
                shift 2
                ;;
            --disable-logging)
                OPT_LOGGING_MODE="disabled"
                OPT_DISABLE_LOGGING=1
                shift
                ;;
            --log-max-size)
                OPT_LOG_MAX_SIZE="$2"
                shift 2
                ;;
            --log-max-file)
                OPT_LOG_MAX_FILE="$2"
                shift 2
                ;;
            --no-log-rotation)
                OPT_LOG_ROTATION="N"
                shift
                ;;
            --no-restrict-env)
                OPT_RESTRICT_ENV="N"
                shift
                ;;
            --nginx-version)
                OPT_NGINX_VERSION="$2"
                shift 2
                ;;
            --skip-start)
                OPT_SKIP_START=1
                shift
                ;;
            --non-interactive|-y)
                NON_INTERACTIVE=1
                NO_LOGO=1
                shift
                ;;
            --no-logo)
                NO_LOGO=1
                shift
                ;;
            -h|--help)
                echo "Usage: install.sh [OPTIONS]"
                echo ""
                echo "Options:"
                echo "  --version, -v <tag>     Image version to install (default: auto-detect latest)"
                echo "  --image <image>         Custom image reference"
                echo "  --gitlab-url <url>      GitLab instance URL (default: https://gitlab.wiolett.net)"
                echo "  --gitlab-project <path> GitLab project path (default: wiolett/gateway)"
                echo "  --no-logo               Suppress the logo banner"
                echo "  -h, --help              Show this help"
                echo ""
                echo "Non-interactive mode:"
                echo "  -y, --non-interactive   Skip all prompts, use flags/env vars for config"
                echo "  --domain <domain>       Management domain — enables domain+nginx mode"
                echo "                          (omit for direct access on :3000)"
                echo "  --acme-email <email>    Let's Encrypt email (default: admin@example.com)"
                echo "  --oidc-issuer <url>     OIDC issuer URL"
                echo "  --oidc-client-id <id>   OIDC client ID (default: gateway)"
                echo "  --oidc-client-secret <s> OIDC client secret"
                echo "  --acme-staging          Use Let's Encrypt staging environment"
                echo "  --ssl-cert <path>       Custom SSL certificate PEM file (BYO cert)"
                echo "  --ssl-key <path>        Custom SSL private key PEM file"
                echo "  --ssl-chain <path>      Custom SSL chain PEM file (optional)"
                echo "  --resource-profile <p>  Resource profile: small, medium, large, custom"
                echo "  --remote-database       Use a remote PostgreSQL database"
                echo "  --database-url <url>    Remote PostgreSQL URL"
                echo "  --logging-mode <mode>   Structured logging: local, remote, disabled"
                echo "  --clickhouse-url <url>  Remote ClickHouse HTTP URL"
                echo "  --clickhouse-username <u> ClickHouse username (default: gateway)"
                echo "  --clickhouse-password <p> ClickHouse password"
                echo "  --clickhouse-database <db> ClickHouse database (default: gateway_logs)"
                echo "  --clickhouse-table <t>  ClickHouse logs table (default: logs)"
                echo "  --disable-logging       Disable structured logging"
                echo "  --log-max-size <size>   Max log file size (default: 50m)"
                echo "  --log-max-file <n>      Max number of log files (default: 3)"
                echo "  --no-log-rotation       Disable Docker log rotation"
                echo "  --no-restrict-env       Don't restrict .env to owner-only permissions"
                echo "  --nginx-version <v>     Nginx version: system, stable, custom"
                echo "  --skip-start            Generate files only, don't start services"
                echo ""
                echo "Environment variables:"
                echo "  GITLAB_API_URL          GitLab instance URL"
                echo "  GITLAB_PROJECT_PATH     GitLab project path"
                echo "  GATEWAY_RESOURCE_PROFILE  Resource profile (small/medium/large/custom)"
                echo "  GATEWAY_DATABASE_MODE   Database mode (local/remote)"
                echo "  GATEWAY_DATABASE_URL    Remote PostgreSQL URL"
                echo "  GATEWAY_LOGGING_MODE    Structured logging mode (local/remote/disabled)"
                echo "  GATEWAY_CLICKHOUSE_URL  Remote ClickHouse HTTP URL"
                echo "  GATEWAY_DISABLE_LOGGING Disable structured logging when true/1"
                echo "  GATEWAY_LOG_ROTATION    Enable log rotation (Y/N, default: Y)"
                echo "  GATEWAY_LOG_MAX_SIZE    Max log size (default: 50m)"
                echo "  GATEWAY_LOG_MAX_FILE    Max log files (default: 3)"
                echo "  GATEWAY_RESTRICT_ENV    Restrict .env permissions (Y/N, default: Y)"
                echo "  GATEWAY_NGINX_VERSION   Nginx version (system/stable/custom)"
                echo ""
                echo "Examples:"
                echo "  # With domain + Let's Encrypt:"
                echo "  bash install.sh -y --domain gateway.example.com \\"
                echo "    --oidc-issuer https://id.example.com --oidc-client-secret s3cret"
                echo ""
                echo "  # With domain + custom cert:"
                echo "  bash install.sh -y --domain gateway.example.com \\"
                echo "    --ssl-cert /path/to/cert.pem --ssl-key /path/to/key.pem"
                echo ""
                echo "  # Direct access (no domain):"
                echo "  bash install.sh -y \\"
                echo "    --oidc-issuer https://id.example.com --oidc-client-secret s3cret"
                echo ""
                echo "  # Custom GitLab + resource profile:"
                echo "  bash install.sh -y --gitlab-url https://git.example.com \\"
                echo "    --gitlab-project myorg/gateway --resource-profile large"
                exit 0
                ;;
            *)
                echo "Unknown option: $1"
                exit 1
                ;;
        esac
    done

    : > "$LOG_FILE"

    resolve_version

    if [ -t 1 ] && command -v clear &>/dev/null; then
        clear
    fi

    [[ "$NO_LOGO" -eq 0 ]] && show_logo

    show_intro

    check_prerequisites

    # Check for existing installation
    if [ -f .env ]; then
        EXISTING_ENV_DETECTED=1
        echo ""
        warn "Existing .env file detected."
        if [[ "$NON_INTERACTIVE" -eq 1 ]]; then
            info "Non-interactive mode: overwriting existing .env."
        elif ! prompt_yes_no "Overwrite configuration?" "N"; then
            info "Keeping existing .env. Updating compose file only."
            # Still need resource profile for compose
            if [ -z "$APP_MEM_LIMIT" ]; then
                apply_resource_profile "medium"
            fi
            title "Writing Files"
            infer_storage_config_from_env
            ensure_clickhouse_env
            write_clickhouse_safety_config
            write_compose
            if [[ "$OPT_SKIP_START" -eq 0 ]]; then
                start_services
            else
                info "Skipping service start (--skip-start)."
            fi
            APP_URL=$(grep -E '^APP_URL=' .env | cut -d= -f2- || echo "http://localhost:3000")
            show_summary
            return
        fi
        echo ""
    fi

    gather_config

    generate_secrets

    title "Writing Files"

    write_env
    write_clickhouse_safety_config
    write_compose

    if [[ "$OPT_SKIP_START" -eq 0 ]]; then
        start_services

        if [[ "${SETUP_BOOTSTRAP:-false}" == "true" || "${SETUP_BOOTSTRAP:-false}" == "1" ]]; then
            local setup_complete_ready=1
            if [ "$SETUP_WITH_DOMAIN" -eq 1 ]; then
                if ! install_nginx; then
                    setup_complete_ready=0
                fi
                # Wait for daemon to register with Gateway before requesting SSL
                info "Waiting for daemon to connect..."
                for i in $(seq 1 15); do
                    if curl -sf "http://localhost:3000/api/setup/enroll-node" -X OPTIONS >/dev/null 2>&1; then
                        # Check if any nginx node is online
                        local node_check
                        node_check=$(curl -sf -H "Authorization: Bearer ${SETUP_TOKEN}" \
                            "http://localhost:3000/api/nodes?type=nginx&status=online&limit=1" 2>/dev/null) || true
                        if echo "$node_check" | grep -q '"status":"online"'; then
                            break
                        fi
                    fi
                    sleep 2
                done
                if ! bootstrap_ssl "$DOMAIN"; then
                    setup_complete_ready=0
                fi
            fi
            if [ "$setup_complete_ready" -eq 1 ]; then
                mark_setup_complete
            else
                warn "Setup API left open for recovery; it will lock automatically one hour after first start."
            fi
        else
            info "Setup API bootstrap is disabled for this existing installation."
        fi
    else
        info "Skipping service start (--skip-start)."
    fi

    show_summary
}

if [[ "${GATEWAY_INSTALLER_LIBRARY_MODE:-0}" != "1" ]]; then
    main "$@"
fi
