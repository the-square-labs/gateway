-- Webhook deliveries go out per webhook in queue order (seq), one at a time, and each alert notification names the
-- alert state it is about, so a firing that never went out is dropped once its resolve exists. While a webhook's
-- target cannot be reached the whole webhook pauses and resumes in order (delivery_paused_until, delivery_failures);
-- one sender at a time holds its lease (delivery_lease_until, delivery_lease_token). Rows already queued keep the
-- order they were created in. A release before this one ignores the new columns.
ALTER TABLE "notification_delivery_log" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
UPDATE "notification_delivery_log" AS "d" SET "seq" = "o"."rn"
FROM (SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS "rn" FROM "notification_delivery_log") AS "o"
WHERE "d"."id" = "o"."id";--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('notification_delivery_log', 'seq'), coalesce(max("seq"), 0) + 1, false)
FROM "notification_delivery_log";--> statement-breakpoint
ALTER TABLE "notification_delivery_log" ADD COLUMN "alert_state_id" uuid;--> statement-breakpoint
ALTER TABLE "notification_webhooks" ADD COLUMN "delivery_paused_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_webhooks" ADD COLUMN "delivery_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notification_webhooks" ADD COLUMN "delivery_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "notification_webhooks" ADD COLUMN "delivery_lease_token" uuid;--> statement-breakpoint
CREATE INDEX "notif_delivery_log_queue_idx" ON "notification_delivery_log" USING btree ("webhook_id","seq") WHERE status in ('pending', 'retrying');--> statement-breakpoint
CREATE INDEX "notif_delivery_log_alert_state_idx" ON "notification_delivery_log" USING btree ("alert_state_id");
