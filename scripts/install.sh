#!/usr/bin/env bash
set -euo pipefail

# Compatibility loader. Installation logic lives in gateway-installer.
GITLAB_URL="${GITLAB_API_URL:-https://gitlab.wiolett.net}"
GITLAB_PROJECT="${GITLAB_PROJECT_PATH:-wiolett/gateway}"
REQUESTED_VERSION="${GATEWAY_VERSION:-latest}"
ARGS=("$@")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version|-v) REQUESTED_VERSION="${2:?--version requires a value}"; shift 2 ;;
    --gitlab-url) GITLAB_URL="${2:?--gitlab-url requires a value}"; shift 2 ;;
    --gitlab-project) GITLAB_PROJECT="${2:?--gitlab-project requires a value}"; shift 2 ;;
    *) shift ;;
  esac
done

LOADER="$(dirname "${BASH_SOURCE[0]}")/gateway-installer-loader.sh"
if [[ ! -x "$LOADER" ]]; then
  LOADER="$(mktemp /tmp/gateway-installer-loader.XXXXXX)"
  trap 'rm -f "$LOADER"' EXIT
  LOADER_URL="${GITLAB_URL%/}/${GITLAB_PROJECT}/-/raw/main/scripts/gateway-installer-loader.sh"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$LOADER_URL" -o "$LOADER"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$LOADER" "$LOADER_URL"
  else
    echo "gateway installer loader: curl or wget is required" >&2
    exit 1
  fi
  chmod 0700 "$LOADER"
fi
exec "$LOADER" gateway "$REQUESTED_VERSION" "$GITLAB_URL" "$GITLAB_PROJECT" "${ARGS[@]}"
