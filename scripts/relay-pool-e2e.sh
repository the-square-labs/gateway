#!/usr/bin/env bash
set -Eeuo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
skip_release_upgrade="${GATEWAY_RELAY_POOL_E2E_SKIP_RELEASE_UPGRADE:-0}"

cd "$repo_root"

echo "Verifying Relay Pool protocol and generated contracts"
pnpm run proto

echo "Verifying Relay Pool backend orchestration, enrollment, policy, and updates"
pnpm --filter backend test -- \
  src/modules/admin/admin.schemas.test.ts \
  src/modules/settings/general-settings.service.test.ts \
  src/modules/proxy/proxy.schemas.relay-spread.test.ts \
  src/services/relay-pool.service.test.ts \
  src/services/relay-policy.service.test.ts \
  src/services/relay-policy-signing-key.service.test.ts \
  src/services/relay-supervisor.service.test.ts \
  src/services/update.service.test.ts \
  src/services/daemon-update.service.test.ts \
  src/config/install-script.test.ts \
  src/modules/nodes/nodes.service.test.ts \
  src/grpc/services/enrollment.test.ts

echo "Verifying relay admission, policy freshness, drain, and tunnel telemetry"
pnpm run test:relay

echo "Verifying supervisors, candidate ordering, generation checks, probes, and fallback"
pnpm run test:daemon

echo "Verifying Relay Pool operator surfaces"
pnpm --filter frontend test -- \
  src/components/proxy/ProxyUpstreamEditor.panel.test.tsx \
  src/pages/ProxyHostDetail.test.tsx \
  src/pages/proxy-detail/RouteConfigPanels.test.tsx \
  src/pages/proxy-detail/SettingsTab.test.tsx \
  src/pages/settings/RelaySettingsSection.test.tsx \
  src/pages/settings/UpdateSection.test.tsx

if [[ "$skip_release_upgrade" == "1" ]]; then
  echo "Skipping release-upgrade compatibility harness by explicit request"
else
  echo "Verifying released singleton to Relay Pool migration and relay preservation"
  pnpm run test:release-upgrade
fi

echo "Relay Pool integration contract passed"
