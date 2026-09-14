CREATE TYPE "public"."object_storage_connection_origin" AS ENUM('user', 'managed');--> statement-breakpoint
CREATE TYPE "public"."object_storage_health_status" AS ENUM('online', 'offline', 'degraded', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."object_storage_provider" AS ENUM('aws', 'cloudflare_r2', 'minio', 'other', 'ftp', 'ftps', 'sftp');--> statement-breakpoint
CREATE TYPE "public"."managed_storage_member_status" AS ENUM('pending', 'ready', 'error', 'removing');--> statement-breakpoint
CREATE TYPE "public"."managed_storage_status" AS ENUM('creating', 'updating', 'ready', 'stopped', 'error', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."storage_binding_status" AS ENUM('creating', 'ready', 'error', 'deleting');--> statement-breakpoint
CREATE TYPE "public"."storage_binding_target_type" AS ENUM('container', 'deployment');--> statement-breakpoint
ALTER TYPE "public"."system_ca_purpose" ADD VALUE 'storage-tls';--> statement-breakpoint
ALTER TYPE "public"."system_certificate_owner_type" ADD VALUE 'managed_storage' BEFORE 'gateway_listener';--> statement-breakpoint
ALTER TYPE "public"."node_type" ADD VALUE 'storage' BEFORE 'relay';--> statement-breakpoint
CREATE TABLE "object_storage_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(60) NOT NULL,
	"provider" "object_storage_provider" NOT NULL,
	"origin" "object_storage_connection_origin" DEFAULT 'user' NOT NULL,
	"description" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"endpoint" varchar(512),
	"region" varchar(128),
	"access_key_id" varchar(255),
	"default_bucket" varchar(255),
	"force_path_style" boolean DEFAULT false NOT NULL,
	"host" varchar(255),
	"port" integer,
	"username" varchar(255),
	"base_path" varchar(1024),
	"implicit_tls" boolean DEFAULT false NOT NULL,
	"encrypted_config" text NOT NULL,
	"health_status" "object_storage_health_status" DEFAULT 'unknown' NOT NULL,
	"last_health_check_at" timestamp with time zone,
	"last_error" text,
	"health_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"folder_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "object_storage_connections_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "object_storage_folders" (
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
CREATE TABLE "managed_storage_access_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"access_key_id" varchar(128) NOT NULL,
	"encrypted_secret_key" text NOT NULL,
	"name" varchar(255),
	"access" varchar(16),
	"buckets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_storage_access_keys_cluster_id_access_key_id_unique" UNIQUE("cluster_id","access_key_id")
);
--> statement-breakpoint
CREATE TABLE "managed_storage_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"target_node_id" uuid NOT NULL,
	"target_type" "storage_binding_target_type" NOT NULL,
	"target_resource_id" varchar(255) NOT NULL,
	"network_name" varchar(128) NOT NULL,
	"connector_name" varchar(128) NOT NULL,
	"connector_alias" varchar(128) NOT NULL,
	"environment" jsonb NOT NULL,
	"access_key_id" varchar(255),
	"buckets" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "storage_binding_status" DEFAULT 'creating' NOT NULL,
	"last_error" text,
	"created_by_id" uuid NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_storage_bindings_target_unique" UNIQUE("cluster_id","target_node_id","target_type","target_resource_id")
);
--> statement-breakpoint
CREATE TABLE "managed_storage_cluster_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"member_index" integer NOT NULL,
	"drives" integer DEFAULT 1 NOT NULL,
	"status" "managed_storage_member_status" DEFAULT 'pending' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_storage_cluster_members_cluster_id_member_index_unique" UNIQUE("cluster_id","member_index")
);
--> statement-breakpoint
CREATE TABLE "managed_storage_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"object_storage_connection_id" uuid,
	"node_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(60) NOT NULL,
	"version" varchar(128) NOT NULL,
	"image_ref" varchar(512) NOT NULL,
	"encrypted_root_credentials" text NOT NULL,
	"storage_size_bytes" bigint NOT NULL,
	"runtime_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"erasure_config" jsonb DEFAULT '{"nodeCount":1,"drivesPerNode":1}'::jsonb NOT NULL,
	"publish_s3" boolean DEFAULT false NOT NULL,
	"published_port" integer NOT NULL,
	"status" "managed_storage_status" DEFAULT 'creating' NOT NULL,
	"tls_enabled" boolean DEFAULT false NOT NULL,
	"relay_enabled" boolean DEFAULT false NOT NULL,
	"certificate_id" uuid,
	"sftp_enabled" boolean DEFAULT false NOT NULL,
	"sftp_port" integer,
	"encrypted_sftp_host_key" text,
	"ftp_enabled" boolean DEFAULT false NOT NULL,
	"ftp_port" integer,
	"ftp_passive_port_start" integer,
	"ftp_passive_port_count" integer,
	"pending_operation" jsonb,
	"last_error" text,
	"created_by_id" uuid NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "managed_storage_clusters_object_storage_connection_unique" UNIQUE("object_storage_connection_id"),
	CONSTRAINT "managed_storage_clusters_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "backup_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"database_connection_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"bucket" text NOT NULL,
	"prefix" text NOT NULL,
	"staging_storage_connection_id" uuid,
	"staging_bucket" text,
	"executor_node_id" uuid NOT NULL,
	"schedule" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"last_scheduled_at" timestamp with time zone,
	"retention_count" integer DEFAULT 7 NOT NULL,
	"limits" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_run_node_leases" (
	"executor_node_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "backup_run_node_leases_pkey" PRIMARY KEY("executor_node_id")
);
--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"policy_id" uuid,
	"database_connection_id" uuid NOT NULL,
	"destination_id" uuid NOT NULL,
	"destination_bucket" text NOT NULL,
	"destination_prefix" text NOT NULL,
	"staging_storage_connection_id" uuid,
	"staging_bucket" text,
	"timezone" text NOT NULL,
	"executor_node_id" uuid NOT NULL,
	"direction" text NOT NULL,
	"engine" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"phase" text DEFAULT 'queued' NOT NULL,
	"request_fingerprint" text NOT NULL,
	"restore_target" jsonb,
	"manifest" jsonb,
	"bytes" text DEFAULT '0' NOT NULL,
	"sanitized_error" text,
	"runtime_cleanup_pending" boolean DEFAULT false NOT NULL,
	"created_by_id" uuid,
	"claimed_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "object_storage_connections" ADD CONSTRAINT "object_storage_connections_folder_id_object_storage_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."object_storage_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_storage_connections" ADD CONSTRAINT "object_storage_connections_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_storage_connections" ADD CONSTRAINT "object_storage_connections_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_storage_folders" ADD CONSTRAINT "object_storage_folders_parent_id_object_storage_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."object_storage_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_storage_folders" ADD CONSTRAINT "object_storage_folders_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_storage_access_keys" ADD CONSTRAINT "managed_storage_access_keys_cluster_id_managed_storage_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."managed_storage_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_storage_access_keys" ADD CONSTRAINT "managed_storage_access_keys_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_storage_bindings" ADD CONSTRAINT "managed_storage_bindings_cluster_id_managed_storage_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."managed_storage_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_storage_bindings" ADD CONSTRAINT "managed_storage_bindings_target_node_id_nodes_id_fk" FOREIGN KEY ("target_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_storage_bindings" ADD CONSTRAINT "managed_storage_bindings_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_storage_bindings" ADD CONSTRAINT "managed_storage_bindings_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_storage_cluster_members" ADD CONSTRAINT "managed_storage_cluster_members_cluster_id_managed_storage_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."managed_storage_clusters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_storage_cluster_members" ADD CONSTRAINT "managed_storage_cluster_members_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_storage_clusters" ADD CONSTRAINT "managed_storage_clusters_object_storage_connection_id_object_storage_connections_id_fk" FOREIGN KEY ("object_storage_connection_id") REFERENCES "public"."object_storage_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_storage_clusters" ADD CONSTRAINT "managed_storage_clusters_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_storage_clusters" ADD CONSTRAINT "managed_storage_clusters_certificate_id_certificates_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificates"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_storage_clusters" ADD CONSTRAINT "managed_storage_clusters_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "managed_storage_clusters" ADD CONSTRAINT "managed_storage_clusters_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_database_connection_id_database_connections_id_fk" FOREIGN KEY ("database_connection_id") REFERENCES "public"."database_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_executor_node_id_nodes_id_fk" FOREIGN KEY ("executor_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_run_node_leases" ADD CONSTRAINT "backup_run_node_leases_executor_node_id_nodes_id_fk" FOREIGN KEY ("executor_node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_run_node_leases" ADD CONSTRAINT "backup_run_node_leases_run_id_backup_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."backup_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_policy_id_backup_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."backup_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_database_connection_id_database_connections_id_fk" FOREIGN KEY ("database_connection_id") REFERENCES "public"."database_connections"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_executor_node_id_nodes_id_fk" FOREIGN KEY ("executor_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "object_storage_connections_provider_idx" ON "object_storage_connections" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "object_storage_connections_health_idx" ON "object_storage_connections" USING btree ("health_status");--> statement-breakpoint
CREATE INDEX "object_storage_connections_folder_idx" ON "object_storage_connections" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "object_storage_connections_created_by_idx" ON "object_storage_connections" USING btree ("created_by_id");--> statement-breakpoint
CREATE INDEX "object_storage_connections_updated_by_idx" ON "object_storage_connections" USING btree ("updated_by_id");--> statement-breakpoint
CREATE INDEX "object_storage_folder_parent_idx" ON "object_storage_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "object_storage_folder_sort_idx" ON "object_storage_folders" USING btree ("parent_id","sort_order");--> statement-breakpoint
CREATE INDEX "managed_storage_access_keys_cluster_idx" ON "managed_storage_access_keys" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "managed_storage_bindings_cluster_idx" ON "managed_storage_bindings" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "managed_storage_bindings_target_node_idx" ON "managed_storage_bindings" USING btree ("target_node_id");--> statement-breakpoint
CREATE INDEX "managed_storage_cluster_members_cluster_idx" ON "managed_storage_cluster_members" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "managed_storage_clusters_node_idx" ON "managed_storage_clusters" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "managed_storage_clusters_status_idx" ON "managed_storage_clusters" USING btree ("status");--> statement-breakpoint
CREATE INDEX "backup_policies_database_idx" ON "backup_policies" USING btree ("database_connection_id");--> statement-breakpoint
CREATE INDEX "backup_policies_executor_idx" ON "backup_policies" USING btree ("executor_node_id");--> statement-breakpoint
CREATE INDEX "backup_run_node_leases_run_idx" ON "backup_run_node_leases" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "backup_runs_policy_idx" ON "backup_runs" USING btree ("policy_id");--> statement-breakpoint
CREATE INDEX "backup_runs_database_idx" ON "backup_runs" USING btree ("database_connection_id");--> statement-breakpoint
CREATE INDEX "backup_runs_executor_status_idx" ON "backup_runs" USING btree ("executor_node_id","status");--> statement-breakpoint
CREATE INDEX "backup_runs_created_at_idx" ON "backup_runs" USING btree ("created_at");