ALTER TABLE "inference_requests" DROP CONSTRAINT "inference_requests_charges_nonnegative";--> statement-breakpoint
ALTER TABLE "inference_requests" ADD COLUMN "service_tier" varchar(32);--> statement-breakpoint
ALTER TABLE "inference_requests" ADD COLUMN "service_tier_multiplier" numeric(20, 6) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_requests" ADD CONSTRAINT "inference_requests_charges_nonnegative" CHECK ("inference_requests"."credits_charged" >= 0 AND "inference_requests"."api_microdollars_charged" >= 0 AND "inference_requests"."service_tier_multiplier" > 0);