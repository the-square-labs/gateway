CREATE TABLE "docker_compose_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"revision_id" uuid,
	"task_id" uuid,
	"idempotency_key" text NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"progress" text,
	"error" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "docker_compose_operations_project_idempotency_unique" UNIQUE("project_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "docker_compose_projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"name" text NOT NULL,
	"management_state" text DEFAULT 'external' NOT NULL,
	"desired_state" text DEFAULT 'running' NOT NULL,
	"status" text DEFAULT 'discovered' NOT NULL,
	"availability" text DEFAULT 'available' NOT NULL,
	"active_revision_id" uuid,
	"observed_fingerprint" text,
	"last_seen_at" timestamp with time zone,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docker_compose_projects_node_id_name_unique" UNIQUE("node_id","name")
);
--> statement-breakpoint
CREATE TABLE "docker_compose_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"original_yaml" text NOT NULL,
	"normalized_model" jsonb NOT NULL,
	"config_digest" text NOT NULL,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_keys" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docker_compose_revisions_project_revision_unique" UNIQUE("project_id","revision_number"),
	CONSTRAINT "docker_compose_revisions_project_digest_unique" UNIQUE("project_id","config_digest")
);
--> statement-breakpoint
ALTER TABLE "docker_compose_operations" ADD CONSTRAINT "docker_compose_operations_project_id_docker_compose_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."docker_compose_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_compose_operations" ADD CONSTRAINT "docker_compose_operations_revision_id_docker_compose_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."docker_compose_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_compose_operations" ADD CONSTRAINT "docker_compose_operations_task_id_docker_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."docker_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_compose_operations" ADD CONSTRAINT "docker_compose_operations_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_compose_projects" ADD CONSTRAINT "docker_compose_projects_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_compose_projects" ADD CONSTRAINT "docker_compose_projects_active_revision_id_docker_compose_revisions_id_fk" FOREIGN KEY ("active_revision_id") REFERENCES "public"."docker_compose_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_compose_projects" ADD CONSTRAINT "docker_compose_projects_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_compose_projects" ADD CONSTRAINT "docker_compose_projects_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_compose_revisions" ADD CONSTRAINT "docker_compose_revisions_project_id_docker_compose_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."docker_compose_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_compose_revisions" ADD CONSTRAINT "docker_compose_revisions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "docker_compose_operations_project_created_at_idx" ON "docker_compose_operations" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "docker_compose_operations_task_id_idx" ON "docker_compose_operations" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "docker_compose_projects_node_id_idx" ON "docker_compose_projects" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "docker_compose_projects_management_state_idx" ON "docker_compose_projects" USING btree ("management_state");--> statement-breakpoint
CREATE INDEX "docker_compose_projects_last_seen_at_idx" ON "docker_compose_projects" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "docker_compose_revisions_project_id_idx" ON "docker_compose_revisions" USING btree ("project_id");