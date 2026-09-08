CREATE TABLE "hosting_snapshot_entities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"resource_id" uuid NOT NULL,
	"incarnation" text NOT NULL,
	"operation_id" uuid,
	"provider_snapshot_id" text,
	"fingerprint" text,
	"name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"include_ram" boolean DEFAULT false NOT NULL,
	"data" jsonb NOT NULL,
	"error" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosting_snapshot_entity_provider_unique" UNIQUE("resource_id","incarnation","provider_snapshot_id")
);
--> statement-breakpoint
ALTER TABLE "hosting_snapshot_entities" ADD CONSTRAINT "hosting_snapshot_entities_resource_id_hosting_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."hosting_resources"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "hosting_snapshot_entity_resource_incarnation_idx" ON "hosting_snapshot_entities" USING btree ("resource_id","incarnation");
--> statement-breakpoint
CREATE INDEX "hosting_snapshot_entity_operation_idx" ON "hosting_snapshot_entities" USING btree ("operation_id");
