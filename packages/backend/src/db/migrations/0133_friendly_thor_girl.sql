CREATE TABLE "page_runtime_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"tag_id" uuid,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generation" integer DEFAULT 0 NOT NULL,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "page_runtime_configs" ADD CONSTRAINT "page_runtime_configs_project_id_page_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."page_projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_runtime_configs" ADD CONSTRAINT "page_runtime_configs_tag_id_page_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."page_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_runtime_configs" ADD CONSTRAINT "page_runtime_configs_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "page_runtime_configs_tag_unique" ON "page_runtime_configs" USING btree ("tag_id");--> statement-breakpoint
CREATE UNIQUE INDEX "page_runtime_configs_default_unique" ON "page_runtime_configs" USING btree ("project_id") WHERE "page_runtime_configs"."tag_id" is null;--> statement-breakpoint
CREATE INDEX "page_runtime_configs_project_idx" ON "page_runtime_configs" USING btree ("project_id");--> statement-breakpoint
INSERT INTO "page_runtime_configs" ("project_id", "value", "generation")
SELECT "id", '{}'::jsonb, 0 FROM "page_projects";
