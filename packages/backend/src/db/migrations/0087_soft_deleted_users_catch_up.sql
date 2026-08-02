-- Compatibility catch-up for databases that applied managed-databases before
-- 0080_soft_deleted_users was added to the shared migration history.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_from_group_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_deleted_by_user_id_users_id_fk'
  ) THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_deleted_by_user_id_users_id_fk"
      FOREIGN KEY ("deleted_by_user_id") REFERENCES "public"."users"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_deleted_at_idx" ON "users" USING btree ("deleted_at");
