CREATE TABLE "docker_build_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_binding_id" uuid NOT NULL,
	"dedupe_key" text NOT NULL,
	"commit_sha" varchar(64) NOT NULL,
	"status" varchar(32) DEFAULT 'building' NOT NULL,
	"expected_services" jsonb NOT NULL,
	"compose_build_plan" jsonb NOT NULL,
	"compose_variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"compose_secret_keys" text[] DEFAULT '{}' NOT NULL,
	"candidate_revision_id" uuid,
	"superseded_by_batch_id" uuid,
	"error_code" text,
	"error_message" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "docker_source_bindings" DROP CONSTRAINT "docker_source_bindings_target_shape_check";--> statement-breakpoint
ALTER TABLE "docker_compose_revisions" ADD COLUMN "source_binding_id" uuid;--> statement-breakpoint
ALTER TABLE "docker_compose_revisions" ADD COLUMN "build_batch_id" uuid;--> statement-breakpoint
ALTER TABLE "docker_compose_revisions" ADD COLUMN "source_commit_sha" text;--> statement-breakpoint
ALTER TABLE "docker_artifact_pins" ADD COLUMN "compose_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "docker_builds" ADD COLUMN "batch_id" uuid;--> statement-breakpoint
ALTER TABLE "docker_builds" ADD COLUMN "service_name" text;--> statement-breakpoint
ALTER TABLE "docker_builds" ADD COLUMN "dockerfile_path" text DEFAULT 'Dockerfile' NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_builds" ADD COLUMN "context_path" text DEFAULT '.' NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_builds" ADD COLUMN "build_args" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD COLUMN "compose_project_id" uuid;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD COLUMN "compose_file_path" text;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD COLUMN "compose_variables" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD COLUMN "compose_secret_keys" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD COLUMN "compose_build_plan" jsonb;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD COLUMN "deploying_commit_sha" varchar(64);--> statement-breakpoint
ALTER TABLE "docker_build_batches" ADD CONSTRAINT "docker_build_batches_source_binding_id_docker_source_bindings_id_fk" FOREIGN KEY ("source_binding_id") REFERENCES "public"."docker_source_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_build_batches" ADD CONSTRAINT "docker_build_batches_candidate_revision_id_docker_compose_revisions_id_fk" FOREIGN KEY ("candidate_revision_id") REFERENCES "public"."docker_compose_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_build_batches" ADD CONSTRAINT "docker_build_batches_superseded_by_batch_id_docker_build_batches_id_fk" FOREIGN KEY ("superseded_by_batch_id") REFERENCES "public"."docker_build_batches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_build_batches" ADD CONSTRAINT "docker_build_batches_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "docker_build_batches_dedupe_unique" ON "docker_build_batches" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "docker_build_batches_source_created_idx" ON "docker_build_batches" USING btree ("source_binding_id","created_at");--> statement-breakpoint
CREATE INDEX "docker_build_batches_status_idx" ON "docker_build_batches" USING btree ("status","updated_at");--> statement-breakpoint
ALTER TABLE "docker_artifact_pins" ADD CONSTRAINT "docker_artifact_pins_compose_revision_id_docker_compose_revisions_id_fk" FOREIGN KEY ("compose_revision_id") REFERENCES "public"."docker_compose_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_builds" ADD CONSTRAINT "docker_builds_batch_id_docker_build_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."docker_build_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD CONSTRAINT "docker_source_bindings_compose_project_id_docker_compose_projects_id_fk" FOREIGN KEY ("compose_project_id") REFERENCES "public"."docker_compose_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "docker_builds_batch_service_unique" ON "docker_builds" USING btree ("batch_id","service_name");--> statement-breakpoint
CREATE INDEX "docker_builds_batch_status_idx" ON "docker_builds" USING btree ("batch_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "docker_source_bindings_compose_project_unique" ON "docker_source_bindings" USING btree ("compose_project_id") WHERE "docker_source_bindings"."target_kind" = 'compose_project';--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD CONSTRAINT "docker_source_bindings_compose_file_not_absolute_check" CHECK ("docker_source_bindings"."compose_file_path" IS NULL OR ("docker_source_bindings"."compose_file_path" !~ '^/' AND ('/' || "docker_source_bindings"."compose_file_path" || '/') NOT LIKE '%/../%'));--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD CONSTRAINT "docker_source_bindings_target_shape_check" CHECK (("docker_source_bindings"."target_kind" = 'container' AND "docker_source_bindings"."node_id" IS NOT NULL AND "docker_source_bindings"."container_name" IS NOT NULL AND "docker_source_bindings"."deployment_id" IS NULL AND "docker_source_bindings"."compose_project_id" IS NULL AND "docker_source_bindings"."compose_file_path" IS NULL) OR ("docker_source_bindings"."target_kind" = 'deployment' AND "docker_source_bindings"."node_id" IS NULL AND "docker_source_bindings"."container_name" IS NULL AND "docker_source_bindings"."deployment_id" IS NOT NULL AND "docker_source_bindings"."compose_project_id" IS NULL AND "docker_source_bindings"."compose_file_path" IS NULL) OR ("docker_source_bindings"."target_kind" = 'compose_project' AND "docker_source_bindings"."node_id" IS NULL AND "docker_source_bindings"."container_name" IS NULL AND "docker_source_bindings"."deployment_id" IS NULL AND "docker_source_bindings"."compose_project_id" IS NOT NULL AND "docker_source_bindings"."compose_file_path" IS NOT NULL));
