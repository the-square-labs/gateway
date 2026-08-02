UPDATE "users" SET "name" = "email" WHERE "name" IS NULL OR btrim("name") = '';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_name_not_blank" CHECK (char_length(btrim("name")) > 0);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "last_login_at" timestamp with time zone;
