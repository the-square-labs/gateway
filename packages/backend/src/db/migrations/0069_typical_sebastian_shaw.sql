ALTER TABLE "inference_limit_policies" ADD COLUMN "credits_5h_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_limit_policies" ADD COLUMN "credits_7d_enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "inference_limit_policies" ADD COLUMN "credits_30d_enabled" boolean DEFAULT true NOT NULL;