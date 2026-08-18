CREATE TYPE "public"."page_deployment_status" AS ENUM('uploading', 'validating', 'stored', 'staging', 'ready', 'failed', 'cleaning', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."page_ingress_migration_status" AS ENUM('preflight', 'staging', 'applying', 'switching_dns', 'verifying', 'cleanup_pending', 'complete', 'failed', 'needs_attention');--> statement-breakpoint
CREATE TYPE "public"."page_ingress_migration_subject" AS ENUM('wildcard_profile', 'route');--> statement-breakpoint
CREATE TYPE "public"."page_profile_status" AS ENUM('disabled', 'pending', 'ready', 'degraded', 'capability_missing', 'migration_pending');--> statement-breakpoint
CREATE TYPE "public"."page_replica_purpose" AS ENUM('preview', 'route', 'migration');--> statement-breakpoint
CREATE TYPE "public"."page_replica_status" AS ENUM('pending', 'uploading', 'materializing', 'ready', 'failed', 'capability_missing', 'cleanup_pending');--> statement-breakpoint
CREATE TYPE "public"."page_route_target_status" AS ENUM('pending', 'staging', 'ready', 'failed', 'capability_missing');--> statement-breakpoint
CREATE TYPE "public"."page_tag_activation_status" AS ENUM('requested', 'staging_consumers', 'switching', 'ready', 'rolling_back', 'failed');--> statement-breakpoint
CREATE TYPE "public"."page_upload_status" AS ENUM('open', 'finalizing', 'complete', 'failed', 'expired');--> statement-breakpoint
ALTER TYPE "public"."proxy_upstream_kind" ADD VALUE 'pages';--> statement-breakpoint
CREATE TABLE "page_deploy_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"token_prefix" varchar(32) NOT NULL,
	"token_hash" text NOT NULL,
	"allowed_tag_patterns" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allow_user_tag" boolean DEFAULT false NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "page_deployment_replicas" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"purpose" "page_replica_purpose" NOT NULL,
	"reference_id" varchar(255) NOT NULL,
	"status" "page_replica_status" DEFAULT 'pending' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"applied_sha256" varchar(64),
	"last_error_code" varchar(128),
	"last_verified_at" timestamp with time zone,
	"cleanup_after" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"public_slug" varchar(16) NOT NULL,
	"preview_hostname" varchar(253),
	"status" "page_deployment_status" DEFAULT 'uploading' NOT NULL,
	"artifact_key" text,
	"artifact_sha256" varchar(64),
	"compressed_size_bytes" bigint DEFAULT 0 NOT NULL,
	"expanded_size_bytes" bigint DEFAULT 0 NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"source_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" varchar(255),
	"pinned" boolean DEFAULT false NOT NULL,
	"failure_code" varchar(128),
	"failure_message" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "page_ingress_migrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject_type" "page_ingress_migration_subject" NOT NULL,
	"subject_id" varchar(255) NOT NULL,
	"project_id" uuid,
	"source_node_id" uuid,
	"target_node_id" uuid NOT NULL,
	"status" "page_ingress_migration_status" DEFAULT 'preflight' NOT NULL,
	"retained_deployment_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" varchar(128),
	"error_message" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "page_project_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(60) NOT NULL,
	"description" text,
	"folder_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"max_deployments" integer DEFAULT 20 NOT NULL,
	"storage_quota_bytes" bigint DEFAULT 5368709120 NOT NULL,
	"storage_used_bytes" bigint DEFAULT 0 NOT NULL,
	"next_deployment_sequence" integer DEFAULT 1 NOT NULL,
	"created_by_id" uuid NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_route_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"proxy_host_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"active_deployment_id" uuid,
	"status" "page_route_target_status" DEFAULT 'pending' NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"last_error_code" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_tag_activations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tag_id" uuid NOT NULL,
	"from_deployment_id" uuid,
	"to_deployment_id" uuid NOT NULL,
	"status" "page_tag_activation_status" DEFAULT 'requested' NOT NULL,
	"expected_generation" integer NOT NULL,
	"progress" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"failure_code" varchar(128),
	"failure_message" text,
	"requested_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "page_tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" varchar(63) NOT NULL,
	"deployment_id" uuid,
	"system" boolean DEFAULT false NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_upload_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"status" "page_upload_status" DEFAULT 'open' NOT NULL,
	"declared_size_bytes" bigint NOT NULL,
	"declared_sha256" varchar(64) NOT NULL,
	"received_bytes" bigint DEFAULT 0 NOT NULL,
	"temp_key" text NOT NULL,
	"failure_code" varchar(128),
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_wildcard_profiles" (
	"id" varchar(32) PRIMARY KEY DEFAULT 'default' NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"domain_id" uuid,
	"node_id" uuid,
	"certificate_id" uuid,
	"label_template" varchar(255) DEFAULT '{hash}' NOT NULL,
	"status" "page_profile_status" DEFAULT 'disabled' NOT NULL,
	"override_same_registrable_domain" boolean DEFAULT false NOT NULL,
	"override_compared_hosts" jsonb,
	"override_acknowledged_by_id" uuid,
	"override_acknowledged_at" timestamp with time zone,
	"last_error_code" varchar(128),
	"last_error_message" text,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_deploy_tokens" ADD CONSTRAINT "page_deploy_tokens_project_id_page_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."page_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_deploy_tokens" ADD CONSTRAINT "page_deploy_tokens_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_deploy_tokens" ADD CONSTRAINT "page_deploy_tokens_revoked_by_id_users_id_fk" FOREIGN KEY ("revoked_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_deployment_replicas" ADD CONSTRAINT "page_deployment_replicas_deployment_id_page_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."page_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_deployment_replicas" ADD CONSTRAINT "page_deployment_replicas_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_deployments" ADD CONSTRAINT "page_deployments_project_id_page_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."page_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_deployments" ADD CONSTRAINT "page_deployments_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_ingress_migrations" ADD CONSTRAINT "page_ingress_migrations_project_id_page_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."page_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_ingress_migrations" ADD CONSTRAINT "page_ingress_migrations_source_node_id_nodes_id_fk" FOREIGN KEY ("source_node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_ingress_migrations" ADD CONSTRAINT "page_ingress_migrations_target_node_id_nodes_id_fk" FOREIGN KEY ("target_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_ingress_migrations" ADD CONSTRAINT "page_ingress_migrations_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_project_folders" ADD CONSTRAINT "page_project_folders_parent_id_page_project_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."page_project_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_project_folders" ADD CONSTRAINT "page_project_folders_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_projects" ADD CONSTRAINT "page_projects_folder_id_page_project_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."page_project_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_projects" ADD CONSTRAINT "page_projects_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_projects" ADD CONSTRAINT "page_projects_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_route_targets" ADD CONSTRAINT "page_route_targets_proxy_host_id_proxy_hosts_id_fk" FOREIGN KEY ("proxy_host_id") REFERENCES "public"."proxy_hosts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_route_targets" ADD CONSTRAINT "page_route_targets_project_id_page_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."page_projects"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_route_targets" ADD CONSTRAINT "page_route_targets_tag_id_page_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."page_tags"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_route_targets" ADD CONSTRAINT "page_route_targets_active_deployment_id_page_deployments_id_fk" FOREIGN KEY ("active_deployment_id") REFERENCES "public"."page_deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_tag_activations" ADD CONSTRAINT "page_tag_activations_tag_id_page_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."page_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_tag_activations" ADD CONSTRAINT "page_tag_activations_from_deployment_id_page_deployments_id_fk" FOREIGN KEY ("from_deployment_id") REFERENCES "public"."page_deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_tag_activations" ADD CONSTRAINT "page_tag_activations_to_deployment_id_page_deployments_id_fk" FOREIGN KEY ("to_deployment_id") REFERENCES "public"."page_deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_tag_activations" ADD CONSTRAINT "page_tag_activations_requested_by_id_users_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_tags" ADD CONSTRAINT "page_tags_project_id_page_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."page_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_tags" ADD CONSTRAINT "page_tags_deployment_id_page_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."page_deployments"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_tags" ADD CONSTRAINT "page_tags_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_upload_sessions" ADD CONSTRAINT "page_upload_sessions_deployment_id_page_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."page_deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_wildcard_profiles" ADD CONSTRAINT "page_wildcard_profiles_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_wildcard_profiles" ADD CONSTRAINT "page_wildcard_profiles_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_wildcard_profiles" ADD CONSTRAINT "page_wildcard_profiles_certificate_id_ssl_certificates_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."ssl_certificates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_wildcard_profiles" ADD CONSTRAINT "page_wildcard_profiles_override_acknowledged_by_id_users_id_fk" FOREIGN KEY ("override_acknowledged_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_wildcard_profiles" ADD CONSTRAINT "page_wildcard_profiles_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_wildcard_profiles" ADD CONSTRAINT "page_wildcard_profiles_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "page_deploy_tokens_hash_unique" ON "page_deploy_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "page_deploy_tokens_project_idx" ON "page_deploy_tokens" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "page_deploy_tokens_prefix_idx" ON "page_deploy_tokens" USING btree ("token_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "page_deployment_replicas_reference_unique" ON "page_deployment_replicas" USING btree ("deployment_id","node_id","purpose","reference_id");--> statement-breakpoint
CREATE INDEX "page_deployment_replicas_node_status_idx" ON "page_deployment_replicas" USING btree ("node_id","status");--> statement-breakpoint
CREATE INDEX "page_deployment_replicas_cleanup_idx" ON "page_deployment_replicas" USING btree ("cleanup_after");--> statement-breakpoint
CREATE UNIQUE INDEX "page_deployments_public_slug_unique" ON "page_deployments" USING btree ("public_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "page_deployments_preview_hostname_unique" ON "page_deployments" USING btree ("preview_hostname");--> statement-breakpoint
CREATE UNIQUE INDEX "page_deployments_project_sequence_unique" ON "page_deployments" USING btree ("project_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "page_deployments_project_idempotency_unique" ON "page_deployments" USING btree ("project_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "page_deployments_project_status_idx" ON "page_deployments" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "page_deployments_project_created_idx" ON "page_deployments" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "page_ingress_migrations_subject_idx" ON "page_ingress_migrations" USING btree ("subject_type","subject_id");--> statement-breakpoint
CREATE INDEX "page_ingress_migrations_target_status_idx" ON "page_ingress_migrations" USING btree ("target_node_id","status");--> statement-breakpoint
CREATE INDEX "page_ingress_migrations_project_idx" ON "page_ingress_migrations" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "page_project_folders_parent_idx" ON "page_project_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "page_project_folders_sort_idx" ON "page_project_folders" USING btree ("parent_id","sort_order");--> statement-breakpoint
CREATE UNIQUE INDEX "page_projects_slug_unique" ON "page_projects" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "page_projects_folder_idx" ON "page_projects" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "page_projects_sort_idx" ON "page_projects" USING btree ("folder_id","sort_order");--> statement-breakpoint
CREATE INDEX "page_projects_created_by_idx" ON "page_projects" USING btree ("created_by_id");--> statement-breakpoint
CREATE UNIQUE INDEX "page_route_targets_proxy_host_unique" ON "page_route_targets" USING btree ("proxy_host_id");--> statement-breakpoint
CREATE INDEX "page_route_targets_project_tag_idx" ON "page_route_targets" USING btree ("project_id","tag_id");--> statement-breakpoint
CREATE INDEX "page_route_targets_active_deployment_idx" ON "page_route_targets" USING btree ("active_deployment_id");--> statement-breakpoint
CREATE INDEX "page_tag_activations_tag_status_idx" ON "page_tag_activations" USING btree ("tag_id","status");--> statement-breakpoint
CREATE INDEX "page_tag_activations_target_idx" ON "page_tag_activations" USING btree ("to_deployment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "page_tags_project_name_unique" ON "page_tags" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "page_tags_deployment_idx" ON "page_tags" USING btree ("deployment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "page_upload_sessions_deployment_unique" ON "page_upload_sessions" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "page_upload_sessions_status_expiry_idx" ON "page_upload_sessions" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "page_wildcard_profiles_node_status_idx" ON "page_wildcard_profiles" USING btree ("node_id","status");