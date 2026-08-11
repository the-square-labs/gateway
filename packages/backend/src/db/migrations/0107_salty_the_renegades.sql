ALTER TABLE "users" ADD COLUMN "preferred_interface" varchar(32);--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "preferred_interface_selected_at" timestamp with time zone;