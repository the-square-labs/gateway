ALTER TABLE "relay_instances" ADD COLUMN "manual_drain_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_instances" ADD COLUMN "drain_forced_at" timestamp with time zone;--> statement-breakpoint
-- Existing manual drains receive a bounded grace period after the upgrade.
-- Pool-update drains remain owned by their update run, not this deadline.
UPDATE "relay_instances" SET "manual_drain_started_at" = now()
WHERE "kind" = 'remote' AND "state" = 'draining'
AND NOT EXISTS (
  SELECT 1 FROM "relay_pool_update_runs" r
  WHERE r."pool_id" = "relay_instances"."pool_id"
    AND r."state" IN ('preflight', 'draining', 'updating', 'verifying', 'paused', 'rolling_back')
);
