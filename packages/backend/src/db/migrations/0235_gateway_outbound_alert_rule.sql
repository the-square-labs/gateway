-- Built-in alert rule "Gateway lost outbound connectivity" (category gateway, event outbound.unavailable): one alert
-- when Gateway itself cannot reach the internet or its webhook targets, which the route alerts this explains fold
-- under instead of each alerting on its own. It notifies the enabled webhooks the enabled proxy and node rules notify
-- now, so an install that alerts on routes gets this alert without setup; a fresh install has none to copy and the
-- operator picks them. Created once: an install that already has such a rule keeps its own.
INSERT INTO "notification_alert_rules" (
  "name", "enabled", "type", "severity", "category", "event_pattern", "duration_seconds", "fire_threshold_percent",
  "resolve_after_seconds", "resolve_threshold_percent", "resource_ids", "message_template", "webhook_ids",
  "cooldown_seconds", "is_builtin"
)
SELECT
  'Gateway lost outbound connectivity', true, 'event', 'critical', 'gateway', 'outbound.unavailable', 40, 100, 60, 100,
  '[]'::jsonb,
  'Gateway cannot reach {{details.targets}}. Route alerts this explains are folded into this alert, and notifications wait until Gateway can send them.',
  coalesce(
    (
      SELECT jsonb_agg(DISTINCT "w"."id"::text)
      FROM "notification_alert_rules" AS "r"
      CROSS JOIN LATERAL jsonb_array_elements_text("r"."webhook_ids") AS "rw"("id")
      JOIN "notification_webhooks" AS "w" ON "w"."id"::text = "rw"."id" AND "w"."enabled"
      WHERE "r"."enabled" AND "r"."category" IN ('proxy', 'node')
    ),
    '[]'::jsonb
  ),
  900, true
WHERE NOT EXISTS (
  SELECT 1 FROM "notification_alert_rules" WHERE "category" = 'gateway' AND "event_pattern" = 'outbound.unavailable'
);
