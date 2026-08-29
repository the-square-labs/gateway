CREATE TABLE "inference_limit_usage_resets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"dimension" varchar(32) NOT NULL,
	"reset_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
ALTER TABLE "inference_limit_usage_resets" ADD CONSTRAINT "inference_limit_usage_resets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_limit_usage_resets" ADD CONSTRAINT "inference_limit_usage_resets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "inference_limit_usage_reset_user_dimension_unique" ON "inference_limit_usage_resets" USING btree ("user_id","dimension");--> statement-breakpoint
CREATE INDEX "inference_limit_usage_reset_user_idx" ON "inference_limit_usage_resets" USING btree ("user_id");