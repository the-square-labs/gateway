ALTER TABLE "proxy_hosts" ADD COLUMN "secure_link_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD COLUMN "secure_link_status" varchar(32) DEFAULT 'legacy' NOT NULL;--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD COLUMN "secure_link_last_error" text;--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD COLUMN "secure_link_target_network" varchar(255);--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD COLUMN "secure_link_target_container" varchar(255);--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD COLUMN "secure_link_target_host" varchar(255);--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD COLUMN "secure_link_listener_port" integer;--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD COLUMN "secure_link_connector_port" integer;--> statement-breakpoint
ALTER TABLE "proxy_hosts" ADD COLUMN "secure_link_migrated_at" timestamp with time zone;
