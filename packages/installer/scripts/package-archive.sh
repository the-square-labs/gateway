#!/usr/bin/env bash
set -euo pipefail

# Usage: package-archive.sh <node-runtime-tar.gz> <arch> <output-tar.gz>
NODE_ARCHIVE="${1:?Node runtime archive is required}"
ARCH="${2:?architecture is required}"
OUTPUT="${3:?output archive is required}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

case "${ARCH}" in
  amd64) NODE_PLATFORM_ARCH=x64 ;;
  arm64) NODE_PLATFORM_ARCH=arm64 ;;
  *) echo "unsupported architecture: ${ARCH}" >&2; exit 1 ;;
esac

tar -xf "${NODE_ARCHIVE}" -C "${WORK_DIR}"
NODE_DIR="$(find "${WORK_DIR}" -maxdepth 1 -type d -name "node-v*-linux-${NODE_PLATFORM_ARCH}" | head -1)"
[[ -n "${NODE_DIR}" ]] || { echo "Node runtime archive has an unexpected layout" >&2; exit 1; }

PAYLOAD="${WORK_DIR}/gateway-installer"
mkdir -p "${PAYLOAD}/app" "${PAYLOAD}/bin"
cp "${NODE_DIR}/bin/node" "${PAYLOAD}/bin/node"
cp "${ROOT}/dist/cli.js" "${PAYLOAD}/app/cli.mjs"
cp "${ROOT}/gateway-installer-engine-${ARCH}" "${PAYLOAD}/bin/gateway-installer-engine"
chmod 0755 "${PAYLOAD}/bin/node" "${PAYLOAD}/bin/gateway-installer-engine" "${PAYLOAD}/app/cli.mjs"

cat > "${PAYLOAD}/gateway-installer" <<'LAUNCHER'
#!/usr/bin/env sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$ROOT/bin/node" "$ROOT/app/cli.mjs" "$@"
LAUNCHER
chmod 0755 "${PAYLOAD}/gateway-installer"

tar -C "${WORK_DIR}" -czf "${OUTPUT}" gateway-installer
