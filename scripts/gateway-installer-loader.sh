#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:?installer target is required}"; shift
REQUESTED_VERSION="${1:?installer version is required}"; shift
GITLAB_URL="${1:?GitLab URL is required}"; shift
GITLAB_PROJECT="${1:?GitLab project is required}"; shift

die() { printf 'gateway installer loader: %s\n' "$*" >&2; exit 1; }
SHOW_UI=false
if [[ -t 2 && "${TERM:-dumb}" != "dumb" ]]; then SHOW_UI=true; fi
SHOW_BANNER=true
status() {
  [[ "$SHOW_UI" == true ]] || return 0
  printf '\n  %s\n' "$*" >&2
}
banner() {
  [[ "$SHOW_UI" == true && "$SHOW_BANNER" == true ]] || return 0
  printf '\n' >&2
  printf '  ╭──────────────────────────────╮\n' >&2
  printf '  │  Wiolett Gateway Installer   │\n' >&2
  printf '  ╰──────────────────────────────╯\n' >&2
}
clear_screen() {
  [[ "$SHOW_UI" == true ]] || return 0
  printf '\033[2J\033[H\n' >&2
}
if command -v curl >/dev/null 2>&1; then
  download_stdout() { curl -fsSL "$1"; }
  download_file() {
    status "$1"
    if [[ "$SHOW_UI" == true ]]; then curl -fL --progress-bar "$2" -o "$3"; else curl -fsSL "$2" -o "$3"; fi
  }
elif command -v wget >/dev/null 2>&1; then
  download_stdout() { wget -qO- "$1"; }
  download_file() {
    status "$1"
    if [[ "$SHOW_UI" == true ]]; then wget -q --show-progress -O "$3" "$2"; else wget -qO "$3" "$2"; fi
  }
else
  die "curl or wget is required to download gateway-installer"
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

ENCODED_PROJECT="${GITLAB_PROJECT//\//%2F}"
API="${GITLAB_URL%/}/api/v4/projects/${ENCODED_PROJECT}"
PACKAGE_API="${API}/packages/generic/gateway-installer"
PACKAGE_VERSIONS_URL="${API}/packages?package_type=generic&package_name=gateway-installer&per_page=100"
NIGHTLY=false
INSTALLER_ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--nightly" ]]; then
    NIGHTLY=true
  elif [[ "$arg" == "--no-logo" ]]; then
    SHOW_BANNER=false
  else
    INSTALLER_ARGS+=("$arg")
  fi
done

clear_screen
banner
status "Resolving installer release"

if [[ "$NIGHTLY" == true ]]; then
  if [[ "$TARGET" == "node" || "$REQUESTED_VERSION" == "latest" ]]; then
    INSTALLER_TAG="$(download_stdout "$PACKAGE_VERSIONS_URL" | grep -oE '"version"[[:space:]]*:[[:space:]]*"v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+"' | sed -E 's/.*"([^"]+)"$/\1/' | sort -V | tail -1)"
    [[ -n "$INSTALLER_TAG" ]] || die "could not resolve a release-candidate installer; publish vX.Y.Z-rc.N first"
  else
    BASE_VERSION="${REQUESTED_VERSION%-nginx}"
    BASE_VERSION="${BASE_VERSION%-docker}"
    BASE_VERSION="${BASE_VERSION%-monitoring}"
    BASE_VERSION="${BASE_VERSION%-installer}"
    [[ "$BASE_VERSION" == v* ]] || BASE_VERSION="v${BASE_VERSION}"
    [[ "$BASE_VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+-rc\.[0-9]+$ ]] || die "--nightly requires latest or an explicit vX.Y.Z-rc.N version"
    INSTALLER_TAG="$BASE_VERSION"
  fi
else
  if [[ "$REQUESTED_VERSION" == "latest" ]]; then
    INSTALLER_TAG="$(download_stdout "$PACKAGE_VERSIONS_URL" | grep -oE '"version"[[:space:]]*:[[:space:]]*"v[0-9]+\.[0-9]+\.[0-9]+-installer"' | sed -E 's/.*"([^"]+)"$/\1/' | sort -V | tail -1)"
    [[ -n "$INSTALLER_TAG" ]] || die "could not resolve latest installer release"
  else
    BASE_VERSION="${REQUESTED_VERSION%-nginx}"
    BASE_VERSION="${BASE_VERSION%-docker}"
    BASE_VERSION="${BASE_VERSION%-monitoring}"
    BASE_VERSION="${BASE_VERSION%-installer}"
    [[ "$BASE_VERSION" == v* ]] || BASE_VERSION="v${BASE_VERSION}"
    [[ "$BASE_VERSION" =~ -rc\. ]] && die "release candidates require --nightly"
    INSTALLER_TAG="${BASE_VERSION}-installer"
  fi
fi

ASSET="gateway-installer-linux-${ARCH}.tar.gz"
BASE_URL="${PACKAGE_API}/${INSTALLER_TAG}"
TMP_DIR="$(mktemp -d /tmp/gateway-installer.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT
status "Preparing ${TARGET} installer · ${INSTALLER_TAG} · ${ARCH}"
download_file "Fetching release checksums" "${BASE_URL}/checksums.txt" "$TMP_DIR/checksums.txt" || die "could not download installer checksums"
EXPECTED="$(awk -v asset="$ASSET" '{ filename = $2; sub(/^\*/, "", filename); sub(/^.*\//, "", filename); if (filename == asset) { print $1; exit } }' "$TMP_DIR/checksums.txt")"
[[ "$EXPECTED" =~ ^[a-fA-F0-9]{64}$ ]] || die "checksum for ${ASSET} is missing"
download_file "Downloading installer bundle" "${BASE_URL}/${ASSET}" "$TMP_DIR/$ASSET" || die "could not download ${ASSET}"
status "Verifying download"
ACTUAL="$(sha256sum "$TMP_DIR/$ASSET" | awk '{print $1}')"
[[ "$ACTUAL" == "$EXPECTED" ]] || die "checksum verification failed"
status "Starting interactive setup"
tar -xzf "$TMP_DIR/$ASSET" -C "$TMP_DIR" || die "installer archive could not be extracted"
INSTALLER="$TMP_DIR/gateway-installer/gateway-installer"
[[ -x "$INSTALLER" ]] || die "installer archive has an invalid layout"
clear_screen
if [[ "$SHOW_UI" == true && ! -t 0 ]]; then
  [[ -r /dev/tty ]] || die "interactive setup requires a terminal; save the script locally or use --yes"
  exec < /dev/tty
fi
has_version=false
version_value_index=-1
for ((index = 0; index < ${#INSTALLER_ARGS[@]}; index++)); do
  if [[ "${INSTALLER_ARGS[index]}" == "--version" || "${INSTALLER_ARGS[index]}" == "-v" ]]; then
    has_version=true
    version_value_index=$((index + 1))
    break
  fi
done
if [[ "$TARGET" == "gateway" ]]; then
  if [[ "$NIGHTLY" == true ]]; then
    if [[ "$has_version" == false ]]; then
      INSTALLER_ARGS+=("--version" "$INSTALLER_TAG")
    fi
  fi
  exec "$INSTALLER" install gateway "${INSTALLER_ARGS[@]}"
fi
if [[ "$NIGHTLY" == true ]]; then
  if [[ "$has_version" == false ]]; then
    INSTALLER_ARGS+=("--version" "nightly")
  elif [[ "${INSTALLER_ARGS[version_value_index]:-}" == "latest" ]]; then
    INSTALLER_ARGS[version_value_index]="nightly"
  fi
elif [[ "${REQUESTED_VERSION}" =~ -rc\. ]]; then
  die "daemon release candidates require --nightly"
elif [[ "$has_version" == true && "${INSTALLER_ARGS[version_value_index]}" =~ -rc\. ]]; then
  die "daemon release candidates require --nightly"
fi
exec "$INSTALLER" install node "${INSTALLER_ARGS[@]}"
