#!/usr/bin/env bash
set -euo pipefail
SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
SCRIPT=""
if [[ -n "$SCRIPT_SOURCE" ]]; then SCRIPT="$(dirname "$SCRIPT_SOURCE")/setup-daemon.sh"; fi
if [[ -x "$SCRIPT" ]]; then exec "$SCRIPT" --type monitoring "$@"; fi
URL="${GATEWAY_GITLAB_URL:-https://gitlab.wiolett.net}/${GATEWAY_GITLAB_PROJECT:-wiolett/gateway}/-/raw/main/scripts/setup-daemon.sh"
if command -v curl >/dev/null 2>&1; then curl -fsSL "$URL"; elif command -v wget >/dev/null 2>&1; then wget -qO- "$URL"; else echo "gateway installer: curl or wget is required" >&2; exit 1; fi | bash -s -- --type monitoring "$@"
