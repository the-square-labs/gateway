ALTER TABLE "nodes" ADD COLUMN "service_addresses" text[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
UPDATE "nodes"
SET "service_addresses" = ARRAY_REMOVE(ARRAY["service_address", "secondary_service_address"], NULL)
WHERE "service_address" IS NOT NULL OR "secondary_service_address" IS NOT NULL;
