CREATE TABLE "siem_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"destination_id" uuid NOT NULL,
	"audit_log_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 8 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"response_status" integer,
	"response_time_ms" integer,
	"error" text,
	"delivered_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "siem_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"url" text NOT NULL,
	"auth_type" varchar(32) NOT NULL,
	"encrypted_secret" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "siem_deliveries" ADD CONSTRAINT "siem_deliveries_destination_id_siem_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."siem_destinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "siem_deliveries_destination_audit_unique" ON "siem_deliveries" USING btree ("destination_id","audit_log_id");--> statement-breakpoint
CREATE INDEX "siem_deliveries_destination_idx" ON "siem_deliveries" USING btree ("destination_id");--> statement-breakpoint
CREATE INDEX "siem_deliveries_status_retry_idx" ON "siem_deliveries" USING btree ("status","next_retry_at");--> statement-breakpoint
CREATE INDEX "siem_deliveries_lease_idx" ON "siem_deliveries" USING btree ("lease_expires_at");--> statement-breakpoint
CREATE INDEX "siem_deliveries_created_idx" ON "siem_deliveries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "siem_destinations_enabled_idx" ON "siem_destinations" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "siem_destinations_deleted_idx" ON "siem_destinations" USING btree ("deleted_at");