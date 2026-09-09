ALTER TABLE "users" ADD COLUMN "additional_group_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "deleted_from_additional_group_ids" uuid[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE INDEX "users_additional_group_ids_idx" ON "users" USING gin ("additional_group_ids");