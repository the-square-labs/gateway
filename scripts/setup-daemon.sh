#!/usr/bin/env bash
set -euo pipefail

GITLAB_URL="${GATEWAY_GITLAB_URL:-https://gitlab.wiolett.net}"
GITLAB_PROJECT="${GATEWAY_GITLAB_PROJECT:-wiolett/gateway}"
REQUESTED_VERSION="${GATEWAY_NODE_DAEMON_VERSION:-latest}"
TYPE=""
ARGS=("$@")
while [[ $# -gt 0 ]]; do
  case "$1" in
    --type) TYPE="${2:?--type requires a value}"; shift 2 ;;
    --version) REQUESTED_VERSION="${2:?--version requires a value}"; shift 2 ;;
    --gitlab-url) GITLAB_URL="${2:?--gitlab-url requires a value}"; shift 2 ;;
    --gitlab-project) GITLAB_PROJECT="${2:?--gitlab-project requires a value}"; shift 2 ;;
    *) shift ;;
  esac
done
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
LOADER=""
if [[ -n "$SCRIPT_SOURCE" ]]; then
  LOADER="$(dirname "$SCRIPT_SOURCE")/gateway-installer-loader.sh"
fi
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
exec "$LOADER" node "$REQUESTED_VERSION" "$GITLAB_URL" "$GITLAB_PROJECT" "${ARGS[@]}"
