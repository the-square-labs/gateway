ALTER TABLE "inference_provider_connections" DROP CONSTRAINT "inference_provider_connections_minimum_remaining_range";--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ALTER COLUMN "minimum_remaining_percent" SET DEFAULT 1;--> statement-breakpoint
UPDATE "inference_provider_connections" SET "minimum_remaining_percent" = 1 WHERE "minimum_remaining_percent" < 1;--> statement-breakpoint
ALTER TABLE "inference_provider_connections" ADD CONSTRAINT "inference_provider_connections_minimum_remaining_range" CHECK ("inference_provider_connections"."minimum_remaining_percent" >= 1 AND "inference_provider_connections"."minimum_remaining_percent" <= 100);
