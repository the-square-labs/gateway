CREATE TABLE "external_ssh_connectors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"host" varchar(255) NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"username" varchar(255) NOT NULL,
	"auth_method" varchar(32) NOT NULL,
	"encrypted_secret" text NOT NULL,
	"encrypted_passphrase" text,
	"host_fingerprint" varchar(255) NOT NULL,
	"jump_connector_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_ssh_connector_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "external_ssh_connectors" ADD CONSTRAINT "external_ssh_connectors_jump_connector_id_external_ssh_connectors_id_fk" FOREIGN KEY ("jump_connector_id") REFERENCES "public"."external_ssh_connectors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_ssh_connectors" ADD CONSTRAINT "external_ssh_connectors_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_ssh_connector_host_idx" ON "external_ssh_connectors" USING btree ("host");--> statement-breakpoint
CREATE INDEX "external_ssh_connector_jump_idx" ON "external_ssh_connectors" USING btree ("jump_connector_id");