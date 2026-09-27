-- Availability priority mode: an ordered node list whose first available node serves (the primary), and automatic
-- failback to a higher-priority node after it has stayed healthy for failback_delay_seconds. Existing policies keep
-- priority mode off, so their placement behaviour is unchanged.
ALTER TABLE "docker_availability_policies" ADD COLUMN IF NOT EXISTS "priority_mode" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD COLUMN IF NOT EXISTS "node_priority" text[] DEFAULT '{}' NOT NULL;
--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD COLUMN IF NOT EXISTS "failback_delay_seconds" integer DEFAULT 300 NOT NULL;
--> statement-breakpoint
ALTER TABLE "docker_availability_policies" DROP CONSTRAINT IF EXISTS "docker_availability_policies_priority_check";
--> statement-breakpoint
ALTER TABLE "docker_availability_policies" ADD CONSTRAINT "docker_availability_policies_priority_check" CHECK ("docker_availability_policies"."failback_delay_seconds" BETWEEN 0 AND 3600 AND (NOT "docker_availability_policies"."priority_mode" OR cardinality("docker_availability_policies"."node_priority") > 0));
