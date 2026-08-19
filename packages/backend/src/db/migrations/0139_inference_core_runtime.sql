CREATE TABLE "inference_core_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(16) NOT NULL,
	"phase" varchar(24) NOT NULL,
	"status" varchar(16) DEFAULT 'running' NOT NULL,
	"progress" jsonb,
	"from_version" varchar(80),
	"to_version" varchar(80),
	"from_digest" text,
	"to_digest" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inference_core_state" (
	"id" text PRIMARY KEY NOT NULL,
	"state" varchar(24) DEFAULT 'not_installed' NOT NULL,
	"installed_version" varchar(80),
	"installed_digest" text,
	"installed_image_ref" text,
	"target_version" varchar(80),
	"target_digest" text,
	"container_id" varchar(128),
	"container_name" varchar(255),
	"state_volume_name" varchar(255),
	"secret_volume_name" varchar(255),
	"network_name" varchar(255),
	"core_protocol_major" integer,
	"core_state_schema_version" integer,
	"health_status" varchar(16),
	"health_checked_at" timestamp with time zone,
	"last_ready_at" timestamp with time zone,
	"last_error" text,
	"credentials_payload" text,
	"credentials_dek" text,
	"credential_key_version" integer,
	"cutover_activated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_core_state_singleton" CHECK ("inference_core_state"."id" = 'default')
);
--> statement-breakpoint
ALTER TABLE "inference_model_sources" ADD COLUMN "core_account_id" text;--> statement-breakpoint
ALTER TABLE "inference_model_sources" ADD COLUMN "core_model_id" text;--> statement-breakpoint
ALTER TABLE "inference_request_attempts" ADD COLUMN "core_attempt_id" text;--> statement-breakpoint
ALTER TABLE "inference_request_attempts" ADD COLUMN "parent_core_attempt_id" text;--> statement-breakpoint
ALTER TABLE "inference_request_attempts" ADD COLUMN "attempt_kind" varchar(16) DEFAULT 'root' NOT NULL;--> statement-breakpoint
CREATE INDEX "inference_core_operations_created_idx" ON "inference_core_operations" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "inference_core_operations_running_unique" ON "inference_core_operations" USING btree ("status") WHERE "inference_core_operations"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "inference_attempts_core_attempt_unique" ON "inference_request_attempts" USING btree ("core_attempt_id") WHERE "inference_request_attempts"."core_attempt_id" IS NOT NULL;