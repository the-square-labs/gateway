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
  command -v curl >/dev/null 2>&1 || { echo "gateway installer loader: curl is required" >&2; exit 1; }
  LOADER="$(mktemp /tmp/gateway-installer-loader.XXXXXX)"
  trap 'rm -f "$LOADER"' EXIT
  curl -fsSL "${GITLAB_URL%/}/${GITLAB_PROJECT}/-/raw/main/scripts/gateway-installer-loader.sh" -o "$LOADER"
  chmod 0700 "$LOADER"
fi
exec "$LOADER" gateway "$REQUESTED_VERSION" "$GITLAB_URL" "$GITLAB_PROJECT" "${ARGS[@]}"
