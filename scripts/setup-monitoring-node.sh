#!/usr/bin/env bash
set -euo pipefail
SCRIPT="$(dirname "${BASH_SOURCE[0]}")/setup-daemon.sh"
if [[ -x "$SCRIPT" ]]; then exec "$SCRIPT" --type monitoring "$@"; fi
curl -fsSL "${GATEWAY_GITLAB_URL:-https://gitlab.wiolett.net}/${GATEWAY_GITLAB_PROJECT:-wiolett/gateway}/-/raw/main/scripts/setup-daemon.sh" | bash -s -- --type monitoring "$@"
