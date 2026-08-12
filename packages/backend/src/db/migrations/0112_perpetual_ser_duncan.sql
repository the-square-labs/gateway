CREATE TABLE "proxy_additional_secure_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proxy_host_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"upstream_kind" "proxy_upstream_kind" NOT NULL,
	"forward_scheme" "forward_scheme" DEFAULT 'http' NOT NULL,
	"source_node_id" uuid NOT NULL,
	"docker_node_id" uuid NOT NULL,
	"docker_container_name" varchar(255),
	"docker_deployment_id" uuid,
	"docker_container_port" integer NOT NULL,
	"docker_host_port" integer NOT NULL,
	"target_network" varchar(255) DEFAULT '' NOT NULL,
	"target_container" varchar(255) NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" varchar(32) DEFAULT 'provisioning' NOT NULL,
	"last_error" text,
	"listener_port" integer,
	"connector_port" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "proxy_additional_secure_links_host_name_unique" UNIQUE("proxy_host_id","name")
);
--> statement-breakpoint
ALTER TABLE "proxy_additional_secure_links" ADD CONSTRAINT "proxy_additional_secure_links_proxy_host_id_proxy_hosts_id_fk" FOREIGN KEY ("proxy_host_id") REFERENCES "public"."proxy_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_additional_secure_links" ADD CONSTRAINT "proxy_additional_secure_links_source_node_id_nodes_id_fk" FOREIGN KEY ("source_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_additional_secure_links" ADD CONSTRAINT "proxy_additional_secure_links_docker_node_id_nodes_id_fk" FOREIGN KEY ("docker_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proxy_additional_secure_links" ADD CONSTRAINT "proxy_additional_secure_links_docker_deployment_id_docker_deployments_id_fk" FOREIGN KEY ("docker_deployment_id") REFERENCES "public"."docker_deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "proxy_additional_secure_links_host_idx" ON "proxy_additional_secure_links" USING btree ("proxy_host_id");--> statement-breakpoint
CREATE INDEX "proxy_additional_secure_links_source_node_idx" ON "proxy_additional_secure_links" USING btree ("source_node_id");--> statement-breakpoint
CREATE INDEX "proxy_additional_secure_links_target_node_idx" ON "proxy_additional_secure_links" USING btree ("docker_node_id");--> statement-breakpoint
CREATE INDEX "proxy_additional_secure_links_status_idx" ON "proxy_additional_secure_links" USING btree ("status");