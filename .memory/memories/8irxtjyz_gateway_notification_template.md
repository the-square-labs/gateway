---
{
  "id": "8irxtjyz",
  "file_name": "8irxtjyz_gateway_notification_template",
  "tags": [
    "gateway",
    "memory-update",
    "notifications",
    "templates",
    "verification",
    "webhooks"
  ],
  "layer": "deep",
  "ref": null,
  "created_at": 1783070851927,
  "updated_at": 1783070851927
}
---
Project scope: gateway notifications templates now rely on a canonical nested context across alert messages, webhook dispatch, webhook preview, presets, and frontend help. Supported variable families (namespaced) include: notification.*, alert.*, resource.*, metric.*, node.*, health.*, certificate.*, state.*, event.*, fired.*, resolution.*, and gateway.*. Historically used flat variables (e.g., value, data_value, resourceName, fired_at, fired_duration) are intentionally excluded from the generated render context. Helpers available: coalesce and existing formatting helpers.

Verification and tests:
- Run: rtk corepack pnpm --filter backend test -- src/modules/notifications/notification-evaluator.service.test.ts src/modules/notifications/notification-dispatcher.service.test.ts src/modules/notifications/notification.constants.test.ts src/modules/notifications/notification-templates.test.ts
- Typecheck: rtk corepack pnpm --filter backend typecheck
- Frontend build: rtk corepack pnpm --filter frontend build

Important edge cases:
- Container lifecycle events should place the real Docker containerId into resource.id when present; resource.key remains the alert state/dedupe key.
- Webhook preview should use NotificationDispatcherService.getGatewayUrl() just like real dispatch.

Notes:
- This content updates project conventions for rendering context and verification workflows. The changes are durable for the project and should be incorporated into repository-level practices and tests."
