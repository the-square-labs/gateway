ALTER TABLE "proxy_hosts" ADD COLUMN "rate_limit_mode" varchar(16) DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
UPDATE "proxy_hosts" SET "rate_limit_mode" = 'custom' WHERE "rate_limit_enabled" = true;
