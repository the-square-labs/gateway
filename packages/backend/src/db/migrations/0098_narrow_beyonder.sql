CREATE TYPE "public"."nginx_certificate_asset_format" AS ENUM('legacy', 'v2');--> statement-breakpoint
CREATE TYPE "public"."nginx_certificate_asset_state" AS ENUM('migration_pending', 'ready', 'migration_failed');--> statement-breakpoint
CREATE TYPE "public"."nginx_certificate_reference_type" AS ENUM('ssl', 'internal');--> statement-breakpoint
CREATE TYPE "public"."nginx_certificate_replica_status" AS ENUM('pending', 'ready', 'failed', 'daemon_update_required', 'cleanup_pending');--> statement-breakpoint
CREATE TYPE "public"."nginx_proxy_host_deployment_state" AS ENUM('candidate', 'active', 'superseded', 'failed', 'deleting');--> statement-breakpoint
CREATE TABLE "nginx_certificate_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference_type" "nginx_certificate_reference_type" NOT NULL,
	"reference_id" uuid NOT NULL,
	"format" "nginx_certificate_asset_format" DEFAULT 'v2' NOT NULL,
	"state" "nginx_certificate_asset_state" DEFAULT 'ready' NOT NULL,
	"encrypted_material" text,
	"encrypted_dek" text,
	"dek_iv" text,
	"fingerprint" varchar(128),
	"version" varchar(128),
	"migration_error" text,
	"migrated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nginx_certificate_replicas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"asset_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"desired_version" varchar(128),
	"applied_version" varchar(128),
	"observed_fingerprint" varchar(128),
	"status" "nginx_certificate_replica_status" DEFAULT 'pending' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_verified_at" timestamp with time zone,
	"cleanup_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nginx_proxy_host_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"asset_id" uuid,
	"generation" varchar(128) NOT NULL,
	"config_content" text NOT NULL,
	"state" "nginx_proxy_host_deployment_state" DEFAULT 'candidate' NOT NULL,
	"last_error" text,
	"applied_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nginx_certificate_replicas" ADD CONSTRAINT "nginx_certificate_replicas_asset_id_nginx_certificate_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."nginx_certificate_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nginx_certificate_replicas" ADD CONSTRAINT "nginx_certificate_replicas_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nginx_proxy_host_deployments" ADD CONSTRAINT "nginx_proxy_host_deployments_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "nginx_proxy_host_deployments" ADD CONSTRAINT "nginx_proxy_host_deployments_asset_id_nginx_certificate_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."nginx_certificate_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nginx_certificate_assets_reference_unique" ON "nginx_certificate_assets" USING btree ("reference_type","reference_id");--> statement-breakpoint
CREATE INDEX "nginx_certificate_assets_state_idx" ON "nginx_certificate_assets" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "nginx_certificate_replicas_asset_node_unique" ON "nginx_certificate_replicas" USING btree ("asset_id","node_id");--> statement-breakpoint
CREATE INDEX "nginx_certificate_replicas_node_status_idx" ON "nginx_certificate_replicas" USING btree ("node_id","status");--> statement-breakpoint
CREATE INDEX "nginx_certificate_replicas_cleanup_idx" ON "nginx_certificate_replicas" USING btree ("cleanup_after");--> statement-breakpoint
CREATE UNIQUE INDEX "nginx_proxy_host_deployments_host_generation_unique" ON "nginx_proxy_host_deployments" USING btree ("host_id","generation");--> statement-breakpoint
CREATE INDEX "nginx_proxy_host_deployments_node_state_idx" ON "nginx_proxy_host_deployments" USING btree ("node_id","state");--> statement-breakpoint
CREATE INDEX "nginx_proxy_host_deployments_asset_state_idx" ON "nginx_proxy_host_deployments" USING btree ("asset_id","state");