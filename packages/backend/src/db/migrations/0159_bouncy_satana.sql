CREATE TABLE "docker_registry_node_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"repository" text NOT NULL,
	"actions" text[] NOT NULL,
	"context_kind" varchar(32) NOT NULL,
	"context_id" uuid NOT NULL,
	"generation" bigint DEFAULT 1 NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docker_registry_node_bindings_context_unique" UNIQUE("node_id","role","context_kind","context_id","repository")
);
--> statement-breakpoint
ALTER TABLE "docker_registry_node_bindings" ADD CONSTRAINT "docker_registry_node_bindings_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "docker_registry_node_bindings_node_status_idx" ON "docker_registry_node_bindings" USING btree ("node_id","status");