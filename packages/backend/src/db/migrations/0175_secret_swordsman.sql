CREATE TABLE "managed_database_binding_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"binding_id" uuid NOT NULL,
	"availability_placement_id" uuid,
	"node_id" uuid NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"network_name" varchar(128) NOT NULL,
	"connector_name" varchar(128) NOT NULL,
	"connector_alias" varchar(128) NOT NULL,
	"connector_address" varchar(45),
	"relay_endpoint_id" uuid,
	"desired_state" varchar(32) DEFAULT 'active' NOT NULL,
	"observed_state" varchar(32) DEFAULT 'legacy' NOT NULL,
	"status" "database_binding_status" DEFAULT 'creating' NOT NULL,
	"last_error" text,
	"last_observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_database_binding_placements_binding_node_unique" UNIQUE("binding_id","node_id"),
	CONSTRAINT "managed_database_binding_placements_availability_unique" UNIQUE("binding_id","availability_placement_id")
);
--> statement-breakpoint
ALTER TABLE "managed_database_binding_placements" ADD CONSTRAINT "managed_database_binding_placements_binding_id_managed_database_bindings_id_fk" FOREIGN KEY ("binding_id") REFERENCES "public"."managed_database_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_database_binding_placements" ADD CONSTRAINT "managed_database_binding_placements_availability_placement_id_docker_availability_placements_id_fk" FOREIGN KEY ("availability_placement_id") REFERENCES "public"."docker_availability_placements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_database_binding_placements" ADD CONSTRAINT "managed_database_binding_placements_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "managed_database_binding_placements_binding_idx" ON "managed_database_binding_placements" USING btree ("binding_id");--> statement-breakpoint
CREATE INDEX "managed_database_binding_placements_node_status_idx" ON "managed_database_binding_placements" USING btree ("node_id","status");--> statement-breakpoint
INSERT INTO "managed_database_binding_placements" (
	"binding_id",
	"node_id",
	"generation",
	"network_name",
	"connector_name",
	"connector_alias",
	"connector_address",
	"desired_state",
	"observed_state",
	"status",
	"last_error",
	"last_observed_at",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	"target_node_id",
	greatest("credential_generation", 1),
	"network_name",
	"connector_name",
	"connector_alias",
	"connector_address",
	"desired_state",
	"observed_state",
	"status",
	"last_error",
	"updated_at",
	"created_at",
	"updated_at"
FROM "managed_database_bindings"
ON CONFLICT DO NOTHING;--> statement-breakpoint
UPDATE "managed_database_binding_placements" placement
SET "availability_placement_id" = availability."id"
FROM "managed_database_bindings" binding
INNER JOIN "docker_availability_policies" policy ON (
	(policy."resource_kind" = 'deployment'
		AND binding."target_type"::text = 'deployment'
		AND binding."target_resource_id" = policy."deployment_id"::text)
	OR (policy."resource_kind" = 'compose'
		AND binding."target_type"::text = 'compose_service'
		AND split_part(binding."target_resource_id", ':', 1) = policy."compose_project_id"::text)
)
INNER JOIN "docker_availability_placements" availability
	ON availability."policy_id" = policy."id"
	AND availability."node_id" = binding."target_node_id"
WHERE placement."binding_id" = binding."id"
	AND placement."node_id" = binding."target_node_id"
	AND placement."availability_placement_id" IS NULL;
