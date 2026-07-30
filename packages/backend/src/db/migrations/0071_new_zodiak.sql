ALTER TABLE "inference_tokens" ADD COLUMN "managed_by" varchar(64);--> statement-breakpoint
ALTER TABLE "inference_tokens" ADD COLUMN "harness" varchar(64);--> statement-breakpoint
ALTER TABLE "inference_tokens" ADD COLUMN "device_name" varchar(255);--> statement-breakpoint
ALTER TABLE "inference_tokens" ADD COLUMN "installation_id" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_tokens_managed_identity_active_unique" ON "inference_tokens" USING btree ("user_id","managed_by","harness","installation_id") WHERE "inference_tokens"."revoked_at" is null and "inference_tokens"."managed_by" is not null;