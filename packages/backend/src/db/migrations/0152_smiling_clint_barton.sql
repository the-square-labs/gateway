ALTER TABLE "docker_managed_volumes" ADD COLUMN "storage_kind" text DEFAULT 'regular' NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_managed_volumes" ADD COLUMN "capacity_bytes" bigint;