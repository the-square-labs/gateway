CREATE TABLE "docker_build_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_binding_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"encrypted_value" text NOT NULL,
	"created_by_id" uuid,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ALTER COLUMN "policy" SET DEFAULT '{}'::jsonb;--> statement-breakpoint
ALTER TABLE "docker_source_bindings" ADD COLUMN "auto_build" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "docker_build_secrets" ADD CONSTRAINT "docker_build_secrets_source_binding_id_docker_source_bindings_id_fk" FOREIGN KEY ("source_binding_id") REFERENCES "public"."docker_source_bindings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_build_secrets" ADD CONSTRAINT "docker_build_secrets_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docker_build_secrets" ADD CONSTRAINT "docker_build_secrets_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "docker_build_secrets_binding_name_unique" ON "docker_build_secrets" USING btree ("source_binding_id","name");--> statement-breakpoint
CREATE INDEX "docker_build_secrets_binding_idx" ON "docker_build_secrets" USING btree ("source_binding_id");