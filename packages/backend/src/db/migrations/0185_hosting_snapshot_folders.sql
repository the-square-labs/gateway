CREATE TABLE "hosting_snapshot_folders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_id" uuid NOT NULL,
	"name" text NOT NULL,
	"parent_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"depth" integer DEFAULT 0 NOT NULL,
	"created_by_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosting_snapshot_placements" (
	"id" uuid PRIMARY KEY NOT NULL,
	"resource_id" uuid NOT NULL,
	"snapshot_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"folder_id" uuid,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hosting_snapshot_folders" ADD CONSTRAINT "hosting_snapshot_folders_resource_id_hosting_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."hosting_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_snapshot_folders" ADD CONSTRAINT "hosting_snapshot_folders_parent_id_hosting_snapshot_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."hosting_snapshot_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_snapshot_folders" ADD CONSTRAINT "hosting_snapshot_folders_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_snapshot_placements" ADD CONSTRAINT "hosting_snapshot_placements_resource_id_hosting_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."hosting_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_snapshot_placements" ADD CONSTRAINT "hosting_snapshot_placements_folder_id_hosting_snapshot_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."hosting_snapshot_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hosting_snapshot_folder_resource_idx" ON "hosting_snapshot_folders" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "hosting_snapshot_placement_resource_idx" ON "hosting_snapshot_placements" USING btree ("resource_id");