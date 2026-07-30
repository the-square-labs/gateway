CREATE TABLE "inference_oauth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider_id" varchar(80) NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_name" varchar(255) NOT NULL,
	"flow" varchar(16) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"state_hash" text NOT NULL,
	"encrypted_payload" text NOT NULL,
	"encrypted_dek" text NOT NULL,
	"authorization_url" text NOT NULL,
	"completion_mode" varchar(32) NOT NULL,
	"user_code" varchar(128),
	"poll_interval_seconds" integer,
	"error_code" varchar(128),
	"error_message" text,
	"connection_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inference_oauth_sessions" ADD CONSTRAINT "inference_oauth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inference_oauth_user_status_idx" ON "inference_oauth_sessions" USING btree ("user_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "inference_oauth_state_idx" ON "inference_oauth_sessions" USING btree ("state_hash");