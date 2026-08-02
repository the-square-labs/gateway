ALTER TYPE "public"."managed_database_status" ADD VALUE 'updating' BEFORE 'ready';--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD COLUMN "pending_operation" jsonb;