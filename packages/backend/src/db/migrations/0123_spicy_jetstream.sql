CREATE TYPE "public"."domain_cloudflare_migration_status" AS ENUM('pending', 'migrated', 'zone_unavailable', 'zone_ambiguous', 'ingress_unavailable', 'dns_conflict', 'ignored', 'error');--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "ingress_migration_id" uuid;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "ingress_migration_source_node_id" uuid;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "ingress_migration_status" varchar(32);--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "ingress_migration_error" text;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "ingress_migration_proxy_host_ids" jsonb;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "ingress_migration_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "cloudflare_migration_status" "domain_cloudflare_migration_status";--> statement-breakpoint
ALTER TABLE "domains" ADD COLUMN "cloudflare_migration_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_ingress_migration_source_node_id_nodes_id_fk" FOREIGN KEY ("ingress_migration_source_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;