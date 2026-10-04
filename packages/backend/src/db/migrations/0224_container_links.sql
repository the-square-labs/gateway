-- Container links (container_links, container_link_placements): one relay route per source node, like storage links.
-- relay_routes.secure_link_egress carries the shared connector egress of a link route (storage, database and
-- container links); managed database links record how their workloads reach the database (link_transport). Adding
-- the columns moves no route generation.
CREATE TABLE "container_link_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"link_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"availability_placement_id" uuid,
	"node_id" uuid NOT NULL,
	"target_container" varchar(255),
	"target_network" varchar(128),
	"target_dial_port" integer,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" varchar(32) DEFAULT 'creating' NOT NULL,
	"last_error" text,
	"last_observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "container_link_placements_placement_unique" UNIQUE("link_id","role","availability_placement_id")
);
--> statement-breakpoint
CREATE TABLE "container_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_node_id" uuid NOT NULL,
	"source_type" varchar(32) NOT NULL,
	"source_resource_id" varchar(255) NOT NULL,
	"target_node_id" uuid NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_resource_id" varchar(255) NOT NULL,
	"target_port" integer NOT NULL,
	"alias" varchar(63) NOT NULL,
	"environment" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"network_name" varchar(128) NOT NULL,
	"target_container" varchar(255),
	"target_network" varchar(128),
	"target_dial_port" integer,
	"generation" integer DEFAULT 1 NOT NULL,
	"desired_state" varchar(32) DEFAULT 'active' NOT NULL,
	"status" varchar(32) DEFAULT 'creating' NOT NULL,
	"last_error" text,
	"created_by_id" uuid NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "container_links_source_alias_unique" UNIQUE("source_node_id","source_type","source_resource_id","alias")
);
--> statement-breakpoint
DROP INDEX "relay_routes_owner_unique";--> statement-breakpoint
ALTER TABLE "managed_database_binding_placements" ADD COLUMN "link_transport" varchar(16) DEFAULT 'listener' NOT NULL;--> statement-breakpoint
ALTER TABLE "managed_database_bindings" ADD COLUMN "link_transport" varchar(16) DEFAULT 'listener' NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_routes" ADD COLUMN "secure_link_egress" jsonb;--> statement-breakpoint
ALTER TABLE "container_link_placements" ADD CONSTRAINT "container_link_placements_link_id_container_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."container_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_link_placements" ADD CONSTRAINT "container_link_placements_availability_placement_id_docker_availability_placements_id_fk" FOREIGN KEY ("availability_placement_id") REFERENCES "public"."docker_availability_placements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_link_placements" ADD CONSTRAINT "container_link_placements_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_links" ADD CONSTRAINT "container_links_source_node_id_nodes_id_fk" FOREIGN KEY ("source_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_links" ADD CONSTRAINT "container_links_target_node_id_nodes_id_fk" FOREIGN KEY ("target_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_links" ADD CONSTRAINT "container_links_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "container_links" ADD CONSTRAINT "container_links_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "container_link_placements_link_idx" ON "container_link_placements" USING btree ("link_id");--> statement-breakpoint
CREATE INDEX "container_link_placements_node_idx" ON "container_link_placements" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "container_links_source_idx" ON "container_links" USING btree ("source_node_id","source_type","source_resource_id");--> statement-breakpoint
CREATE INDEX "container_links_target_idx" ON "container_links" USING btree ("target_node_id","target_type","target_resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "relay_routes_container_link_source_unique" ON "relay_routes" USING btree ("owner_kind","owner_id","source_kind","source_id") WHERE "relay_routes"."owner_kind" = 'container_link';--> statement-breakpoint
CREATE UNIQUE INDEX "relay_routes_owner_unique" ON "relay_routes" USING btree ("owner_kind","owner_id") WHERE "relay_routes"."owner_kind" not in ('proxy_host_secure_link', 'managed_storage_binding', 'container_link');