#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

DEFAULT_IMAGE="registry.gitlab.wiolett.net/wiolett/gateway"
DOCKER_COMPOSE_CLI_IMAGE_REF="docker.io/library/docker:27-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c"
DEFAULT_INSTALL_DIR="/opt/gateway"
GITLAB_API_URL="${GITLAB_API_URL:-https://gitlab.wiolett.net}"
GITLAB_PROJECT_PATH="${GITLAB_PROJECT_PATH:-wiolett/gateway}"
INSTALL_DIR="${GATEWAY_INSTALL_DIR:-$DEFAULT_INSTALL_DIR}"
IMAGE="${GATEWAY_IMAGE:-$DEFAULT_IMAGE}"
TRANSPORT="${GATEWAY_WEB_TRANSPORT:-}"
SOURCE_DIR="${GATEWAY_SOURCE_DIR:-}"
LOG_FILE="${GATEWAY_INSTALL_LOG_FILE:-/tmp/gateway-install.log}"
DRY_RUN=0
UPDATE_SIGNING_PUBLIC_KEY='-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAxLXGD8vCYQCYboK301miZXyAaoOLc43zFVnMlH3FeWg=
-----END PUBLIC KEY-----'

# ── Colors ────────────────────────────────────────────────────────────
BRAND_MINT='\033[38;2;140;176;132m'
GRAY='\033[0;90m'
NC='\033[0m'
BOLD='\033[1m'
INFO_TAG='\033[48;2;74;74;74m\033[38;2;185;185;185m'
WARN_TAG='\033[48;2;112;97;48m\033[38;2;244;234;198m'
ERROR_TAG='\033[48;2;96;61;43m\033[38;2;245;221;202m'
SUCCESS_TAG='\033[42m\033[97m'
GUIDE_ACTIVE=0

info() {
  if [[ "$GUIDE_ACTIVE" -eq 1 ]]; then
    echo -e "${BRAND_MINT}│${NC} ${INFO_TAG} INFO ${NC} $*"
  else
    echo -e "${INFO_TAG} INFO ${NC} $*"
  fi
}
warn() {
  if [[ "$GUIDE_ACTIVE" -eq 1 ]]; then
    echo -e "${BRAND_MINT}│${NC} ${WARN_TAG} WARN ${NC} $*"
  else
    echo -e "${WARN_TAG} WARN ${NC} $*"
  fi
}
ok() {
  if [[ "$GUIDE_ACTIVE" -eq 1 ]]; then
    echo -e "${BRAND_MINT}│${NC} \033[48;2;140;176;132m\033[30m  OK  ${NC} $*"
  else
    echo -e "\033[48;2;140;176;132m\033[30m  OK  ${NC} $*"
  fi
}
die() {
  echo -e "${ERROR_TAG} ERROR ${NC} $*" >&2
  echo "" >&2
  echo -e "${ERROR_TAG} ■ ${NC} ${BOLD}Installation completed with errors.${NC}" >&2
  echo "" >&2
  exit 1
}

guide() { echo -e "${BRAND_MINT}│${NC} $*"; }
guide_blank() { echo -e "${BRAND_MINT}│${NC}"; }
guide_start() { GUIDE_ACTIVE=1; echo -e "${BRAND_MINT}╭${NC} $*"; }
selector_title() { echo -e "${BRAND_MINT}◆${NC} ${GRAY}$*${NC}"; }

short_digest() {
  local value="${1#sha256:}"
  if [[ ${#value} -le 12 ]]; then
    printf '%s' "$value"
  else
    printf '%s...%s' "${value:0:4}" "${value: -4}"
  fi
}

prompt_menu() {
  local default="$1"
  shift
  local -a options=("$@")
  local selected=$((default - 1)) key sequence tty="/dev/tty" index
  [[ -r "$tty" && -w "$tty" && "${TERM:-dumb}" != "dumb" ]] || { echo "$default"; return; }
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
}

show_header() {
  local content_width=43 frame_width rule
  if [[ -t 1 ]] && command -v clear >/dev/null 2>&1; then
    clear
  fi
  frame_width=$((content_width + 2))
  printf -v rule '%*s' "$frame_width" ''
  rule="${rule// /─}"
  echo -e "${BRAND_MINT}╭${rule}╮${NC}"
  printf "${BRAND_MINT}│${NC} ${BOLD}${BRAND_MINT}%-*.*s${NC} ${BRAND_MINT}│${NC}\n" "$content_width" "$content_width" "Gateway Installer"
  printf "${BRAND_MINT}│${NC} ${GRAY}%-*.*s${NC} ${BRAND_MINT}│${NC}\n" "$content_width" "$content_width" "Self-hosted infrastructure control plane"
  echo -e "${BRAND_MINT}╰${rule}╯${NC}"
  echo ""
}

run_quiet() {
  local label="$1"
  shift
  if "$@" </dev/null >>"$LOG_FILE" 2>&1; then
    return
  fi
  die "${label} failed. Check ${LOG_FILE} for details."
}

# ── Docker Engine bootstrap ─────────────────────────────────────────
# Keep this installer self-contained: a fresh Gateway host must not require
# Docker to have been installed manually beforehand.  The package flow mirrors
# scripts/setup-docker-node.sh so Gateway and Docker-node installation use the
# same official Docker Engine repositories and Compose v2 plugin.
command_exists() { command -v "$1" >/dev/null 2>&1; }

run_root_quiet() {
  local label="$1"
  shift
  if [[ $EUID -eq 0 ]]; then
    run_quiet "$label" "$@"
    return
  fi
  command_exists sudo || die "${label} requires root privileges. Re-run as root or install sudo."
  run_quiet "$label" sudo "$@"
}

run_root_best_effort() {
  local label="$1"
  shift
  if [[ $EUID -eq 0 ]]; then
    "$@" </dev/null >>"$LOG_FILE" 2>&1 || true
    return
  fi
  command_exists sudo || die "${label} requires root privileges. Re-run as root or install sudo."
  sudo "$@" </dev/null >>"$LOG_FILE" 2>&1 || true
}

detect_docker_os() {
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    DOCKER_OS_ID="${ID:-unknown}"
    DOCKER_OS_LIKE="${ID_LIKE:-$DOCKER_OS_ID}"
    DOCKER_OS_CODENAME="${VERSION_CODENAME:-}"
  else
    DOCKER_OS_ID="unknown"
    DOCKER_OS_LIKE="unknown"
    DOCKER_OS_CODENAME=""
  fi
}

docker_repo_distro_family() {
  case "$DOCKER_OS_ID" in
    ubuntu) printf 'ubuntu' ;;
    debian) printf 'debian' ;;
    fedora) printf 'fedora' ;;
    rhel) printf 'rhel' ;;
    centos|centos_stream) printf 'centos' ;;
    *)
      if [[ "$DOCKER_OS_LIKE" == *ubuntu* ]]; then
        printf 'ubuntu'
      elif [[ "$DOCKER_OS_LIKE" == *debian* ]]; then
        printf 'debian'
      elif [[ "$DOCKER_OS_LIKE" == *fedora* ]]; then
        printf 'fedora'
      elif [[ "$DOCKER_OS_LIKE" == *rhel* || "$DOCKER_OS_LIKE" == *centos* ]]; then
        printf 'rhel'
      fi
      ;;
  esac
}

install_docker_packages() {
  if command_exists apt-get; then
    if [[ "${DOCKER_APT_UPDATED:-0}" -eq 0 ]]; then
      run_root_quiet "Refreshing package metadata" apt-get update
      DOCKER_APT_UPDATED=1
    fi
    run_root_quiet "Installing Docker dependencies" apt-get install -y "$@"
  elif command_exists dnf; then
    run_root_quiet "Installing Docker dependencies" dnf install -y "$@"
  elif command_exists yum; then
    run_root_quiet "Installing Docker dependencies" yum install -y "$@"
  else
    die "Could not detect a supported package manager for Docker installation."
  fi
}

ensure_curl_for_docker() {
  command_exists curl && return
  info "curl was not found; installing it for Docker setup"
  install_docker_packages curl ca-certificates
  ok "curl installed"
}

write_docker_apt_source() {
  local source_file="/etc/apt/sources.list.d/docker.sources"
  local source
  source="Types: deb
URIs: https://download.docker.com/linux/${1}
Suites: ${2}
Components: stable
Architectures: ${3}
Signed-By: /etc/apt/keyrings/docker.asc"

  if [[ $EUID -eq 0 ]]; then
    printf '%s\n' "$source" >"$source_file" || die "Could not write Docker apt repository configuration."
  else
    command_exists sudo || die "Writing the Docker apt repository requires root privileges."
    if ! printf '%s\n' "$source" | sudo tee "$source_file" >/dev/null 2>>"$LOG_FILE"; then
      die "Could not write Docker apt repository configuration. Check ${LOG_FILE} for details."
    fi
  fi
}

setup_docker_apt_repository() {
  local repo_distro="$1" codename arch
  install_docker_packages ca-certificates curl gnupg
  run_root_quiet "Preparing Docker apt keyring" install -m 0755 -d /etc/apt/keyrings
  run_root_quiet "Downloading Docker signing key" curl -fsSL "https://download.docker.com/linux/${repo_distro}/gpg" -o /etc/apt/keyrings/docker.asc
  run_root_quiet "Configuring Docker signing key" chmod a+r /etc/apt/keyrings/docker.asc
  codename="$DOCKER_OS_CODENAME"
  if [[ -z "$codename" ]] && command_exists lsb_release; then
    codename="$(lsb_release -cs 2>/dev/null || true)"
  fi
  [[ -n "$codename" ]] || die "Could not determine the distribution codename for Docker installation."
  arch="$(dpkg --print-architecture)"
  write_docker_apt_source "$repo_distro" "$codename" "$arch"
  DOCKER_APT_UPDATED=0
}

setup_docker_rpm_repository() {
  local repo_distro="$1"
  ensure_curl_for_docker
  if command_exists dnf; then
    install_docker_packages dnf-plugins-core
  else
    install_docker_packages yum-utils
  fi
  run_root_quiet "Configuring Docker package repository" curl -fsSL "https://download.docker.com/linux/${repo_distro}/docker-ce.repo" -o /etc/yum.repos.d/docker-ce.repo
}

remove_conflicting_docker_packages() {
  local repo_family="$1"
  case "$repo_family" in
    ubuntu|debian)
      run_root_best_effort "Removing conflicting Docker packages" apt-get remove -y docker.io docker-compose docker-compose-v2 docker-doc podman-docker containerd runc
      DOCKER_APT_UPDATED=0
      ;;
    fedora|centos|rhel)
      if command_exists dnf; then
        run_root_best_effort "Removing conflicting Docker packages" dnf remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine podman runc
      else
        run_root_best_effort "Removing conflicting Docker packages" yum remove -y docker docker-client docker-client-latest docker-common docker-latest docker-latest-logrotate docker-logrotate docker-engine podman runc
      fi
      ;;
  esac
}

install_docker_engine() {
  local repo_family
  detect_docker_os
  repo_family="$(docker_repo_distro_family)"
  [[ -n "$repo_family" ]] || die "Automatic Docker installation is supported only on Debian, Ubuntu, Fedora, CentOS, and RHEL."

  info "Installing Docker Engine and Docker Compose v2 plugin"
  remove_conflicting_docker_packages "$repo_family"
  case "$repo_family" in
    ubuntu|debian)
      setup_docker_apt_repository "$repo_family"
      install_docker_packages docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
    fedora|centos|rhel)
      setup_docker_rpm_repository "$repo_family"
      install_docker_packages docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
      ;;
  esac
  ok "Docker Engine and Docker Compose v2 installed"
}

select_docker_command() {
  if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
    return 0
  fi
  if command_exists sudo && sudo docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
    return 0
  fi
  return 1
}

ensure_docker_running() {
  select_docker_command && return
  info "Starting Docker service"
  if command_exists systemctl; then
    run_root_quiet "Starting Docker service" systemctl enable --now docker
  elif command_exists rc-service; then
    command_exists rc-update && run_root_quiet "Enabling Docker service" rc-update add docker default
    run_root_quiet "Starting Docker service" rc-service docker start
  elif command_exists service; then
    run_root_quiet "Starting Docker service" service docker start
  else
    die "Docker is installed but no supported service manager was found. Start Docker, then run this installer again."
  fi

  local retries=5
  while [[ "$retries" -gt 0 ]]; do
    if select_docker_command; then
      ok "Docker service is running"
      return
    fi
    retries=$((retries - 1))
    sleep 2
  done
  die "Docker is installed but the daemon is not reachable. Check ${LOG_FILE} for details."
}

ensure_docker_available() {
  if ! command_exists docker; then
    guide_start "${GRAY}Preparing Docker Engine:${NC}"
    guide_blank
    info "Docker was not found on this host"
    ensure_curl_for_docker
    install_docker_engine
    guide_blank
  fi
  ensure_docker_running
}

json_string_field() {
  local file="$1" key="$2"
  sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$file" | head -n1
}

json_number_field() {
  local file="$1" key="$2"
  sed -n "s/.*\"${key}\"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p" "$file" | head -n1
}

decode_base64url() {
  local value="$1" output="$2"
  value="${value//-/+}"
  value="${value//_/\/}"
  case $((${#value} % 4)) in
    0) ;;
    2) value+="==" ;;
    3) value+="=" ;;
    *) return 1 ;;
  esac
  printf '%s' "$value" | openssl base64 -d -A >"$output"
}

verify_signed_release() {
  local version="$1" encoded_project="$2"
  local tmp_dir manifest_file payload_file signature_file key_file
  local payload signature kind manifest_version tag image digest image_ref relay_build_version relay_protocol_major relay_image_ref relay_digest connector_image_ref connector_image connector_digest secure_connector_image_ref secure_connector_image secure_connector_digest

  tmp_dir="$(mktemp -d)"
  manifest_file="${tmp_dir}/gateway-image.update.json"
  payload_file="${tmp_dir}/payload.json"
  signature_file="${tmp_dir}/signature.bin"
  key_file="${tmp_dir}/update-signing-public-key.pem"

  info "Verifying signed release manifest for ${version}"
  if ! curl -fsSL "${GITLAB_API_URL}/api/v4/projects/${encoded_project}/packages/generic/gateway/${version}/gateway-image.update.json" -o "$manifest_file" >>"$LOG_FILE" 2>&1; then
    rm -rf "$tmp_dir"
    die "Could not download the signed release manifest. Check ${LOG_FILE} for details."
  fi

  payload="$(json_string_field "$manifest_file" payload)"
  signature="$(json_string_field "$manifest_file" signature)"
  if [[ -z "$payload" || -z "$signature" ]]; then
    rm -rf "$tmp_dir"
    die "Signed release manifest is malformed."
  fi
  if ! decode_base64url "$payload" "$payload_file" 2>>"$LOG_FILE" ||
    ! decode_base64url "$signature" "$signature_file" 2>>"$LOG_FILE"; then
    rm -rf "$tmp_dir"
    die "Signed release manifest contains invalid base64 data."
  fi
  printf '%s\n' "$UPDATE_SIGNING_PUBLIC_KEY" >"$key_file"
  if ! openssl pkeyutl -verify -rawin -pubin -inkey "$key_file" -in "$payload_file" -sigfile "$signature_file" >>"$LOG_FILE" 2>&1; then
    rm -rf "$tmp_dir"
    die "Signed release manifest signature verification failed."
  fi

  kind="$(json_string_field "$payload_file" kind)"
  manifest_version="$(json_string_field "$payload_file" version)"
  tag="$(json_string_field "$payload_file" tag)"
  image="$(json_string_field "$payload_file" image)"
  digest="$(json_string_field "$payload_file" digest)"
  image_ref="$(json_string_field "$payload_file" imageRef)"
  relay_build_version="$(json_string_field "$payload_file" relayBuildVersion)"
  relay_protocol_major="$(json_number_field "$payload_file" relayProtocolMajor)"
  relay_image_ref="$(json_string_field "$payload_file" relayImageRef)"
  connector_image_ref="$(json_string_field "$payload_file" databaseConnectorImage)"
  secure_connector_image_ref="$(json_string_field "$payload_file" secureLinkConnectorImage)"
  if [[ "$kind" != "gateway-image" || "$manifest_version" != "$version" || "$tag" != "$version" ||
    "$image" != "$IMAGE" || ! "$digest" =~ ^sha256:[a-f0-9]{64}$ || "$image_ref" != "${IMAGE}@${digest}" ]]; then
    rm -rf "$tmp_dir"
    die "Signed release manifest does not match the requested Gateway image."
  fi
  if [[ -n "$connector_image_ref" ]]; then
    connector_image="${IMAGE}/database-connector"
    connector_digest="${connector_image_ref##*@}"
    if [[ "$connector_image_ref" != "${connector_image}@${connector_digest}" || ! "$connector_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
      rm -rf "$tmp_dir"
      die "Signed release manifest contains an invalid database connector image."
    fi
  fi
  if [[ -n "$secure_connector_image_ref" ]]; then
    secure_connector_image="${IMAGE}/secure-link-connector"
    secure_connector_digest="${secure_connector_image_ref##*@}"
    if [[ "$secure_connector_image_ref" != "${secure_connector_image}@${secure_connector_digest}" || ! "$secure_connector_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
      rm -rf "$tmp_dir"
      die "Signed release manifest contains an invalid secure-link connector image."
    fi
  fi
  relay_digest="${relay_image_ref##*@}"
  if [[ ! "$relay_build_version" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ||
    ! "$relay_protocol_major" =~ ^[1-9][0-9]*$ || "$relay_image_ref" != "${IMAGE}/relay@${relay_digest}" ||
    ! "$relay_digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
    rm -rf "$tmp_dir"
    die "Signed release manifest contains invalid relay metadata."
  fi
  rm -rf "$tmp_dir"

  IMAGE_REF="$image_ref"
  RELAY_BUILD_VERSION="$relay_build_version"
  RELAY_PROTOCOL_MAJOR="$relay_protocol_major"
  RELAY_IMAGE_REF="$relay_image_ref"
  DATABASE_CONNECTOR_IMAGE_REF="$connector_image_ref"
  SECURE_LINK_CONNECTOR_IMAGE_REF="$secure_connector_image_ref"
  ok "Release ${version} verified (SHA-256: $(short_digest "$digest"))"
}

local_source_checksum() {
  (
    cd "$SOURCE_DIR"
    find . -type f \
      ! -path './.git/*' \
      ! -path './node_modules/*' \
      ! -path './.memory/*' \
      -print0 |
      LC_ALL=C sort -z |
      xargs -0 sha256sum
  ) | sha256sum | awk '{print $1}'
}

prepare_install_metadata() {
  if [[ -n "$SOURCE_DIR" ]]; then
    [[ "$FRESH" == 1 ]] || die "--source-dir is supported only for a fresh Gateway installation"
    [[ -d "$SOURCE_DIR" && -f "$SOURCE_DIR/Dockerfile" && -f "$SOURCE_DIR/package.json" ]] || \
      die "--source-dir must point to a Gateway source checkout"
    SOURCE_DIR="$(cd "$SOURCE_DIR" && pwd)"
    VERSION="local-$(date -u +%Y%m%d%H%M%S)"
    IMAGE_REF="${IMAGE}:${VERSION}"
    ARTIFACT_DIGEST="$(local_source_checksum)"
    [[ "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]] || die "Could not calculate the local source checksum"
    ARTIFACT_KIND="local source checksum"
    DATABASE_CONNECTOR_IMAGE_REF=""
    SECURE_LINK_CONNECTOR_IMAGE_REF=""
    RELAY_BUILD_VERSION="$VERSION"
    RELAY_PROTOCOL_MAJOR=1
    RELAY_IMAGE_REF="${IMAGE}/relay:${VERSION}"
    return
  fi

  local encoded_project release_json
  encoded_project="${GITLAB_PROJECT_PATH//\//%2F}"
  info "Resolving the latest Gateway release"
  release_json="$(curl -fsSL "${GITLAB_API_URL}/api/v4/projects/${encoded_project}/releases?per_page=100")" || die "Unable to query releases"
  VERSION="$(
    printf '%s' "$release_json" |
      grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' |
      sed -E 's/^.*"([^"]+)"$/\1/' |
      grep -E '^v?[0-9]+\.[0-9]+\.[0-9]+$' |
      sort -V |
      tail -n1 || true
  )"
  [[ -n "$VERSION" ]] || die "The release API did not return an eligible Gateway release"
  info "Version: ${VERSION}"
  verify_signed_release "$VERSION" "$encoded_project"
  ARTIFACT_DIGEST="${IMAGE_REF##*@sha256:}"
  ARTIFACT_KIND="signed image digest"
}

print_install_details() {
  selector_title "Installation details:"
  guide "  ${GRAY}Release:${NC}         ${VERSION}"
  guide "  ${GRAY}${ARTIFACT_KIND}:${NC} $(short_digest "$ARTIFACT_DIGEST")"
  guide "  ${GRAY}Target path:${NC}     ${INSTALL_DIR}"
  guide "  ${GRAY}Mode:${NC}            $([[ "$FRESH" == 1 ]] && echo 'fresh install' || echo 'update')"
  guide_blank
}

usage() {
  cat <<'EOF'
Usage: install.sh [--install-dir PATH] [--image IMAGE] [--source-dir PATH] [--http|--https] [--dry-run]

Installs or updates Gateway. On a fresh interactive install, the only prompt
selects native HTTPS or HTTP for port 3000. Non-interactive installs default
to native HTTPS. All product configuration continues in the browser wizard.

--source-dir builds the Gateway image from a local source checkout on this
host. It is intended for a fresh test installation and skips GitLab release
discovery and image pulls.

--dry-run renders the interactive flow and planned installation without
creating files, building or pulling images, or starting services.
EOF
}

while (($#)); do
  case "$1" in
    --install-dir) INSTALL_DIR="${2:?missing path}"; shift 2 ;;
    --image) IMAGE="${2:?missing image}"; shift 2 ;;
    --source-dir) SOURCE_DIR="${2:?missing path}"; shift 2 ;;
    --http) TRANSPORT="http"; shift ;;
    --https) TRANSPORT="https"; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done

show_header

if [[ "$DRY_RUN" -eq 0 ]]; then
  umask 077
  : >"$LOG_FILE" 2>/dev/null || die "Unable to create installer log at ${LOG_FILE}"
  chmod 600 "$LOG_FILE" 2>/dev/null || true
  ensure_docker_available
  command_exists curl || die "curl is required"
  command_exists openssl || die "openssl is required"
  "${DOCKER[@]}" compose version >/dev/null 2>&1 || die "Docker Compose v2 is required"

  if [[ ! -d "$INSTALL_DIR" ]]; then
    if mkdir -p "$INSTALL_DIR" 2>/dev/null; then :; else sudo mkdir -p "$INSTALL_DIR"; sudo chown "$(id -u):$(id -g)" "$INSTALL_DIR"; fi
  fi
  cd "$INSTALL_DIR"
  INSTALL_DIR="$(pwd)"
  FRESH=0
  [[ -f .env ]] || FRESH=1
else
  FRESH=1
  [[ -f "$INSTALL_DIR/.env" ]] && FRESH=0
fi

if [[ "$DRY_RUN" -eq 1 ]]; then
  command -v curl >/dev/null || die "curl is required to inspect the release in dry-run mode"
  command -v openssl >/dev/null || die "openssl is required to verify the release in dry-run mode"
  DRY_RUN_LOG="$(mktemp)"
  LOG_FILE="$DRY_RUN_LOG"
else
  umask 077
  : >"$LOG_FILE" 2>/dev/null || die "Unable to create installer log at ${LOG_FILE}"
  chmod 600 "$LOG_FILE" 2>/dev/null || true
fi

guide_start "${GRAY}Preparing Gateway installation:${NC}"
guide_blank
prepare_install_metadata
guide_blank
print_install_details

if [[ "$FRESH" == 1 && -z "$TRANSPORT" ]]; then
  TRANSPORT="https"
  if [[ -r /dev/tty && -w /dev/tty ]]; then
    guide "${GRAY}Gateway can serve port 3000 with its own System CA certificate.${NC}"
    selector_title "Web transport:"
    transport_choice=$(prompt_menu "1" "Internal HTTPS  — use Gateway System CA on :3000" "HTTP            — configure TLS in a reverse proxy later")
    case "$transport_choice" in
      1) TRANSPORT="https" ;;
      2) TRANSPORT="http" ;;
      *) TRANSPORT="https" ;;
    esac
    guide "${GRAY}Selected: ${NC}${TRANSPORT}"
  fi
fi
[[ "$TRANSPORT" == "http" || "$TRANSPORT" == "https" || "$FRESH" == 0 ]] || die "GATEWAY_WEB_TRANSPORT must be http or https"
if [[ "$FRESH" == 1 ]]; then
  if [[ "$TRANSPORT" == "https" ]]; then
    guide_blank
    warn "Your browser will show a certificate warning on first visit."
    warn "This is expected until the Gateway System CA is trusted."
  else
    guide_blank
  fi
fi
if [[ "$DRY_RUN" -eq 1 ]]; then
  info "Dry run: would validate Docker and prepare Gateway services"
  info "Dry run: would start Gateway with ${TRANSPORT} on port 3000"
  rm -f "$DRY_RUN_LOG"
  guide_blank
  echo -e "${BRAND_MINT}■${NC} ${BOLD}Dry run completed successfully — no host changes were made.${NC}"
  echo ""
  exit 0
fi

if [[ -n "$SOURCE_DIR" ]]; then
  info "Building Gateway from local source: ${SOURCE_DIR}"
  run_quiet "Gateway image build" "${DOCKER[@]}" build --build-arg "APP_VERSION=${VERSION}" --tag "$IMAGE_REF" "$SOURCE_DIR"
  run_quiet "Relay image build" "${DOCKER[@]}" build -f "$SOURCE_DIR/packages/relay/Dockerfile" --build-arg "RELAY_BUILD_VERSION=${VERSION}" --tag "$RELAY_IMAGE_REF" "$SOURCE_DIR"
fi

env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" .env 2>/dev/null | tail -n1
}

ensure_env() {
  local key="$1" value="$2"
  grep -q "^${key}=" .env 2>/dev/null || printf '%s=%s\n' "$key" "$value" >>.env
}

set_env() {
  local key="$1" value="$2" output
  output="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    index($0, key "=") == 1 { if (!done) { print key "=" value; done=1 } next }
    { print }
    END { if (!done) print key "=" value }
  ' .env >"$output"
  mv "$output" .env
}

detect_local_host_address_lines() {
  if command -v ip >/dev/null; then
    ip -o addr show up scope global 2>/dev/null | awk '
      {
        interface = $2
        sub(/@.*/, "", interface)
      }
      interface == "lo" ||
      interface ~ /^docker/ ||
      interface ~ /^br-/ ||
      interface ~ /^veth/ ||
      interface ~ /^virbr/ ||
      interface ~ /^podman/ ||
      interface ~ /^cni/ ||
      interface ~ /^flannel/ ||
      interface ~ /^cali/ ||
      interface ~ /^kube/ ||
      interface ~ /^tailscale/ ||
      interface ~ /^zt/ ||
      interface ~ /^lxc/ ||
      interface ~ /^incus/ ||
      interface ~ /^vboxnet/ ||
      interface ~ /^vmnet/ { next }
      $3 == "inet" { sub(/\/.*/, "", $4); if ($4 !~ /^127\./) print $4; next }
      $3 == "inet6" {
        sub(/\/.*/, "", $4)
        address = tolower($4)
        if (address != "::1" && address !~ /^fe80:/) print $4
      }
    ' | awk '!seen[$0]++'
  fi
}

detect_local_host_addresses() {
  detect_local_host_address_lines | paste -sd, -
}

format_gateway_url() {
  local address="$1"
  if [[ "$address" == *:* ]]; then
    printf '%s://[%s]:3000' "$TRANSPORT" "$address"
  else
    printf '%s://%s:3000' "$TRANSPORT" "$address"
  fi
}

print_gateway_urls() {
  local address
  guide "${BRAND_MINT}Open:${NC}"
  guide "  ${GRAY}Local:${NC}   ${TRANSPORT}://localhost:3000"
  while IFS= read -r address; do
    [[ -n "$address" ]] || continue
    guide "  ${GRAY}Network:${NC} $(format_gateway_url "$address")"
  done < <(detect_local_host_address_lines)
}

if [[ "$FRESH" == 1 ]]; then
  umask 077
  : >.env
fi
ensure_env GATEWAY_IMAGE_REF "$IMAGE_REF"
if [[ -n "${DATABASE_CONNECTOR_IMAGE_REF:-}" ]]; then
  ensure_env DATABASE_CONNECTOR_IMAGE "$DATABASE_CONNECTOR_IMAGE_REF"
fi
if [[ -n "${SECURE_LINK_CONNECTOR_IMAGE_REF:-}" ]]; then
  ensure_env SECURE_LINK_CONNECTOR_IMAGE "$SECURE_LINK_CONNECTOR_IMAGE_REF"
fi
ensure_env DB_PASSWORD "$(openssl rand -hex 24)"
ensure_env PKI_MASTER_KEY "$(openssl rand -hex 32)"
ensure_env SETUP_BOOTSTRAP "$([[ "$FRESH" == 1 ]] && printf true || printf false)"
ensure_env WEB_TLS_BOOTSTRAP_MODE "${TRANSPORT:-http}"
ensure_env SANDBOX_RUNNER_WORKSPACE_DIR "/var/lib/gateway/sandbox-workspaces"
ensure_env GATEWAY_RELAY_MANAGED "$([[ -z "$SOURCE_DIR" ]] && printf true || printf false)"
if [[ "$FRESH" == 1 ]]; then
  ensure_env GATEWAY_RELAY_IMAGE_REF "$RELAY_IMAGE_REF"
  ensure_env GATEWAY_RELAY_BUILD_VERSION "$RELAY_BUILD_VERSION"
  ensure_env GATEWAY_RELAY_PROTOCOL_MAJOR "$RELAY_PROTOCOL_MAJOR"
fi
local_host_addresses="$(detect_local_host_addresses)"
if [[ -n "$local_host_addresses" ]]; then
  set_env GATEWAY_LOCAL_HOSTS "$local_host_addresses"
else
  ensure_env GATEWAY_LOCAL_HOSTS ""
fi
chmod 600 .env

# Always advance the managed image reference to the latest release.
tmp_env="$(mktemp)"
awk -v ref="$IMAGE_REF" 'BEGIN{done=0} /^GATEWAY_IMAGE_REF=/{if(!done){print "GATEWAY_IMAGE_REF=" ref; done=1} next} {print} END{if(!done) print "GATEWAY_IMAGE_REF=" ref}' .env >"$tmp_env"
mv "$tmp_env" .env
chmod 600 .env

if [[ "$FRESH" == 1 ]]; then
  cat >docker-compose.yml <<'COMPOSE'
services:
  app:
    image: ${GATEWAY_IMAGE_REF}
    restart: unless-stopped
    stop_grace_period: 60s
    labels:
      com.wiolett.gateway.managed-service: app
    env_file: .env
    environment:
      NODE_ENV: production
      PORT: 3000
      DATABASE_URL: postgres://gateway:${DB_PASSWORD}@postgres:5432/gateway
      REDIS_URL: redis://redis:6379
      PKI_MASTER_KEY: ${PKI_MASTER_KEY}
      WEB_TLS_AUTO_DIR: /var/lib/gateway/tls
      GRPC_TLS_AUTO_DIR: /var/lib/gateway/tls
      GATEWAY_RELAY_REQUIRED: "true"
      GATEWAY_RELAY_MANAGED: "${GATEWAY_RELAY_MANAGED:-true}"
      GATEWAY_RELAY_TARGET: relay:9443
      GATEWAY_RELAY_IDENTITY_DIR: /var/lib/gateway-relay
      GATEWAY_RELAY_IMAGE_REF: ${GATEWAY_RELAY_IMAGE_REF}
      GATEWAY_RELAY_SERVICE_NAME: relay
      GATEWAY_RELAY_BUILD_VERSION: ${GATEWAY_RELAY_BUILD_VERSION}
      GATEWAY_RELAY_PROTOCOL_MAJOR: ${GATEWAY_RELAY_PROTOCOL_MAJOR}
      SANDBOX_RUNNER_WORKSPACE_DIR: ${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}
    ports:
      - "3000:3000"
    expose:
      - "9443"
    volumes:
      - gateway_data:/var/lib/gateway
      - gateway_relay_identity:/var/lib/gateway-relay
      - ${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}:${SANDBOX_RUNNER_WORKSPACE_DIR:-/var/lib/gateway/sandbox-workspaces}
      - /var/run/docker.sock:/var/run/docker.sock
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    healthcheck:
      test: ["CMD-SHELL", "wget --no-check-certificate -qO- https://127.0.0.1:3000/health || wget -qO- http://127.0.0.1:3000/health"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 20s

  relay:
    image: ${GATEWAY_RELAY_IMAGE_REF}
    entrypoint: ["/gateway-relay"]
    restart: unless-stopped
    labels:
      com.wiolett.gateway.managed-service: relay
    environment:
      RELAY_IDENTITY_DIR: /var/lib/gateway-relay/identity
      RELAY_STATE_DIR: /var/lib/gateway-relay/state
      RELAY_APP_GRPC_TARGET: app:9443
    ports:
      - "9443:9443"
    volumes:
      - gateway_relay_identity:/var/lib/gateway-relay/identity:ro
      - gateway_relay_state:/var/lib/gateway-relay/state
    healthcheck:
      test: ["CMD", "/gateway-relay", "healthcheck"]
      interval: 5s
      timeout: 3s
      retries: 2
      start_period: 20s

  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: gateway
      POSTGRES_USER: gateway
      POSTGRES_PASSWORD: ${DB_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U gateway -d gateway"]
      interval: 5s
      timeout: 5s
      retries: 12

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 5s
      retries: 12

volumes:
  gateway_data:
  gateway_relay_identity:
  gateway_relay_state:
  postgres_data:
  redis_data:
COMPOSE
else
  info "Migrating the existing installer-managed Compose foundation"
  run_quiet "Gateway image pull" "${DOCKER[@]}" pull "$IMAGE_REF"
  foundation_args=(node dist/foundation-migrator.js --host-dir /host --target-version "$VERSION" --image-ref "$IMAGE_REF" --relay-build-version "$RELAY_BUILD_VERSION" --relay-protocol-major "$RELAY_PROTOCOL_MAJOR" --relay-image-ref "$RELAY_IMAGE_REF")
  if [[ -n "${DATABASE_CONNECTOR_IMAGE_REF:-}" ]]; then
    foundation_args+=(--database-connector-image "$DATABASE_CONNECTOR_IMAGE_REF")
  fi
  if [[ -n "${SECURE_LINK_CONNECTOR_IMAGE_REF:-}" ]]; then
    foundation_args+=(--secure-link-connector-image "$SECURE_LINK_CONNECTOR_IMAGE_REF")
  fi
  run_quiet "Gateway foundation migration" "${DOCKER[@]}" run --rm -v "$INSTALL_DIR:/host" "$IMAGE_REF" "${foundation_args[@]}"
fi

if [[ -z "$SOURCE_DIR" ]]; then
  info "Pulling ${IMAGE_REF}"
  run_quiet "Gateway service image pull" "${DOCKER[@]}" compose pull
fi
info "Preparing the pinned recovery helper"
run_quiet "Gateway recovery helper image pull" "${DOCKER[@]}" pull "$DOCKER_COMPOSE_CLI_IMAGE_REF"
info "Starting Gateway services"
run_quiet "Gateway service startup" "${DOCKER[@]}" compose up -d

info "Waiting for Gateway"
healthy=0
for _ in $(seq 1 90); do
  if curl -kfsS https://127.0.0.1:3000/health >/dev/null 2>&1 || curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 2
done
[[ "$healthy" == 1 ]] || die "Gateway did not become healthy; run: docker compose logs app"

# The first boot imports legacy OIDC_*, CLICKHOUSE_*, and APP_URL values into
# encrypted Gateway settings. The guarded migration command verifies a complete
# legacy tuple before it removes anything from disk.
if grep -Eq '^(OIDC_|CLICKHOUSE_|APP_URL=|SETUP_TOKEN=)' .env; then
  info "Finalizing legacy settings migration"
  run_quiet "Legacy settings migration" "${DOCKER[@]}" compose run --rm -T -v "$INSTALL_DIR:/host" app \
    node dist/cli/migrate-legacy-settings.js /host
  run_quiet "Gateway restart after legacy migration" "${DOCKER[@]}" compose up -d --force-recreate app
fi

ok "Gateway ${VERSION} is running"
guide_blank
if [[ "$FRESH" == 1 ]]; then
  if ! setup_json="$("${DOCKER[@]}" compose exec -T app node dist/cli/setup-code.js </dev/null 2>>"$LOG_FILE" | sed -n '/^{"id":/p' | tail -n1)"; then
    die "Gateway started, but the setup code could not be generated. Check ${LOG_FILE} for details."
  fi
  setup_code="$(printf '%s' "$setup_json" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')"
  expires_at="$(printf '%s' "$setup_json" | sed -n 's/.*"expiresAt":"\([^"]*\)".*/\1/p')"
  ca_fingerprint="$(printf '%s' "$setup_json" | sed -n 's/.*"caFingerprint":"\([^"]*\)".*/\1/p')"
  [[ -n "$setup_code" ]] || die "Gateway started, but the setup code could not be generated"
  print_gateway_urls
  guide_blank
  guide "${BRAND_MINT}Setup code:${NC} ${setup_code}"
  guide "${GRAY}Expires:${NC}    ${expires_at}"
  guide "${GRAY}System CA:${NC}  ${ca_fingerprint}"
  guide "${GRAY}Reset:${NC}      cd ${INSTALL_DIR} && docker compose exec app node dist/cli/reset-setup.js"
  guide_blank
  guide "${GRAY}The setup code is shown once. Finish configuration in the browser.${NC}"
else
  guide "${GRAY}Existing installation updated; persisted Gateway settings were preserved.${NC}"
fi

guide_blank
echo -e "${BRAND_MINT}■${NC} ${BOLD}Gateway installation completed successfully.${NC}"
echo ""
