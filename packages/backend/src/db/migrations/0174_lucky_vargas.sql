CREATE TABLE "docker_availability_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"type" varchar(32) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"phase" varchar(32) DEFAULT 'queued' NOT NULL,
	"target_generation" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"requested_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"lease_owner" text,
	"lease_heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"retry_of_operation_id" uuid,
	"error_code" text,
	"error_message" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "docker_availability_operations_generation_check" CHECK ("docker_availability_operations"."target_generation" >= 1)
);
--> statement-breakpoint
CREATE TABLE "docker_availability_placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"desired_state" varchar(32) DEFAULT 'stopped' NOT NULL,
	"actual_state" varchar(32) DEFAULT 'pending' NOT NULL,
	"serving" boolean DEFAULT false NOT NULL,
	"spec_fingerprint" text NOT NULL,
	"image_reference" text,
	"compose_revision_id" uuid,
	"runtime_identity" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dependency_state" varchar(32) DEFAULT 'pending' NOT NULL,
	"application_health" varchar(32) DEFAULT 'unknown' NOT NULL,
	"last_observed_at" timestamp with time zone,
	"unavailable_since" timestamp with time zone,
	"operation_id" uuid,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docker_availability_placements_generation_check" CHECK ("docker_availability_placements"."generation" >= 1),
	CONSTRAINT "docker_availability_placements_serving_state_check" CHECK (NOT "docker_availability_placements"."serving" OR "docker_availability_placements"."actual_state" = 'serving')
);
--> statement-breakpoint
CREATE TABLE "docker_availability_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_kind" varchar(32) NOT NULL,
	"source_node_id" uuid,
	"container_name" text,
	"deployment_id" uuid,
	"compose_project_id" uuid,
	"mode" varchar(32) DEFAULT 'single' NOT NULL,
	"desired_replica_count" integer DEFAULT 1 NOT NULL,
	"node_selection_mode" varchar(32) DEFAULT 'all_compatible' NOT NULL,
	"selected_node_ids" text[] DEFAULT '{}' NOT NULL,
	"desired_generation" integer DEFAULT 1 NOT NULL,
	"rollout_policy" jsonb DEFAULT '{"maxUnavailable":0,"maxSurge":1,"drainSeconds":30}'::jsonb NOT NULL,
	"offline_replacement_grace_seconds" integer DEFAULT 15 NOT NULL,
	"status" varchar(32) DEFAULT 'single' NOT NULL,
	"last_error_code" text,
	"last_error_message" text,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docker_availability_policies_resource_shape_check" CHECK (("docker_availability_policies"."resource_kind" = 'container' AND "docker_availability_policies"."source_node_id" IS NOT NULL AND "docker_availability_policies"."container_name" IS NOT NULL AND "docker_availability_policies"."deployment_id" IS NULL AND "docker_availability_policies"."compose_project_id" IS NULL) OR ("docker_availability_policies"."resource_kind" = 'deployment' AND "docker_availability_policies"."source_node_id" IS NULL AND "docker_availability_policies"."container_name" IS NULL AND "docker_availability_policies"."deployment_id" IS NOT NULL AND "docker_availability_policies"."compose_project_id" IS NULL) OR ("docker_availability_policies"."resource_kind" = 'compose' AND "docker_availability_policies"."source_node_id" IS NULL AND "docker_availability_policies"."container_name" IS NULL AND "docker_availability_policies"."deployment_id" IS NULL AND "docker_availability_policies"."compose_project_id" IS NOT NULL)),
	CONSTRAINT "docker_availability_policies_replica_count_check" CHECK (("docker_availability_policies"."mode" = 'replicated' AND "docker_availability_policies"."desired_replica_count" BETWEEN 2 AND 32) OR ("docker_availability_policies"."mode" IN ('single', 'failover') AND "docker_availability_policies"."desired_replica_count" = 1)),
	CONSTRAINT "docker_availability_policies_selected_nodes_check" CHECK (("docker_availability_policies"."node_selection_mode" = 'all_compatible') OR ("docker_availability_policies"."node_selection_mode" = 'selected' AND cardinality("docker_availability_policies"."selected_node_ids") > 0)),
	CONSTRAINT "docker_availability_policies_generation_check" CHECK ("docker_availability_policies"."desired_generation" >= 1 AND "docker_availability_policies"."offline_replacement_grace_seconds" BETWEEN 0 AND 3600)
);
--> statement-breakpoint
ALTER TABLE "docker_availability_operations" ADD CONSTRAINT "docker_availability_operations_policy_id_docker_availability_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."docker_availability_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_availability_operations" ADD CONSTRAINT "docker_availability_operations_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_availability_placements" ADD CONSTRAINT "docker_availability_placements_policy_id_docker_availability_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."docker_availability_policies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_availability_placements" ADD CONSTRAINT "docker_availability_placements_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_availability_placements" ADD CONSTRAINT "docker_availability_placements_compose_revision_id_docker_compose_revisions_id_fk" FOREIGN KEY ("compose_revision_id") REFERENCES "public"."docker_compose_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD CONSTRAINT "docker_availability_policies_source_node_id_nodes_id_fk" FOREIGN KEY ("source_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD CONSTRAINT "docker_availability_policies_deployment_id_docker_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."docker_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD CONSTRAINT "docker_availability_policies_compose_project_id_docker_compose_projects_id_fk" FOREIGN KEY ("compose_project_id") REFERENCES "public"."docker_compose_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD CONSTRAINT "docker_availability_policies_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD CONSTRAINT "docker_availability_policies_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "docker_availability_operations_idempotency_unique" ON "docker_availability_operations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "docker_availability_operations_policy_created_idx" ON "docker_availability_operations" USING btree ("policy_id","created_at");--> statement-breakpoint
CREATE INDEX "docker_availability_operations_status_lease_idx" ON "docker_availability_operations" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "docker_availability_placements_policy_node_unique" ON "docker_availability_placements" USING btree ("policy_id","node_id");--> statement-breakpoint
CREATE INDEX "docker_availability_placements_policy_state_idx" ON "docker_availability_placements" USING btree ("policy_id","actual_state");--> statement-breakpoint
CREATE INDEX "docker_availability_placements_node_state_idx" ON "docker_availability_placements" USING btree ("node_id","actual_state");--> statement-breakpoint
CREATE UNIQUE INDEX "docker_availability_policies_container_unique" ON "docker_availability_policies" USING btree ("source_node_id","container_name") WHERE "docker_availability_policies"."resource_kind" = 'container';--> statement-breakpoint
CREATE UNIQUE INDEX "docker_availability_policies_deployment_unique" ON "docker_availability_policies" USING btree ("deployment_id") WHERE "docker_availability_policies"."resource_kind" = 'deployment';--> statement-breakpoint
CREATE UNIQUE INDEX "docker_availability_policies_compose_unique" ON "docker_availability_policies" USING btree ("compose_project_id") WHERE "docker_availability_policies"."resource_kind" = 'compose';--> statement-breakpoint
CREATE INDEX "docker_availability_policies_status_idx" ON "docker_availability_policies" USING btree ("status","updated_at");--> statement-breakpoint
INSERT INTO "docker_availability_policies" (
	"resource_kind",
	"deployment_id",
	"mode",
	"desired_replica_count",
	"node_selection_mode",
	"selected_node_ids",
	"desired_generation",
	"status",
	"created_by_id",
	"updated_by_id",
	"created_at",
	"updated_at"
)
SELECT
	'deployment',
	"id",
	'single',
	1,
	'selected',
	ARRAY["node_id"::text],
	1,
	'single',
	"created_by_id",
	"updated_by_id",
	"created_at",
	"updated_at"
FROM "docker_deployments"
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "docker_availability_placements" (
	"policy_id",
	"node_id",
	"generation",
	"desired_state",
	"actual_state",
	"serving",
	"spec_fingerprint",
	"image_reference",
	"dependency_state",
	"application_health",
	"last_observed_at",
	"created_at",
	"updated_at"
)
SELECT
	p."id",
	d."node_id",
	1,
	CASE WHEN d."status" = 'stopped' THEN 'stopped' ELSE 'serving' END,
	CASE
		WHEN d."status" = 'ready' THEN 'serving'
		WHEN d."status" = 'stopped' THEN 'stopped'
		WHEN d."status" IN ('failed', 'degraded') THEN 'failed'
		ELSE 'pending'
	END,
	d."status" = 'ready',
	md5(d."desired_config"::text || ':' || d."health_config"::text),
	d."desired_config" ->> 'image',
	CASE WHEN d."status" = 'ready' THEN 'ready' ELSE 'pending' END,
	CASE WHEN d."status" = 'ready' THEN 'healthy' WHEN d."status" IN ('failed', 'degraded') THEN 'unhealthy' ELSE 'unknown' END,
	d."updated_at",
	d."created_at",
	d."updated_at"
FROM "docker_availability_policies" p
INNER JOIN "docker_deployments" d ON d."id" = p."deployment_id"
WHERE p."resource_kind" = 'deployment'
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "docker_availability_policies" (
	"resource_kind",
	"compose_project_id",
	"mode",
	"desired_replica_count",
	"node_selection_mode",
	"selected_node_ids",
	"desired_generation",
	"status",
	"created_by_id",
	"updated_by_id",
	"created_at",
	"updated_at"
)
SELECT
	'compose',
	"id",
	'single',
	1,
	'selected',
	ARRAY["node_id"::text],
	1,
	'single',
	"created_by_id",
	"updated_by_id",
	"created_at",
	"updated_at"
FROM "docker_compose_projects"
WHERE "management_state" = 'managed'
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "docker_availability_placements" (
	"policy_id",
	"node_id",
	"generation",
	"desired_state",
	"actual_state",
	"serving",
	"spec_fingerprint",
	"compose_revision_id",
	"dependency_state",
	"application_health",
	"last_observed_at",
	"created_at",
	"updated_at"
)
SELECT
	p."id",
	c."node_id",
	1,
	CASE WHEN c."desired_state" = 'stopped' THEN 'stopped' ELSE 'serving' END,
	CASE
		WHEN c."status" = 'running' THEN 'serving'
		WHEN c."status" = 'stopped' THEN 'stopped'
		WHEN c."status" IN ('failed', 'degraded', 'missing') THEN 'failed'
		ELSE 'pending'
	END,
	c."status" = 'running',
	coalesce(r."config_digest", md5(c."id"::text || ':' || c."updated_at"::text)),
	c."active_revision_id",
	CASE WHEN c."status" = 'running' THEN 'ready' ELSE 'pending' END,
	CASE WHEN c."status" = 'running' THEN 'healthy' WHEN c."status" IN ('failed', 'degraded', 'missing') THEN 'unhealthy' ELSE 'unknown' END,
	c."last_seen_at",
	c."created_at",
	c."updated_at"
FROM "docker_availability_policies" p
INNER JOIN "docker_compose_projects" c ON c."id" = p."compose_project_id"
LEFT JOIN "docker_compose_revisions" r ON r."id" = c."active_revision_id"
WHERE p."resource_kind" = 'compose'
ON CONFLICT DO NOTHING;
