CREATE TYPE "public"."page_project_migration_status" AS ENUM('staging', 'cleanup_pending', 'failed');--> statement-breakpoint
ALTER TABLE "page_projects" ADD COLUMN "node_id" uuid;--> statement-breakpoint
ALTER TABLE "page_projects" ADD COLUMN "migration_source_node_id" uuid;--> statement-breakpoint
ALTER TABLE "page_projects" ADD COLUMN "migration_target_node_id" uuid;--> statement-breakpoint
ALTER TABLE "page_projects" ADD COLUMN "migration_status" "page_project_migration_status";--> statement-breakpoint
ALTER TABLE "page_projects" ADD COLUMN "migration_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "page_projects" ADD COLUMN "migration_error" text;--> statement-breakpoint
UPDATE "page_projects"
SET "node_id" = (
  SELECT "node_id" FROM "page_wildcard_profiles" WHERE "id" = 'default'
)
WHERE "node_id" IS NULL;--> statement-breakpoint
ALTER TABLE "page_projects" ADD CONSTRAINT "page_projects_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_projects" ADD CONSTRAINT "page_projects_migration_source_node_id_nodes_id_fk" FOREIGN KEY ("migration_source_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_projects" ADD CONSTRAINT "page_projects_migration_target_node_id_nodes_id_fk" FOREIGN KEY ("migration_target_node_id") REFERENCES "public"."nodes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "page_projects_node_idx" ON "page_projects" USING btree ("node_id");--> statement-breakpoint
CREATE INDEX "page_projects_migration_idx" ON "page_projects" USING btree ("migration_status","migration_target_node_id");
