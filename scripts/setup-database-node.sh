#!/usr/bin/env bash
set -euo pipefail
SCRIPT="$(dirname "${BASH_SOURCE[0]}")/setup-daemon.sh"
if [[ -x "$SCRIPT" ]]; then exec "$SCRIPT" --type databases "$@"; fi
URL="${GATEWAY_GITLAB_URL:-https://gitlab.wiolett.net}/${GATEWAY_GITLAB_PROJECT:-wiolett/gateway}/-/raw/main/scripts/setup-daemon.sh"
if command -v curl >/dev/null 2>&1; then curl -fsSL "$URL"; elif command -v wget >/dev/null 2>&1; then wget -qO- "$URL"; else echo "gateway installer: curl or wget is required" >&2; exit 1; fi | bash -s -- --type databases "$@"
