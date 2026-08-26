#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
compose_file="$repo_root/scripts/fixtures/release-upgrade.compose.yml"
seed_file="$repo_root/scripts/fixtures/release-upgrade-seed.sql"
verify_file="$repo_root/scripts/fixtures/release-upgrade-verify.sql"
run_suffix="$(date +%Y%m%d%H%M%S)-$$"
project="${GATEWAY_RELEASE_E2E_PROJECT:-gateway-release-upgrade-e2e-$run_suffix}"
workload="${project}-workload"
old_app_version="${GATEWAY_RELEASE_E2E_OLD_APP_VERSION:-v2.8.18}"
old_relay_version="${GATEWAY_RELEASE_E2E_OLD_RELAY_VERSION:-v2.8.4}"
old_app_image="${GATEWAY_RELEASE_E2E_OLD_APP_IMAGE:-registry.gitlab.wiolett.net/wiolett/gateway:${old_app_version}}"
old_relay_image="${GATEWAY_RELEASE_E2E_OLD_RELAY_IMAGE:-registry.gitlab.wiolett.net/wiolett/gateway/relay:${old_relay_version}-relay}"
candidate_app_image="${GATEWAY_RELEASE_E2E_CANDIDATE_APP_IMAGE:-gateway:release-e2e-candidate}"
db_password="release-e2e-db"
pki_key="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
buildx_config="${TMPDIR:-/tmp}/gateway-release-buildx-$run_suffix"
keep="${GATEWAY_RELEASE_E2E_KEEP:-0}"

if [[ ! "$project" =~ ^gateway-release-upgrade-e2e-[a-zA-Z0-9_-]+$ ]]; then
  echo "Refusing unsafe Compose project name: $project" >&2
  exit 2
fi
if docker compose ls --format json | grep -Fq "\"Name\":\"$project\""; then
  echo "Refusing to reuse existing Compose project: $project" >&2
  exit 2
fi
if docker container inspect "$workload" >/dev/null 2>&1; then
  echo "Refusing to reuse existing workload container: $workload" >&2
  exit 2
fi

mkdir -p "$buildx_config"

export GATEWAY_E2E_DB_PASSWORD="$db_password"
export GATEWAY_E2E_PKI_MASTER_KEY="$pki_key"
export GATEWAY_E2E_HTTP_PORT=0
export GATEWAY_E2E_RELAY_PORT=0
export GATEWAY_E2E_POSTGRES_PORT=0

compose() {
  docker compose -p "$project" -f "$compose_file" "$@"
}

set_images() {
  export GATEWAY_E2E_APP_IMAGE="$1"
  export GATEWAY_E2E_RELAY_IMAGE="$2"
  export GATEWAY_E2E_APP_VERSION="$3"
  export GATEWAY_E2E_RELAY_BUILD_VERSION="$4"
}

cleanup() {
  local exit_code=$?
  if (( exit_code != 0 )); then
    echo "Release upgrade E2E failed; recent service logs:" >&2
    compose logs --tail=120 app relay postgres redis >&2 || true
  fi
  if [[ "$keep" == "1" ]]; then
    echo "Keeping isolated project $project and workload $workload"
  else
    docker rm -f "$workload" >/dev/null 2>&1 || true
    compose down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$buildx_config"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

wait_healthy() {
  local service="$1"
  local deadline=$((SECONDS + 180))
  local container_id health
  container_id="$(compose ps -q "$service")"
  while (( SECONDS < deadline )); do
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
    if [[ "$health" == "healthy" ]]; then
      return 0
    fi
    if [[ "$health" == "unhealthy" || "$health" == "exited" || "$health" == "dead" ]]; then
      echo "$service entered terminal state: $health" >&2
      return 1
    fi
    sleep 2
  done
  echo "Timed out waiting for $service health" >&2
  return 1
}

host_port() {
  compose port "$1" "$2" | awk -F: '{print $NF}'
}

wait_app_version() {
  local expected="$1"
  local deadline=$((SECONDS + 90))
  local actual=""
  while (( SECONDS < deadline )); do
    actual="$(compose exec -T app printenv APP_VERSION 2>/dev/null || true)"
    if [[ "$actual" == "$expected" ]]; then
      return 0
    fi
    sleep 2
  done
  echo "Candidate container did not report APP_VERSION=$expected: $actual" >&2
  return 1
}

verify_database() {
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U gateway -d gateway < "$verify_file"
}

assert_workload_unchanged() {
  local current_id current_restart_count
  current_id="$(docker inspect --format '{{.Id}}' "$workload")"
  current_restart_count="$(docker inspect --format '{{.RestartCount}}' "$workload")"
  [[ "$current_id" == "$workload_id" ]] || { echo "Disposable workload container was replaced" >&2; return 1; }
  [[ "$current_restart_count" == "$workload_restart_count" ]] || {
    echo "Disposable workload restarted during Gateway upgrade" >&2
    return 1
  }
}

assert_relay_unchanged() {
  local current_id current_restart_count
  current_id="$(compose ps -q relay)"
  current_restart_count="$(docker inspect --format '{{.RestartCount}}' "$current_id")"
  [[ "$current_id" == "$relay_id" ]] || { echo "Relay container was replaced by a Gateway patch upgrade" >&2; return 1; }
  [[ "$current_restart_count" == "$relay_restart_count" ]] || {
    echo "Relay restarted during a Gateway patch upgrade" >&2
    return 1
  }
}

cd "$repo_root"

echo "Pulling release baseline images"
docker pull --platform linux/amd64 "$old_app_image"
docker pull --platform linux/amd64 "$old_relay_image"

if [[ "${GATEWAY_RELEASE_E2E_SKIP_BUILD:-0}" != "1" ]]; then
  echo "Building candidate Gateway image"
  BUILDX_CONFIG="$buildx_config" docker buildx build --platform linux/amd64 --load -t "$candidate_app_image" -f Dockerfile .
fi

echo "Starting isolated ${old_app_version} deployment: $project"
set_images "$old_app_image" "$old_relay_image" "$old_app_version" "${old_relay_version}-relay"
compose up -d
wait_healthy postgres
wait_healthy redis
wait_healthy app
wait_healthy relay
relay_id="$(compose ps -q relay)"
relay_restart_count="$(docker inspect --format '{{.RestartCount}}' "$relay_id")"

compose exec -T postgres psql -v ON_ERROR_STOP=1 -U gateway -d gateway < "$seed_file"
postgres_id="$(compose ps -q postgres)"
redis_id="$(compose ps -q redis)"

docker run -d --name "$workload" --label "com.wiolett.gateway.release-e2e=$project" nginx:alpine >/dev/null
workload_id="$(docker inspect --format '{{.Id}}' "$workload")"
workload_restart_count="$(docker inspect --format '{{.RestartCount}}' "$workload")"

echo "Applying a Gateway patch upgrade while preserving Relay"
set_images "$candidate_app_image" "$old_relay_image" "release-e2e-candidate" "${old_relay_version}-relay"
compose up -d --no-deps --force-recreate app
wait_healthy app
wait_healthy relay

[[ "$(compose ps -q postgres)" == "$postgres_id" ]] || { echo "PostgreSQL container was replaced" >&2; exit 1; }
[[ "$(compose ps -q redis)" == "$redis_id" ]] || { echo "Redis container was replaced" >&2; exit 1; }
assert_workload_unchanged
assert_relay_unchanged
verify_database

http_port="$(host_port app 3000)"
postgres_port="$(host_port postgres 5432)"
echo "Running API E2E suite against upgraded candidate"
DATABASE_URL="postgres://gateway:$db_password@127.0.0.1:$postgres_port/gateway" \
GATEWAY_E2E_API_URL="http://127.0.0.1:$http_port" \
GATEWAY_E2E_PROFILE=release-upgrade \
GATEWAY_E2E_ALLOW_MUTATIONS=1 \
pnpm --filter backend e2e:api

echo "Restarting the candidate Gateway and re-verifying persisted state"
compose restart app
wait_healthy app
wait_healthy relay
verify_database
assert_workload_unchanged
assert_relay_unchanged

wait_app_version "release-e2e-candidate"

echo "Release upgrade E2E passed for $project"
