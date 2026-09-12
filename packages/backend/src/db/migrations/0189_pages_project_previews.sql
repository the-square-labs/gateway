ALTER TYPE "public"."page_replica_purpose" ADD VALUE 'storage';--> statement-breakpoint
ALTER TYPE "public"."page_replica_status" ADD VALUE 'revoked';--> statement-breakpoint
ALTER TABLE "page_projects" ADD COLUMN "previews_enabled" boolean DEFAULT true NOT NULL;