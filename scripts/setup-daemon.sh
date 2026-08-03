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
LOADER="$(dirname "${BASH_SOURCE[0]}")/gateway-installer-loader.sh"
if [[ ! -x "$LOADER" ]]; then
  command -v curl >/dev/null 2>&1 || { echo "gateway installer loader: curl is required" >&2; exit 1; }
  LOADER="$(mktemp /tmp/gateway-installer-loader.XXXXXX)"
  trap 'rm -f "$LOADER"' EXIT
  curl -fsSL "${GITLAB_URL%/}/${GITLAB_PROJECT}/-/raw/main/scripts/gateway-installer-loader.sh" -o "$LOADER"
  chmod 0700 "$LOADER"
fi
exec "$LOADER" node "$REQUESTED_VERSION" "$GITLAB_URL" "$GITLAB_PROJECT" "${ARGS[@]}"
