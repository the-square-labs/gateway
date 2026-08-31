ALTER TABLE "integration_connectors" ADD COLUMN "encrypted_refresh_token" text;--> statement-breakpoint
ALTER TABLE "integration_connectors" ADD COLUMN "token_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integration_connectors" ADD COLUMN "refresh_token_expires_at" timestamp with time zone;