CREATE TABLE "docker_access_resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"resource_type" varchar(32) DEFAULT 'container' NOT NULL,
	"resource_key" varchar(255) NOT NULL,
	"runtime_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "docker_access_resources" ADD CONSTRAINT "docker_access_resources_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "docker_access_resources_node_type_key_unique" ON "docker_access_resources" USING btree ("node_id","resource_type","resource_key");--> statement-breakpoint
CREATE INDEX "docker_access_resources_node_runtime_idx" ON "docker_access_resources" USING btree ("node_id","runtime_id");