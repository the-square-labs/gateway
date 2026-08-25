ALTER TABLE "docker_source_bindings" ADD COLUMN "last_poll_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD COLUMN "last_poll_error" text;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD COLUMN "webhook_configured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD COLUMN "webhook_provider_id" text;