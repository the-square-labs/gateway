-- Resumable relay streams (RSv1): the instance secret route resume keys derive from, each route's resume state and
-- key versions, and the deadline of a relay drain. Existing routes start off (raw streams) until their source and
-- target daemons advertise relay_stream_resume_v1.
ALTER TABLE "relay_instances" ADD COLUMN "drain_deadline_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "relay_policy_state" ADD COLUMN "resume_secret_encrypted" text;--> statement-breakpoint
ALTER TABLE "relay_policy_state" ADD COLUMN "resume_secret_dek" text;--> statement-breakpoint
ALTER TABLE "relay_routes" ADD COLUMN "resume_state" varchar(16) DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_routes" ADD COLUMN "key_version" bigint DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "relay_routes" ADD COLUMN "prev_key_version" bigint;--> statement-breakpoint
ALTER TABLE "relay_routes" ADD COLUMN "key_rotated_at" timestamp with time zone;