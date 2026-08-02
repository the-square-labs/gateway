CREATE TYPE "public"."database_binding_status" AS ENUM('creating', 'ready', 'error', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."database_binding_target_type" AS ENUM('container', 'deployment');--> statement-breakpoint
CREATE TYPE "public"."managed_database_status" AS ENUM('creating', 'ready', 'stopped', 'error', 'deleting');--> statement-breakpoint
ALTER TYPE "public"."node_type" ADD VALUE 'databases';--> statement-breakpoint
CREATE TABLE "managed_database_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"managed_database_id" uuid NOT NULL,
	"target_node_id" uuid NOT NULL,
	"target_type" "database_binding_target_type" NOT NULL,
	"target_resource_id" varchar(255) NOT NULL,
	"network_name" varchar(128) NOT NULL,
	"connector_name" varchar(128) NOT NULL,
	"connector_alias" varchar(128) NOT NULL,
	"environment" jsonb NOT NULL,
	"encrypted_credentials" text NOT NULL,
	"status" "database_binding_status" DEFAULT 'creating' NOT NULL,
	"last_error" text,
	"created_by_id" uuid NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_database_bindings_target_unique" UNIQUE("managed_database_id","target_node_id","target_type","target_resource_id")
);
--> statement-breakpoint
CREATE TABLE "managed_database_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(60) NOT NULL,
	"type" "database_type" NOT NULL,
	"version" varchar(128) NOT NULL,
	"image_ref" varchar(512) NOT NULL,
	"engine_config" jsonb NOT NULL,
	"encrypted_owner_credentials" text NOT NULL,
	"storage_size_bytes" bigint NOT NULL,
	"runtime_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_port" integer,
	"status" "managed_database_status" DEFAULT 'creating' NOT NULL,
	"last_error" text,
	"created_by_id" uuid NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_database_instances_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "managed_database_bindings" ADD CONSTRAINT "managed_database_bindings_managed_database_id_managed_database_instances_id_fk" FOREIGN KEY ("managed_database_id") REFERENCES "public"."managed_database_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_database_bindings" ADD CONSTRAINT "managed_database_bindings_target_node_id_nodes_id_fk" FOREIGN KEY ("target_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_database_bindings" ADD CONSTRAINT "managed_database_bindings_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_database_bindings" ADD CONSTRAINT "managed_database_bindings_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD CONSTRAINT "managed_database_instances_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD CONSTRAINT "managed_database_instances_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_database_instances" ADD CONSTRAINT "managed_database_instances_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_database_bindings_database_idx" ON "managed_database_bindings" USING btree ("managed_database_id");--> statement-breakpoint
CREATE INDEX "managed_database_bindings_target_node_idx" ON "managed_database_bindings" USING btree ("target_node_id");--> statement-breakpoint
CREATE INDEX "managed_database_instances_node_idx" ON "managed_database_instances" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "managed_database_instances_status_idx" ON "managed_database_instances" USING btree ("status");