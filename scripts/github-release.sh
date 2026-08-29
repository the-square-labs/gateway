#!/usr/bin/env bash

set -euo pipefail

tag=${GITHUB_REF_NAME:?GITHUB_REF_NAME is required}
commit_sha=${GITHUB_SHA:?GITHUB_SHA is required}
run_id=${GITHUB_RUN_ID:?GITHUB_RUN_ID is required}
repository_owner=${GITHUB_REPOSITORY_OWNER:?GITHUB_REPOSITORY_OWNER is required}
repository=${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}
gateway_image="ghcr.io/${repository_owner,,}/gateway"
source_url="https://github.com/${repository}"

release_notes_file=release-notes.md
release_already_published=0

source scripts/release-tag.sh
classify_release_tag "$tag"

write_release_notes() {
  local fallback=$1
  git for-each-ref "refs/tags/${tag}" --format='%(contents)' > "$release_notes_file"
  if ! grep -q '[^[:space:]]' "$release_notes_file"; then
    printf '%s\n' "$fallback" > "$release_notes_file"
  fi
}

prepare_release() {
  local title=$1 fallback=$2 is_draft
  local release_args=(--title "$title" --notes-file "$release_notes_file")
  release_already_published=0
  write_release_notes "$fallback"
  if [[ "$RELEASE_PRERELEASE" == "true" ]]; then
    release_args+=(--prerelease --latest=false)
  else
    release_args+=(--prerelease=false)
  fi
  if gh release view "$tag" >/dev/null 2>&1; then
    is_draft=$(gh release view "$tag" --json isDraft --jq .isDraft)
    if [[ "$is_draft" != "true" ]]; then
      release_already_published=1
      return
    fi
    gh release edit "$tag" "${release_args[@]}"
    return
  fi
  gh release create "$tag" --draft --verify-tag "${release_args[@]}"
}

verify_release_assets() {
  local asset expected actual_assets
  actual_assets=$(gh release view "$tag" --json assets --jq '.assets[].name')
  for asset in "$@"; do
    expected=$(basename "$asset")
    if ! grep -Fxq "$expected" <<<"$actual_assets"; then
      printf 'GitHub Release %s is missing expected asset %s\n' "$tag" "$expected" >&2
      exit 1
    fi
  done
}

complete_release() {
  if [[ "$release_already_published" -eq 1 ]]; then
    verify_release_assets "$@"
    printf 'GitHub Release %s is already complete\n' "$tag"
    return
  fi
  if (($# > 0)); then
    gh release upload "$tag" "$@" --clobber
  fi
  verify_release_assets "$@"
  gh release edit "$tag" --draft=false
}

docker_login() {
  test -n "${GH_TOKEN:-}" || { printf 'GH_TOKEN is required\n' >&2; exit 1; }
  printf '%s' "$GH_TOKEN" | docker login ghcr.io --username "$GITHUB_ACTOR" --password-stdin
}

require_signing_key() {
  test -n "${UPDATE_SIGNING_PRIVATE_KEY_PEM_B64:-}" || {
    printf 'UPDATE_SIGNING_PRIVATE_KEY_PEM_B64 is required for signed releases\n' >&2
    exit 1
  }
}

push_image_with_digest() {
  local image_ref=$1 digest_file=$2 label=$3
  sh scripts/push-image-with-digest.sh "$image_ref" "$digest_file" "$label"
}

publish_gateway() {
  local digest
  local assets=(
    gateway-image.update.json
    gateway-daemon-installers.sha256
    scripts/setup-daemon.sh
    scripts/setup-node.sh
    scripts/setup-docker-node.sh
    scripts/setup-database-node.sh
    scripts/setup-monitoring-node.sh
  )
  prepare_release "Gateway ${tag}" "Gateway release ${tag}"
  if [[ "$release_already_published" -eq 1 ]]; then
    complete_release "${assets[@]}"
    return
  fi
  require_signing_key
  docker_login
  ./scripts/sync-update-trust-anchor.sh
  docker build \
    --tag "${gateway_image}:${tag}" \
    --build-arg "APP_VERSION=${tag}" \
    --label "org.opencontainers.image.source=${source_url}" \
    .
  push_image_with_digest "${gateway_image}:${tag}" gateway-image.digest "gateway image"
  digest=$(<gateway-image.digest)
  (
    cd packages/daemons
    go run ./shared/cmd/update-trust sign \
      --kind gateway-image \
      --version "$tag" \
      --tag "$tag" \
      --image "$gateway_image" \
      --digest "$digest" \
      --git-commit-sha "$commit_sha" \
      --git-pipeline-id "$run_id" \
      --out ../../gateway-image.update.json
  )
  docker tag "${gateway_image}:${tag}" "${gateway_image}:${tag#v}"
  docker push "${gateway_image}:${tag#v}"
  if [[ "$RELEASE_PRERELEASE" != "true" ]]; then
    docker tag "${gateway_image}:${tag}" "${gateway_image}:latest"
    docker push "${gateway_image}:latest"
  fi
  (
    cd scripts
    sha256sum setup-daemon.sh setup-node.sh setup-docker-node.sh setup-database-node.sh setup-monitoring-node.sh > ../gateway-daemon-installers.sha256
  )
  complete_release "${assets[@]}"
}

build_daemon_assets() {
  local daemon_dir=$1 daemon_name=$2 daemon_suffix=$3 ldflags_version_pkg=$4
  local version=${tag%-${daemon_suffix}}
  local arch artifact sha

  ./scripts/sync-update-trust-anchor.sh
  (
    cd "packages/daemons/${daemon_dir}"
    for arch in amd64 arm64; do
      CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build \
        -ldflags "-s -w -X ${ldflags_version_pkg}.Version=${version}" \
        -o "../../../${daemon_name}-linux-${arch}" \
        "./cmd/${daemon_name}"
    done
  )
  if [[ "$daemon_name" == "relay-supervisor" ]]; then
    for arch in amd64 arm64; do
      (
        cd packages/relay
        CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build \
          -ldflags "-s -w -X main.buildVersion=${version}" \
          -o "../../relay-worker-linux-${arch}" \
          ./cmd/gateway-relay
      )
    done
  fi

  : > checksums.txt
  for arch in amd64 arm64; do
    sha256sum "${daemon_name}-linux-${arch}" >> checksums.txt
  done
  if [[ "$daemon_name" == "relay-supervisor" ]]; then
    for arch in amd64 arm64; do
      sha256sum "relay-worker-linux-${arch}" >> checksums.txt
    done
  fi

  for arch in amd64 arm64; do
    artifact="${daemon_name}-linux-${arch}"
    sha=$(sha256sum "$artifact" | awk '{print $1}')
    (
      cd packages/daemons
      go run ./shared/cmd/update-trust sign \
        --kind daemon-binary \
        --version "$version" \
        --tag "$tag" \
        --daemon-type "$daemon_suffix" \
        --arch "$arch" \
        --artifact-name "$artifact" \
        --download-url "https://updates.thesqlabs.com/gateway/${daemon_name}/${tag}/${artifact}" \
        --sha256 "$sha" \
        --git-commit-sha "$commit_sha" \
        --git-pipeline-id "$run_id" \
        --out "../../${artifact}.update.json"
    )
  done

  if [[ "$daemon_name" == "relay-supervisor" ]]; then
    for arch in amd64 arm64; do
      artifact="relay-worker-linux-${arch}"
      sha=$(sha256sum "$artifact" | awk '{print $1}')
      (
        cd packages/daemons
        go run ./shared/cmd/update-trust sign \
          --kind daemon-binary \
          --version "$version" \
          --tag "$tag" \
          --daemon-type relay-worker \
          --arch "$arch" \
          --artifact-name "$artifact" \
          --download-url "https://updates.thesqlabs.com/gateway/relay-supervisor/${tag}/${artifact}" \
          --sha256 "$sha" \
          --git-commit-sha "$commit_sha" \
          --git-pipeline-id "$run_id" \
          --out "../../${artifact}.update.json"
      )
    done
  fi
}

publish_daemon() {
  local daemon_dir=$1 daemon_name=$2 daemon_suffix=$3 daemon_label=$4 ldflags_version_pkg=$5
  local assets=(checksums.txt)
  local arch
  for arch in amd64 arm64; do
    assets+=("${daemon_name}-linux-${arch}" "${daemon_name}-linux-${arch}.update.json")
  done
  prepare_release "${daemon_label} ${tag}" "${daemon_label} release ${tag}"
  if [[ "$release_already_published" -eq 1 ]]; then
    complete_release "${assets[@]}"
    return
  fi
  require_signing_key
  ./scripts/sync-update-trust-anchor.sh
  build_daemon_assets "$daemon_dir" "$daemon_name" "$daemon_suffix" "$ldflags_version_pkg"
  complete_release "${assets[@]}"
}

publish_relay() {
  local relay_version=${tag%-relay}
  local relay_image="${gateway_image}/relay"
  local secure_link_image="${gateway_image}/secure-link-connector"
  local relay_digest secure_link_digest min_gateway_version arch
  local assets=(relay-image.update.json checksums.txt)

  for arch in amd64 arm64; do
    assets+=(
      "relay-supervisor-linux-${arch}"
      "relay-supervisor-linux-${arch}.update.json"
      "relay-worker-linux-${arch}"
      "relay-worker-linux-${arch}.update.json"
    )
  done
  prepare_release "Gateway Relay ${tag}" "Gateway Relay release ${tag}"
  if [[ "$release_already_published" -eq 1 ]]; then
    complete_release "${assets[@]}"
    return
  fi

  require_signing_key
  docker_login
  ./scripts/sync-update-trust-anchor.sh

  docker build \
    --file packages/relay/Dockerfile \
    --build-arg "RELAY_BUILD_VERSION=${relay_version}" \
    --tag "${relay_image}:${tag}" \
    --label "org.opencontainers.image.source=${source_url}" \
    .
  push_image_with_digest "${relay_image}:${tag}" relay-image.digest "relay image"

  docker build \
    --file packages/daemons/secure-link-connector/Dockerfile \
    --tag "${secure_link_image}:${tag}" \
    --label "org.opencontainers.image.source=${source_url}" \
    packages/daemons
  push_image_with_digest "${secure_link_image}:${tag}" secure-link-connector.digest "secure-link connector image"

  relay_digest=$(<relay-image.digest)
  secure_link_digest=$(<secure-link-connector.digest)
  min_gateway_version=$(<config/relay/min-gateway-version)
  (
    cd packages/daemons
    go run ./shared/cmd/update-trust sign \
      --kind relay-image \
      --version "$relay_version" \
      --tag "$tag" \
      --image "$relay_image" \
      --digest "$relay_digest" \
      --relay-protocol-major 1 \
      --min-gateway-version "$min_gateway_version" \
      --secure-link-connector-image "${secure_link_image}@${secure_link_digest}" \
      --git-commit-sha "$commit_sha" \
      --git-pipeline-id "$run_id" \
      --out ../../relay-image.update.json
  )

  build_daemon_assets relay relay-supervisor relay "main"
  docker tag "${relay_image}:${tag}" "${relay_image}:${relay_version}"
  docker push "${relay_image}:${relay_version}"
  if [[ "$RELEASE_PRERELEASE" != "true" ]]; then
    docker tag "${relay_image}:${tag}" "${relay_image}:latest"
    docker push "${relay_image}:latest"
  fi
  complete_release "${assets[@]}"
}

if [[ "$RELEASE_KIND" == "gateway" ]]; then
  publish_gateway
elif [[ "$RELEASE_COMPONENT" == "relay" ]]; then
  publish_relay
elif [[ "$RELEASE_COMPONENT" == "nginx" ]]; then
  publish_daemon nginx nginx-daemon nginx "Nginx Daemon" github.com/wiolett-industries/gateway/nginx-daemon/internal/daemon
elif [[ "$RELEASE_COMPONENT" == "docker" ]]; then
  publish_daemon docker docker-daemon docker "Docker Daemon" main
elif [[ "$RELEASE_COMPONENT" == "monitoring" ]]; then
  publish_daemon monitoring monitoring-daemon monitoring "Monitoring Daemon" main
else
  printf 'Tag %s is not a supported Gateway release tag\n' "$tag" >&2
  exit 1
fi
