ALTER TABLE "sandbox_jobs" ADD COLUMN "workspace_reservation_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_jobs" ADD COLUMN "workspace_usage_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sandbox_jobs" ADD COLUMN "workspace_reservation_released_at" timestamp with time zone;