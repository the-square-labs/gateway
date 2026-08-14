CREATE TABLE "integration_github_oauth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"encrypted_device_code" text NOT NULL,
	"user_code" varchar(64) NOT NULL,
	"verification_uri" text NOT NULL,
	"connector_draft" jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"poll_interval_seconds" integer DEFAULT 5 NOT NULL,
	"last_polled_at" timestamp with time zone,
	"connector_id" uuid,
	"error_message" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "integration_connectors" ADD COLUMN "auth_mode" varchar(32) DEFAULT 'token' NOT NULL;--> statement-breakpoint
ALTER TABLE "integration_connectors" ADD COLUMN "username" varchar(255);--> statement-breakpoint
ALTER TABLE "integration_github_oauth_sessions" ADD CONSTRAINT "integration_github_oauth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_github_oauth_sessions" ADD CONSTRAINT "integration_github_oauth_sessions_connector_id_integration_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."integration_connectors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_github_oauth_user_status_idx" ON "integration_github_oauth_sessions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "integration_github_oauth_expiry_idx" ON "integration_github_oauth_sessions" USING btree ("expires_at");
