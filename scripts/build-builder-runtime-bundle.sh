#!/usr/bin/env bash
set -euo pipefail

ARCH="${1:-}"
OUTPUT="${2:-}"
GATEWAY_RELEASE="${3:-development}"

case "$ARCH" in
  amd64)
    GVISOR_ARCH="x86_64"
    CONTAINERD_SHA256="9d68969855fbf676cdb8ed758e420fb048d61f984f61de3e53eddfebe484d168"
    BUILDKIT_SHA256="2975d0f651ad96ba8b80b9992ae1f9a964f4408569af5b6dc36544165c3926af"
    CNI_SHA256="b98f74a0f8522f0a83867178729c1aa70f2158f90c45a2ca8fa791db1c76b303"
    SYFT_SHA256="2a2e837a2c8d59ec9af5472ee22d3b04ee463c4e44476ecf993fd1e5ab6ebc7f"
    GRYPE_SHA256="38525dab1e06f162ebaa02f94d82d1f807076b011a44180cf2777edf1a7b9c26"
    RUNSC_SHA512="84936438d583ec976800f464e75a83e1515f0890b451b9b4db219c4472b54ca9b106a6772ee683f1e64cce2128871d7637b14d800591f8451b8137f6c39fb2ef"
    ;;
  arm64)
    GVISOR_ARCH="aarch64"
    CONTAINERD_SHA256="a985fbb7e18fc0362d31a055338f5d7b0e087a3e27f14c70d1c5965399a29f95"
    BUILDKIT_SHA256="9e8f46bf309ec0ab262967be5538a4dbe06be756a82621f98253933bac5dcf92"
    CNI_SHA256="56171987d3947707c3563db2f4001bccaf50fd63468611b9f3cbecb1375ee7ec"
    SYFT_SHA256="6c0466811541ea03add5213a60a1562f0851e4c0b0ecfdee1a694a9455285900"
    GRYPE_SHA256="935f628bdf9331ffdd946931ea5fdb50045d3970ba52670cbeb44a88f127291b"
    RUNSC_SHA512="6394fd161a4af0dc9a2c29f75c3016d05275a55744f124e12023fa7666a9f161c68d6ce3803ad49205c6a7b5bee0ad2ccf48edff340db344fdafec678c788aa4"
    ;;
  *)
    echo "Usage: $0 <amd64|arm64> <output.tar.gz> [gateway-release]" >&2
    exit 2
    ;;
esac

[[ -n "$OUTPUT" ]] || {
  echo "Output archive path is required." >&2
  exit 2
}

CONTAINERD_VERSION="2.3.4"
BUILDKIT_VERSION="0.32.2"
GVISOR_VERSION="20260817"
CNI_VERSION="1.9.1"
SYFT_VERSION="1.51.0"
GRYPE_VERSION="0.117.0"

OUTPUT_DIR=$(cd "$(dirname "$OUTPUT")" && pwd)
OUTPUT="${OUTPUT_DIR}/$(basename "$OUTPUT")"
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT HUP INT TERM

download_sha256() {
  local url="$1"
  local expected="$2"
  local target="$3"
  curl --fail --location --silent --show-error --retry 3 "$url" -o "$target"
  printf '%s  %s\n' "$expected" "$target" | sha256sum --check --status
}

download_sha512() {
  local url="$1"
  local expected="$2"
  local target="$3"
  curl --fail --location --silent --show-error --retry 3 "$url" -o "$target"
  printf '%s  %s\n' "$expected" "$target" | sha512sum --check --status
}

CONTAINERD_ARCHIVE="${WORK_DIR}/containerd.tar.gz"
BUILDKIT_ARCHIVE="${WORK_DIR}/buildkit.tar.gz"
CNI_ARCHIVE="${WORK_DIR}/cni.tgz"
SYFT_ARCHIVE="${WORK_DIR}/syft.tar.gz"
GRYPE_ARCHIVE="${WORK_DIR}/grype.tar.gz"
RUNSC_BINARY="${WORK_DIR}/runsc"

download_sha256 \
  "https://github.com/containerd/containerd/releases/download/v${CONTAINERD_VERSION}/containerd-${CONTAINERD_VERSION}-linux-${ARCH}.tar.gz" \
  "$CONTAINERD_SHA256" "$CONTAINERD_ARCHIVE"
download_sha256 \
  "https://github.com/moby/buildkit/releases/download/v${BUILDKIT_VERSION}/buildkit-v${BUILDKIT_VERSION}.linux-${ARCH}.tar.gz" \
  "$BUILDKIT_SHA256" "$BUILDKIT_ARCHIVE"
download_sha256 \
  "https://github.com/containernetworking/plugins/releases/download/v${CNI_VERSION}/cni-plugins-linux-${ARCH}-v${CNI_VERSION}.tgz" \
  "$CNI_SHA256" "$CNI_ARCHIVE"
download_sha256 \
  "https://github.com/anchore/syft/releases/download/v${SYFT_VERSION}/syft_${SYFT_VERSION}_linux_${ARCH}.tar.gz" \
  "$SYFT_SHA256" "$SYFT_ARCHIVE"
download_sha256 \
  "https://github.com/anchore/grype/releases/download/v${GRYPE_VERSION}/grype_${GRYPE_VERSION}_linux_${ARCH}.tar.gz" \
  "$GRYPE_SHA256" "$GRYPE_ARCHIVE"
download_sha512 \
  "https://storage.googleapis.com/gvisor/releases/release/${GVISOR_VERSION}/${GVISOR_ARCH}/runsc" \
  "$RUNSC_SHA512" "$RUNSC_BINARY"

mkdir -p "${WORK_DIR}/containerd" "${WORK_DIR}/buildkit" "${WORK_DIR}/cni" \
  "${WORK_DIR}/syft" "${WORK_DIR}/grype" "${WORK_DIR}/bundle/bin" "${WORK_DIR}/bundle/cni/bin"
tar -xzf "$CONTAINERD_ARCHIVE" -C "${WORK_DIR}/containerd"
tar -xzf "$BUILDKIT_ARCHIVE" -C "${WORK_DIR}/buildkit"
tar -xzf "$CNI_ARCHIVE" -C "${WORK_DIR}/cni"
tar -xzf "$SYFT_ARCHIVE" -C "${WORK_DIR}/syft"
tar -xzf "$GRYPE_ARCHIVE" -C "${WORK_DIR}/grype"

for binary in containerd ctr containerd-shim-runc-v2; do
  install -m 0755 "${WORK_DIR}/containerd/bin/${binary}" "${WORK_DIR}/bundle/bin/${binary}"
done
for binary in buildkitd buildctl; do
  install -m 0755 "${WORK_DIR}/buildkit/bin/${binary}" "${WORK_DIR}/bundle/bin/${binary}"
done
install -m 0755 "$RUNSC_BINARY" "${WORK_DIR}/bundle/bin/runsc"
install -m 0755 "${WORK_DIR}/syft/syft" "${WORK_DIR}/bundle/bin/syft"
install -m 0755 "${WORK_DIR}/grype/grype" "${WORK_DIR}/bundle/bin/grype"
for plugin in bridge host-local firewall loopback; do
  install -m 0755 "${WORK_DIR}/cni/${plugin}" "${WORK_DIR}/bundle/cni/bin/${plugin}"
done

printf '%s\n' \
  "format=1" \
  "gateway_release=${GATEWAY_RELEASE}" \
  "architecture=${ARCH}" \
  "containerd=${CONTAINERD_VERSION}" \
  "buildkit=${BUILDKIT_VERSION}" \
  "gvisor=release-${GVISOR_VERSION}.0" \
  "cni_plugins=${CNI_VERSION}" \
  "syft=${SYFT_VERSION}" \
  "grype=${GRYPE_VERSION}" \
  > "${WORK_DIR}/bundle/runtime-manifest"

SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-0}"
tar --sort=name --mtime="@${SOURCE_DATE_EPOCH}" --owner=0 --group=0 --numeric-owner \
  -czf "$OUTPUT" -C "${WORK_DIR}/bundle" .
sha256sum "$OUTPUT"
