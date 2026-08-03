#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
mkdir -p "$TMP_DIR/payload/gateway-installer" "$TMP_DIR/bin"

cat > "$TMP_DIR/payload/gateway-installer/gateway-installer" <<'INSTALLER'
#!/usr/bin/env bash
printf '%s\n' "$@" > "$CAPTURED_ARGS"
INSTALLER
chmod 0755 "$TMP_DIR/payload/gateway-installer/gateway-installer"
tar -C "$TMP_DIR/payload" -czf "$TMP_DIR/gateway-installer-linux-amd64.tar.gz" gateway-installer
cp "$TMP_DIR/gateway-installer-linux-amd64.tar.gz" "$TMP_DIR/gateway-installer-linux-arm64.tar.gz"
CHECKSUM="$(sha256sum "$TMP_DIR/gateway-installer-linux-amd64.tar.gz" | awk '{print $1}')"

cat > "$TMP_DIR/bin/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
url=""
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o|--output) output="$2"; shift 2 ;;
    http://*|https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */releases)
    printf '[{"tag_name":"v3.0.0-rc.2"},{"tag_name":"v3.0.0-rc.10"},{"tag_name":"v2.9.0-installer"}]\n'
    ;;
  */checksums.txt)
    printf '%s  gateway-installer-linux-amd64.tar.gz\n%s  gateway-installer-linux-arm64.tar.gz\n' "$TEST_CHECKSUM" "$TEST_CHECKSUM" > "$output"
    ;;
  */gateway-installer-linux-amd64.tar.gz|*/gateway-installer-linux-arm64.tar.gz)
    cp "$TEST_ARCHIVE" "$output"
    ;;
  *)
    printf 'unexpected curl URL: %s\n' "$url" >&2
    exit 1
    ;;
esac
CURL
chmod 0755 "$TMP_DIR/bin/curl"

run_loader() {
  : > "$TMP_DIR/captured-args"
  PATH="$TMP_DIR/bin:$PATH" TEST_ARCHIVE="$TMP_DIR/gateway-installer-linux-amd64.tar.gz" TEST_CHECKSUM="$CHECKSUM" CAPTURED_ARGS="$TMP_DIR/captured-args" \
    "$ROOT/scripts/gateway-installer-loader.sh" "$@"
  tr '\n' ' ' < "$TMP_DIR/captured-args"
}

run_gateway_wrapper() {
  : > "$TMP_DIR/captured-args"
  PATH="$TMP_DIR/bin:$PATH" TEST_ARCHIVE="$TMP_DIR/gateway-installer-linux-amd64.tar.gz" TEST_CHECKSUM="$CHECKSUM" CAPTURED_ARGS="$TMP_DIR/captured-args" \
    GITLAB_API_URL="https://gitlab.example.com" GITLAB_PROJECT_PATH="group/project" \
    "$ROOT/scripts/install.sh" "$@"
  tr '\n' ' ' < "$TMP_DIR/captured-args"
}

run_node_wrapper() {
  : > "$TMP_DIR/captured-args"
  PATH="$TMP_DIR/bin:$PATH" TEST_ARCHIVE="$TMP_DIR/gateway-installer-linux-amd64.tar.gz" TEST_CHECKSUM="$CHECKSUM" CAPTURED_ARGS="$TMP_DIR/captured-args" \
    GATEWAY_GITLAB_URL="https://gitlab.example.com" GATEWAY_GITLAB_PROJECT="group/project" \
    "$ROOT/scripts/setup-daemon.sh" "$@"
  tr '\n' ' ' < "$TMP_DIR/captured-args"
}

stable="$(run_loader node latest https://gitlab.example.com group/project --dry-run)"
[[ "$stable" == "install node --dry-run " ]] || { echo "stable loader forwarding failed: $stable" >&2; exit 1; }

nightly_node="$(run_loader node latest https://gitlab.example.com group/project --nightly --type nginx --dry-run)"
[[ "$nightly_node" == "install node --type nginx --dry-run --version nightly " ]] || { echo "nightly node loader forwarding failed: $nightly_node" >&2; exit 1; }

explicit_nightly_node="$(run_loader node v3.0.0-nginx-rc.2 https://gitlab.example.com group/project --nightly --type nginx --version v3.0.0-nginx-rc.2 --dry-run)"
[[ "$explicit_nightly_node" == "install node --type nginx --version v3.0.0-nginx-rc.2 --dry-run " ]] || { echo "explicit nightly node forwarding failed: $explicit_nightly_node" >&2; exit 1; }

if PATH="$TMP_DIR/bin:$PATH" TEST_ARCHIVE="$TMP_DIR/gateway-installer-linux-amd64.tar.gz" TEST_CHECKSUM="$CHECKSUM" CAPTURED_ARGS="$TMP_DIR/captured-args" \
  "$ROOT/scripts/gateway-installer-loader.sh" node v3.0.0-nginx-rc.2 https://gitlab.example.com group/project --type nginx --version v3.0.0-nginx-rc.2 --dry-run >/dev/null 2>&1; then
  echo "node RC was accepted without --nightly" >&2
  exit 1
fi

nightly="$(run_loader gateway latest https://gitlab.example.com group/project --nightly --dry-run)"
[[ "$nightly" == "install gateway --dry-run --version v3.0.0-rc.10 " ]] || { echo "nightly loader forwarding failed: $nightly" >&2; exit 1; }

explicit_rc="$(run_loader gateway v3.0.0-rc.2 https://gitlab.example.com group/project --nightly --version v3.0.0-rc.2 --dry-run)"
[[ "$explicit_rc" == "install gateway --version v3.0.0-rc.2 --dry-run " ]] || { echo "explicit RC forwarding failed: $explicit_rc" >&2; exit 1; }

gateway_wrapper="$(run_gateway_wrapper --nightly --dry-run)"
[[ "$gateway_wrapper" == "install gateway --dry-run --version v3.0.0-rc.10 " ]] || { echo "gateway wrapper forwarding failed: $gateway_wrapper" >&2; exit 1; }

node_wrapper="$(run_node_wrapper --type nginx --nightly --dry-run)"
[[ "$node_wrapper" == "install node --type nginx --dry-run --version nightly " ]] || { echo "node wrapper forwarding failed: $node_wrapper" >&2; exit 1; }
