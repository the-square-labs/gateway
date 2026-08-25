ALTER TABLE "relay_endpoints" ALTER COLUMN "owner_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "relay_endpoints" ALTER COLUMN "subject_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "relay_routes" ALTER COLUMN "owner_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "relay_routes" ALTER COLUMN "source_id" SET DATA TYPE text;