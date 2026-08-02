ALTER TABLE "users" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_from_group_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_deleted_by_user_id_users_id_fk" FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "users_deleted_at_idx" ON "users" USING btree ("deleted_at");