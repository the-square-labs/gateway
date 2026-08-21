CREATE TYPE "public"."relay_assignment_generation_state" AS ENUM('staging', 'active', 'draining', 'retired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."relay_assignment_role" AS ENUM('primary', 'fallback');--> statement-breakpoint
CREATE TYPE "public"."relay_instance_kind" AS ENUM('local', 'remote');--> statement-breakpoint
CREATE TYPE "public"."relay_instance_state" AS ENUM('joining', 'synchronizing', 'ready', 'draining', 'offline', 'error');--> statement-breakpoint
CREATE TYPE "public"."relay_pool_update_state" AS ENUM('preflight', 'draining', 'updating', 'verifying', 'paused', 'rolling_back', 'complete', 'failed');--> statement-breakpoint
CREATE TYPE "public"."relay_pool_update_step_state" AS ENUM('pending', 'draining', 'updating', 'verifying', 'ready', 'rolling_back', 'rolled_back', 'failed');--> statement-breakpoint
CREATE TYPE "public"."relay_probe_state" AS ENUM('pending', 'ready', 'failed');--> statement-breakpoint
ALTER TYPE "public"."node_type" ADD VALUE 'relay';--> statement-breakpoint
CREATE TABLE "relay_assignment_source_probes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_generation_id" uuid NOT NULL,
	"relay_instance_id" uuid NOT NULL,
	"source_kind" varchar(32) NOT NULL,
	"source_id" uuid NOT NULL,
	"certificate_fingerprint" varchar(71) NOT NULL,
	"state" "relay_probe_state" DEFAULT 'pending' NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_source_probes_generation_source_instance_unique" UNIQUE("assignment_generation_id","source_kind","source_id","relay_instance_id")
);
--> statement-breakpoint
CREATE TABLE "relay_endpoint_assignment_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"generation" bigint NOT NULL,
	"state" "relay_assignment_generation_state" DEFAULT 'staging' NOT NULL,
	"desired_redundancy" integer DEFAULT 1 NOT NULL,
	"activation_error" text,
	"activated_at" timestamp with time zone,
	"drain_started_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_assignment_generations_endpoint_generation_unique" UNIQUE("endpoint_id","generation")
);
--> statement-breakpoint
CREATE TABLE "relay_endpoint_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assignment_generation_id" uuid NOT NULL,
	"relay_instance_id" uuid NOT NULL,
	"role" "relay_assignment_role" NOT NULL,
	"target_registration_state" "relay_probe_state" DEFAULT 'pending' NOT NULL,
	"target_registered_at" timestamp with time zone,
	"target_registration_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_endpoint_assignments_generation_instance_unique" UNIQUE("assignment_generation_id","relay_instance_id"),
	CONSTRAINT "relay_endpoint_assignments_generation_role_unique" UNIQUE("assignment_generation_id","role")
);
--> statement-breakpoint
CREATE TABLE "relay_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" varchar(32) NOT NULL,
	"kind" "relay_instance_kind" NOT NULL,
	"node_id" uuid,
	"fault_domain_id" uuid NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"advertised_addresses" text[] DEFAULT '{}' NOT NULL,
	"service_port" integer DEFAULT 9443 NOT NULL,
	"state" "relay_instance_state" DEFAULT 'joining' NOT NULL,
	"certificate_identity" varchar(255),
	"certificate_fingerprint" varchar(71),
	"certificate_expires_at" timestamp with time zone,
	"policy_signing_key_id" varchar(64),
	"policy_public_key_fingerprint" varchar(71),
	"build_version" varchar(64),
	"protocol_major" integer,
	"capabilities" jsonb,
	"applied_policy_revision" bigint DEFAULT 0 NOT NULL,
	"policy_expires_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"health" jsonb,
	"desired_artifact" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_instances_pool_fault_domain_unique" UNIQUE("pool_id","fault_domain_id"),
	CONSTRAINT "relay_instances_node_unique" UNIQUE("node_id")
);
--> statement-breakpoint
CREATE TABLE "relay_policy_signing_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_id" varchar(64) NOT NULL,
	"public_key" text NOT NULL,
	"public_key_fingerprint" varchar(71) NOT NULL,
	"encrypted_private_key" text,
	"encrypted_dek" text,
	"status" "relay_signing_key_status" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"activated_at" timestamp with time zone,
	"verify_until" timestamp with time zone,
	"private_key_destroyed_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	CONSTRAINT "relay_policy_signing_keys_key_id_unique" UNIQUE("key_id")
);
--> statement-breakpoint
CREATE TABLE "relay_pool_update_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pool_id" varchar(32) NOT NULL,
	"state" "relay_pool_update_state" DEFAULT 'preflight' NOT NULL,
	"target_artifact" jsonb NOT NULL,
	"compatibility" jsonb,
	"force_disconnect_approved" boolean DEFAULT false NOT NULL,
	"terminal_error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relay_pool_update_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"relay_instance_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"state" "relay_pool_update_step_state" DEFAULT 'pending' NOT NULL,
	"previous_artifact" jsonb,
	"target_artifact" jsonb NOT NULL,
	"drain_deadline_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relay_pool_update_steps_run_instance_unique" UNIQUE("run_id","relay_instance_id"),
	CONSTRAINT "relay_pool_update_steps_run_sequence_unique" UNIQUE("run_id","sequence")
);
--> statement-breakpoint
CREATE TABLE "relay_pools" (
	"id" varchar(32) PRIMARY KEY NOT NULL,
	"gateway_host_identity_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"desired_policy_revision" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nodes" ADD COLUMN "host_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "relay_endpoints" ADD COLUMN "active_assignment_generation" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_assignment_source_probes" ADD CONSTRAINT "relay_assignment_source_probes_assignment_generation_id_relay_endpoint_assignment_generations_id_fk" FOREIGN KEY ("assignment_generation_id") REFERENCES "public"."relay_endpoint_assignment_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_assignment_source_probes" ADD CONSTRAINT "relay_assignment_source_probes_relay_instance_id_relay_instances_id_fk" FOREIGN KEY ("relay_instance_id") REFERENCES "public"."relay_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_endpoint_assignment_generations" ADD CONSTRAINT "relay_endpoint_assignment_generations_endpoint_id_relay_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."relay_endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_endpoint_assignments" ADD CONSTRAINT "relay_endpoint_assignments_assignment_generation_id_relay_endpoint_assignment_generations_id_fk" FOREIGN KEY ("assignment_generation_id") REFERENCES "public"."relay_endpoint_assignment_generations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_endpoint_assignments" ADD CONSTRAINT "relay_endpoint_assignments_relay_instance_id_relay_instances_id_fk" FOREIGN KEY ("relay_instance_id") REFERENCES "public"."relay_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_instances" ADD CONSTRAINT "relay_instances_pool_id_relay_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."relay_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_instances" ADD CONSTRAINT "relay_instances_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_pool_update_runs" ADD CONSTRAINT "relay_pool_update_runs_pool_id_relay_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."relay_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_pool_update_steps" ADD CONSTRAINT "relay_pool_update_steps_run_id_relay_pool_update_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."relay_pool_update_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relay_pool_update_steps" ADD CONSTRAINT "relay_pool_update_steps_relay_instance_id_relay_instances_id_fk" FOREIGN KEY ("relay_instance_id") REFERENCES "public"."relay_instances"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "relay_source_probes_generation_state_idx" ON "relay_assignment_source_probes" USING btree ("assignment_generation_id","state");--> statement-breakpoint
CREATE INDEX "relay_assignment_generations_endpoint_state_idx" ON "relay_endpoint_assignment_generations" USING btree ("endpoint_id","state");--> statement-breakpoint
CREATE INDEX "relay_endpoint_assignments_instance_idx" ON "relay_endpoint_assignments" USING btree ("relay_instance_id");--> statement-breakpoint
CREATE INDEX "relay_instances_pool_state_idx" ON "relay_instances" USING btree ("pool_id","state");--> statement-breakpoint
CREATE INDEX "relay_policy_signing_keys_status_idx" ON "relay_policy_signing_keys" USING btree ("status");--> statement-breakpoint
CREATE INDEX "relay_pool_update_runs_pool_state_idx" ON "relay_pool_update_runs" USING btree ("pool_id","state");--> statement-breakpoint
CREATE INDEX "node_host_identity_idx" ON "nodes" USING btree ("host_identity_id");
--> statement-breakpoint
INSERT INTO "relay_pools" ("id", "desired_policy_revision")
VALUES (
	'system',
	COALESCE((SELECT "revision" FROM "relay_policy_state" WHERE "id" = 'system' LIMIT 1), 0)
)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "relay_instances" (
	"id",
	"pool_id",
	"kind",
	"fault_domain_id",
	"display_name",
	"state",
	"applied_policy_revision"
)
SELECT
	'00000000-0000-4000-8000-000000000001',
	"id",
	'local',
	"gateway_host_identity_id",
	'Local relay',
	'ready',
	"desired_policy_revision"
FROM "relay_pools"
WHERE "id" = 'system'
ON CONFLICT ("pool_id", "fault_domain_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "relay_endpoint_assignment_generations" (
	"endpoint_id",
	"generation",
	"state",
	"desired_redundancy",
	"activated_at"
)
SELECT "id", 1, 'active', 1, now()
FROM "relay_endpoints"
ON CONFLICT ("endpoint_id", "generation") DO NOTHING;
--> statement-breakpoint
INSERT INTO "relay_endpoint_assignments" (
	"assignment_generation_id",
	"relay_instance_id",
	"role",
	"target_registration_state",
	"target_registered_at"
)
SELECT generation."id", instance."id", 'primary', 'ready', now()
FROM "relay_endpoint_assignment_generations" generation
JOIN "relay_instances" instance ON instance."pool_id" = 'system' AND instance."kind" = 'local'
WHERE generation."generation" = 1 AND generation."state" = 'active'
ON CONFLICT ("assignment_generation_id", "relay_instance_id") DO NOTHING;
