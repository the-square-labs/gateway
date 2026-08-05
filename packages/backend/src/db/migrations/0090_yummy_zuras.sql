CREATE TYPE "public"."system_certificate_lifecycle_state" AS ENUM('current', 'superseded', 'retired', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."system_certificate_owner_type" AS ENUM('node', 'managed_database', 'gateway_listener');--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "system_owner_type" "system_certificate_owner_type";--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "system_owner_id" varchar(255);--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "system_lifecycle_state" "system_certificate_lifecycle_state";--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "system_retired_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "certificates" ADD COLUMN "private_key_destroyed_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "cert_system_lifecycle_idx" ON "certificates" USING btree ("system_lifecycle_state","system_retired_at");--> statement-breakpoint
CREATE UNIQUE INDEX "cert_system_current_owner_unique" ON "certificates" USING btree ("system_owner_type","system_owner_id") WHERE "certificates"."system_lifecycle_state" = 'current';