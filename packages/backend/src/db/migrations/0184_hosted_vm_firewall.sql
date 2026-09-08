CREATE TABLE "hosting_firewalls" (
	"resource_id" uuid PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"config" jsonb NOT NULL,
	"status" text DEFAULT 'loading' NOT NULL,
	"observation" jsonb,
	"expected_fingerprint" text,
	"connector_revision" text NOT NULL,
	"actor_id" uuid,
	"error" text,
	"dispatched_at" timestamp with time zone,
	"observed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hosting_firewalls" ADD CONSTRAINT "hosting_firewalls_resource_id_hosting_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."hosting_resources"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosting_firewalls" ADD CONSTRAINT "hosting_firewalls_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;