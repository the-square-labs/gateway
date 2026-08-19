ALTER TABLE "inference_request_attempts" ADD COLUMN "budget_type" varchar(16);--> statement-breakpoint
ALTER TABLE "inference_request_attempts" ADD COLUMN "pricing_snapshot_id" uuid;--> statement-breakpoint
ALTER TABLE "inference_request_attempts" ADD COLUMN "price_version" varchar(80);--> statement-breakpoint
ALTER TABLE "inference_request_attempts" ADD COLUMN "model_multiplier" numeric(20, 6);--> statement-breakpoint
ALTER TABLE "inference_request_attempts" ADD COLUMN "burn_multiplier" numeric(20, 6);--> statement-breakpoint
ALTER TABLE "inference_request_attempts" ADD COLUMN "service_tier_multiplier" numeric(20, 6) DEFAULT '1' NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_request_attempts" ADD COLUMN "fixed_api_microdollars" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_request_attempts" ADD COLUMN "reserved_api_microdollars" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_request_attempts" ADD COLUMN "reservation_id" text;--> statement-breakpoint
ALTER TABLE "inference_requests" ADD COLUMN "fixed_api_microdollars" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_request_attempts" ADD CONSTRAINT "inference_request_attempts_pricing_snapshot_id_inference_pricing_snapshots_id_fk" FOREIGN KEY ("pricing_snapshot_id") REFERENCES "public"."inference_pricing_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_request_attempts" ADD CONSTRAINT "inference_attempts_accounting_nonnegative" CHECK ("inference_request_attempts"."fixed_api_microdollars" >= 0 AND "inference_request_attempts"."reserved_api_microdollars" >= 0 AND "inference_request_attempts"."service_tier_multiplier" > 0);