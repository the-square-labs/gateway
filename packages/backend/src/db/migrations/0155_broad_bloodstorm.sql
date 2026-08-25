CREATE TABLE "docker_artifact_pins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"artifact_id" uuid NOT NULL,
	"kind" varchar(32) NOT NULL,
	"owner_key" text NOT NULL,
	"reason" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "docker_build_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"build_id" uuid NOT NULL,
	"source_binding_id" uuid NOT NULL,
	"registry_repository" text NOT NULL,
	"digest" varchar(128) NOT NULL,
	"platform" varchar(64) NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"sbom_digest" varchar(128),
	"provenance_digest" varchar(128),
	"scan_summary" jsonb,
	"policy_decision" varchar(32) DEFAULT 'pending' NOT NULL,
	"policy_reason" text,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docker_build_artifacts_digest_check" CHECK ("docker_build_artifacts"."digest" ~ '^sha256:[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "docker_build_log_chunks" (
	"build_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"content" text NOT NULL,
	"byte_length" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docker_build_log_chunks_pkey" PRIMARY KEY("build_id","sequence"),
	CONSTRAINT "docker_build_log_chunks_sequence_check" CHECK ("docker_build_log_chunks"."sequence" >= 0),
	CONSTRAINT "docker_build_log_chunks_size_check" CHECK ("docker_build_log_chunks"."byte_length" BETWEEN 0 AND 262144)
);
--> statement-breakpoint
CREATE TABLE "docker_builds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_binding_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"trigger" varchar(32) NOT NULL,
	"trigger_delivery_id" text,
	"repository_remote_id" text NOT NULL,
	"repository_full_path" text NOT NULL,
	"ref" text NOT NULL,
	"commit_sha" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'queued' NOT NULL,
	"builder_node_id" uuid,
	"platform" varchar(64),
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"lease_owner" text,
	"lease_heartbeat_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"cancellation_requested_at" timestamp with time zone,
	"cancellation_requested_by_id" uuid,
	"superseded_by_build_id" uuid,
	"error_code" text,
	"error_message" text,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "docker_builds_attempt_range_check" CHECK ("docker_builds"."attempt" >= 0 AND "docker_builds"."max_attempts" BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE TABLE "docker_internal_registry_state" (
	"id" text PRIMARY KEY DEFAULT 'system' NOT NULL,
	"status" varchar(32) DEFAULT 'starting' NOT NULL,
	"writable" boolean DEFAULT false NOT NULL,
	"storage_backend" varchar(32) DEFAULT 'filesystem' NOT NULL,
	"storage_used_bytes" bigint DEFAULT 0 NOT NULL,
	"storage_capacity_bytes" bigint,
	"external_access_enabled" boolean DEFAULT false NOT NULL,
	"external_hostname" text,
	"external_nginx_node_id" uuid,
	"external_certificate_id" uuid,
	"maintenance_phase" varchar(32) DEFAULT 'idle' NOT NULL,
	"maintenance_lease_owner" text,
	"maintenance_lease_expires_at" timestamp with time zone,
	"last_gc_at" timestamp with time zone,
	"next_gc_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docker_registry_maintenance_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phase" varchar(32) NOT NULL,
	"status" varchar(32) DEFAULT 'running' NOT NULL,
	"dry_run" boolean DEFAULT false NOT NULL,
	"lease_owner" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "docker_source_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_kind" varchar(32) NOT NULL,
	"node_id" uuid,
	"container_name" text,
	"deployment_id" uuid,
	"connector_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"repository_remote_id" text NOT NULL,
	"repository_full_path" text NOT NULL,
	"repository_clone_url" text NOT NULL,
	"branch" text NOT NULL,
	"dockerfile_path" text DEFAULT 'Dockerfile' NOT NULL,
	"context_path" text DEFAULT '.' NOT NULL,
	"auto_deploy" boolean DEFAULT true NOT NULL,
	"build_args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"build_secret_names" text[] DEFAULT '{}' NOT NULL,
	"policy" jsonb DEFAULT '{"requireSbom":true,"requireProvenance":true}'::jsonb NOT NULL,
	"desired_commit_sha" varchar(64),
	"deployed_commit_sha" varchar(64),
	"last_resolved_at" timestamp with time zone,
	"last_webhook_at" timestamp with time zone,
	"last_webhook_error" text,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docker_source_bindings_target_shape_check" CHECK (("docker_source_bindings"."target_kind" = 'container' AND "docker_source_bindings"."node_id" IS NOT NULL AND "docker_source_bindings"."container_name" IS NOT NULL AND "docker_source_bindings"."deployment_id" IS NULL) OR ("docker_source_bindings"."target_kind" = 'deployment' AND "docker_source_bindings"."node_id" IS NULL AND "docker_source_bindings"."container_name" IS NULL AND "docker_source_bindings"."deployment_id" IS NOT NULL)),
	CONSTRAINT "docker_source_bindings_branch_not_blank_check" CHECK (length(trim("docker_source_bindings"."branch")) > 0),
	CONSTRAINT "docker_source_bindings_dockerfile_not_absolute_check" CHECK ("docker_source_bindings"."dockerfile_path" !~ '^/'),
	CONSTRAINT "docker_source_bindings_context_not_absolute_check" CHECK ("docker_source_bindings"."context_path" !~ '^/')
);
--> statement-breakpoint
ALTER TABLE "docker_artifact_pins" ADD CONSTRAINT "docker_artifact_pins_artifact_id_docker_build_artifacts_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "public"."docker_build_artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_artifact_pins" ADD CONSTRAINT "docker_artifact_pins_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_build_artifacts" ADD CONSTRAINT "docker_build_artifacts_build_id_docker_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."docker_builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_build_artifacts" ADD CONSTRAINT "docker_build_artifacts_source_binding_id_docker_source_bindings_id_fk" FOREIGN KEY ("source_binding_id") REFERENCES "public"."docker_source_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_build_log_chunks" ADD CONSTRAINT "docker_build_log_chunks_build_id_docker_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."docker_builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_builds" ADD CONSTRAINT "docker_builds_source_binding_id_docker_source_bindings_id_fk" FOREIGN KEY ("source_binding_id") REFERENCES "public"."docker_source_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_builds" ADD CONSTRAINT "docker_builds_builder_node_id_nodes_id_fk" FOREIGN KEY ("builder_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_builds" ADD CONSTRAINT "docker_builds_cancellation_requested_by_id_users_id_fk" FOREIGN KEY ("cancellation_requested_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_builds" ADD CONSTRAINT "docker_builds_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_internal_registry_state" ADD CONSTRAINT "docker_internal_registry_state_external_nginx_node_id_nodes_id_fk" FOREIGN KEY ("external_nginx_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_internal_registry_state" ADD CONSTRAINT "docker_internal_registry_state_external_certificate_id_ssl_certificates_id_fk" FOREIGN KEY ("external_certificate_id") REFERENCES "public"."ssl_certificates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD CONSTRAINT "docker_source_bindings_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD CONSTRAINT "docker_source_bindings_deployment_id_docker_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."docker_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD CONSTRAINT "docker_source_bindings_connector_id_integration_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."integration_connectors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD CONSTRAINT "docker_source_bindings_project_id_integration_connector_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."integration_connector_projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD CONSTRAINT "docker_source_bindings_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD CONSTRAINT "docker_source_bindings_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "docker_artifact_pins_artifact_kind_owner_unique" ON "docker_artifact_pins" USING btree ("artifact_id","kind","owner_key");--> statement-breakpoint
CREATE INDEX "docker_artifact_pins_owner_idx" ON "docker_artifact_pins" USING btree ("owner_key","kind");--> statement-breakpoint
CREATE INDEX "docker_artifact_pins_expiry_idx" ON "docker_artifact_pins" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "docker_build_artifacts_build_unique" ON "docker_build_artifacts" USING btree ("build_id");--> statement-breakpoint
CREATE UNIQUE INDEX "docker_build_artifacts_repository_digest_platform_unique" ON "docker_build_artifacts" USING btree ("registry_repository","digest","platform");--> statement-breakpoint
CREATE INDEX "docker_build_artifacts_binding_created_idx" ON "docker_build_artifacts" USING btree ("source_binding_id","created_at");--> statement-breakpoint
CREATE INDEX "docker_build_artifacts_status_idx" ON "docker_build_artifacts" USING btree ("status","policy_decision");--> statement-breakpoint
CREATE UNIQUE INDEX "docker_builds_dedupe_key_unique" ON "docker_builds" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "docker_builds_binding_created_idx" ON "docker_builds" USING btree ("source_binding_id","created_at");--> statement-breakpoint
CREATE INDEX "docker_builds_status_lease_idx" ON "docker_builds" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "docker_builds_builder_status_idx" ON "docker_builds" USING btree ("builder_node_id","status");--> statement-breakpoint
CREATE INDEX "docker_builds_commit_idx" ON "docker_builds" USING btree ("source_binding_id","commit_sha");--> statement-breakpoint
CREATE INDEX "docker_registry_maintenance_status_idx" ON "docker_registry_maintenance_runs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "docker_registry_maintenance_created_idx" ON "docker_registry_maintenance_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "docker_source_bindings_container_unique" ON "docker_source_bindings" USING btree ("node_id","container_name") WHERE "docker_source_bindings"."target_kind" = 'container';--> statement-breakpoint
CREATE UNIQUE INDEX "docker_source_bindings_deployment_unique" ON "docker_source_bindings" USING btree ("deployment_id") WHERE "docker_source_bindings"."target_kind" = 'deployment';--> statement-breakpoint
CREATE INDEX "docker_source_bindings_connector_project_idx" ON "docker_source_bindings" USING btree ("connector_id","project_id");--> statement-breakpoint
CREATE INDEX "docker_source_bindings_desired_commit_idx" ON "docker_source_bindings" USING btree ("desired_commit_sha");