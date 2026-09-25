CREATE TABLE IF NOT EXISTS "system_certificate_renewals" (
	"owner_type" "system_certificate_owner_type" NOT NULL,
	"owner_id" varchar(255) NOT NULL,
	"state" varchar(32) DEFAULT 'idle' NOT NULL,
	"reason" varchar(64),
	"pending_certificate_id" uuid,
	"pending_serial" varchar(255),
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"served_fingerprint" varchar(128),
	"last_method" varchar(32),
	"last_restarted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "system_certificate_renewals_pkey" PRIMARY KEY("owner_type","owner_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "system_certificate_renewals_next_attempt_idx" ON "system_certificate_renewals" USING btree ("next_attempt_at");
