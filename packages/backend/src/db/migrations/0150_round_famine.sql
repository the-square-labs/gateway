ALTER TYPE "public"."relay_assignment_role" ADD VALUE 'active';--> statement-breakpoint
ALTER TABLE "relay_endpoint_assignments" DROP CONSTRAINT "relay_endpoint_assignments_generation_role_unique";--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD COLUMN "relay_spread_mode" varchar(16) DEFAULT 'inherit' NOT NULL;--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD COLUMN "relay_spread_count" integer;--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD CONSTRAINT "proxy_hosts_relay_spread_mode_valid" CHECK ("proxy_hosts"."relay_spread_mode" IN ('inherit', 'fixed', 'all'));--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD CONSTRAINT "proxy_hosts_relay_spread_count_valid" CHECK (("proxy_hosts"."relay_spread_mode" = 'fixed' AND "proxy_hosts"."relay_spread_count" BETWEEN 1 AND 64) OR ("proxy_hosts"."relay_spread_mode" <> 'fixed' AND "proxy_hosts"."relay_spread_count" IS NULL));