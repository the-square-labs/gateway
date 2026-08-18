CREATE TYPE "public"."proxy_additional_route_target_kind" AS ENUM('manual', 'docker_container', 'docker_deployment', 'pages');--> statement-breakpoint
CREATE TYPE "public"."proxy_additional_route_status" AS ENUM('staging', 'provisioning', 'ready', 'disabled', 'failed', 'cleanup_pending');--> statement-breakpoint
ALTER TABLE "proxy_additional_secure_links" ADD COLUMN "purpose" varchar(32) DEFAULT 'user_managed' NOT NULL;--> statement-breakpoint
ALTER TABLE "proxy_additional_secure_links" ADD COLUMN "reference_id" uuid;--> statement-breakpoint
ALTER TABLE "proxy_additional_secure_links" ADD CONSTRAINT "proxy_additional_secure_links_purpose_check" CHECK ("purpose" in ('user_managed', 'additional_route'));--> statement-breakpoint
CREATE TABLE "proxy_additional_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proxy_host_id" uuid NOT NULL,
	"path" varchar(1024) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"target_kind" "proxy_additional_route_target_kind" NOT NULL,
	"forward_host" varchar(255),
	"forward_port" integer,
	"forward_scheme" "forward_scheme" DEFAULT 'http' NOT NULL,
	"docker_node_id" uuid,
	"docker_container_name" varchar(255),
	"docker_deployment_id" uuid,
	"docker_container_port" integer,
	"docker_host_port" integer,
	"docker_protocol" varchar(8),
	"secure_link_id" uuid,
	"migration_source_node_id" uuid,
	"migration_target_node_id" uuid,
	"migration_previous_secure_link_id" uuid,
	"migration_previous_include_path" text,
	"migration_previous_runtime_config_generation" integer,
	"page_project_id" uuid,
	"page_tag_id" uuid,
	"active_deployment_id" uuid,
	"include_path" text,
	"runtime_config_generation" integer DEFAULT 0 NOT NULL,
	"strip_prefix" boolean DEFAULT false NOT NULL,
	"websocket_support" boolean DEFAULT false NOT NULL,
	"request_buffering" boolean DEFAULT true NOT NULL,
	"response_buffering" boolean DEFAULT true NOT NULL,
	"connect_timeout_seconds" integer DEFAULT 60 NOT NULL,
	"read_timeout_seconds" integer DEFAULT 60 NOT NULL,
	"send_timeout_seconds" integer DEFAULT 60 NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"status" "proxy_additional_route_status" DEFAULT 'staging' NOT NULL,
	"last_error" text,
	"created_by_id" uuid NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "proxy_additional_routes" ADD CONSTRAINT "proxy_additional_routes_proxy_host_id_proxy_hosts_id_fk" FOREIGN KEY ("proxy_host_id") REFERENCES "public"."proxy_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_additional_routes" ADD CONSTRAINT "proxy_additional_routes_docker_node_id_nodes_id_fk" FOREIGN KEY ("docker_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_additional_routes" ADD CONSTRAINT "proxy_additional_routes_docker_deployment_id_docker_deployments_id_fk" FOREIGN KEY ("docker_deployment_id") REFERENCES "public"."docker_deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_additional_routes" ADD CONSTRAINT "proxy_additional_routes_secure_link_id_proxy_additional_secure_links_id_fk" FOREIGN KEY ("secure_link_id") REFERENCES "public"."proxy_additional_secure_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_additional_routes" ADD CONSTRAINT "proxy_additional_routes_migration_source_node_id_nodes_id_fk" FOREIGN KEY ("migration_source_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_additional_routes" ADD CONSTRAINT "proxy_additional_routes_migration_target_node_id_nodes_id_fk" FOREIGN KEY ("migration_target_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_additional_routes" ADD CONSTRAINT "proxy_additional_routes_migration_previous_secure_link_id_proxy_additional_secure_links_id_fk" FOREIGN KEY ("migration_previous_secure_link_id") REFERENCES "public"."proxy_additional_secure_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_additional_routes" ADD CONSTRAINT "proxy_additional_routes_page_project_id_page_projects_id_fk" FOREIGN KEY ("page_project_id") REFERENCES "public"."page_projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_additional_routes" ADD CONSTRAINT "proxy_additional_routes_page_tag_id_page_tags_id_fk" FOREIGN KEY ("page_tag_id") REFERENCES "public"."page_tags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_additional_routes" ADD CONSTRAINT "proxy_additional_routes_active_deployment_id_page_deployments_id_fk" FOREIGN KEY ("active_deployment_id") REFERENCES "public"."page_deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_additional_routes" ADD CONSTRAINT "proxy_additional_routes_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_additional_routes" ADD CONSTRAINT "proxy_additional_routes_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "proxy_additional_routes_host_path_unique" ON "proxy_additional_routes" USING btree ("proxy_host_id","path");--> statement-breakpoint
CREATE INDEX "proxy_additional_routes_host_idx" ON "proxy_additional_routes" USING btree ("proxy_host_id");--> statement-breakpoint
CREATE INDEX "proxy_additional_routes_target_idx" ON "proxy_additional_routes" USING btree ("target_kind");--> statement-breakpoint
CREATE INDEX "proxy_additional_routes_docker_node_idx" ON "proxy_additional_routes" USING btree ("docker_node_id");--> statement-breakpoint
CREATE INDEX "proxy_additional_routes_docker_deployment_idx" ON "proxy_additional_routes" USING btree ("docker_deployment_id");--> statement-breakpoint
CREATE INDEX "proxy_additional_routes_pages_tag_idx" ON "proxy_additional_routes" USING btree ("page_tag_id");--> statement-breakpoint
CREATE INDEX "proxy_additional_routes_pages_deployment_idx" ON "proxy_additional_routes" USING btree ("active_deployment_id");--> statement-breakpoint
CREATE INDEX "proxy_additional_routes_secure_link_idx" ON "proxy_additional_routes" USING btree ("secure_link_id");--> statement-breakpoint
CREATE INDEX "proxy_additional_routes_migration_target_idx" ON "proxy_additional_routes" USING btree ("migration_target_node_id");--> statement-breakpoint
CREATE INDEX "proxy_additional_routes_status_idx" ON "proxy_additional_routes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "proxy_additional_secure_links_purpose_reference_idx" ON "proxy_additional_secure_links" USING btree ("purpose","reference_id");
