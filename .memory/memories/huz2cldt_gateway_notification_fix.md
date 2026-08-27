---
{
  "id": "huz2cldt",
  "file_name": "huz2cldt_gateway_notification_fix",
  "tags": [
    "alerts",
    "bugfix",
    "gateway",
    "notifications",
    "verification"
  ],
  "layer": "deep",
  "ref": null,
  "source": "model_inferred",
  "confidence": 0.99,
  "importance": 0.85,
  "created_at": 1783024139300,
  "updated_at": 1787862676652
}
---
Project: wiolett gateway (path: the Gateway repository)

Issue summary:
- Threshold notification alerts currently use composite resource IDs for state tracking. Render labels must be derived separately from the state IDs.

Specific resource behaviors:
- Node disk alerts: composite IDs like nodeId:/; on firing, notifications must use the node hostname/name as resource.name, not the raw mount /, to avoid rendering as Resource: node// in Discord templates.
- Container metric alerts: composite IDs like nodeId:containerName; on resolve, notifications must retain the container name rather than switching to the node name.
- Database metric alerts: on resolve, must retain the database display name instead of falling back to the database ID.

Implementation fix:
- Change location: packages/backend/src/modules/notifications/notification-evaluator.service.ts
- Change behavior: pass the raw source/name into the clear handling and derive render names through getThresholdResourceName.

Regression tests:
- Location: packages/backend/src/modules/notifications/notification-evaluator.service.test.ts
- Verification commands:
  - corepack pnpm --filter backend test -- src/modules/notifications/notification-evaluator.service.test.ts
  - corepack pnpm --filter backend exec biome check src/modules/notifications/notification-evaluator.service.ts src/modules/notifications/notification-evaluator.service.test.ts

Notes:
- Regression coverage should ensure render names are derived via getThresholdResourceName and that raw sources/names are preserved for final render labels.
