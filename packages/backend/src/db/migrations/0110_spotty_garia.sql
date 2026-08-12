CREATE TABLE "ai_plan_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"plan_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"status" varchar(32) DEFAULT 'draft' NOT NULL,
	"goal" text NOT NULL,
	"scope" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assumptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"research" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"intent_review" jsonb,
	"security_review" jsonb,
	"verification" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"change_summary" jsonb,
	"validation_attempts" integer DEFAULT 0 NOT NULL,
	"validator_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"decision" varchar(32),
	"custom_instruction" text,
	"decision_client_command_id" varchar(128),
	"published_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"decision_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_plan_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"title" varchar(255) NOT NULL,
	"description" text NOT NULL,
	"verification" text NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skip_reason" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" varchar(32) DEFAULT 'drafting' NOT NULL,
	"title" varchar(255),
	"model" varchar(255),
	"reasoning_effort" varchar(64),
	"no_progress_runs" integer DEFAULT 0 NOT NULL,
	"progress_version" integer DEFAULT 0 NOT NULL,
	"active_time_ms" bigint DEFAULT 0 NOT NULL,
	"active_since" timestamp with time zone,
	"pause_reason" text,
	"completed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "plan_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "purpose" varchar(32) DEFAULT 'direct' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_plan_revisions" ADD CONSTRAINT "ai_plan_revisions_plan_id_ai_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."ai_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_plan_steps" ADD CONSTRAINT "ai_plan_steps_revision_id_ai_plan_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."ai_plan_revisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_plans" ADD CONSTRAINT "ai_plans_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_plans" ADD CONSTRAINT "ai_plans_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_plan_revisions_plan_revision_idx" ON "ai_plan_revisions" USING btree ("plan_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_plan_revisions_decision_command_idx" ON "ai_plan_revisions" USING btree ("decision_client_command_id") WHERE "ai_plan_revisions"."decision_client_command_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_plan_revisions_plan_status_idx" ON "ai_plan_revisions" USING btree ("plan_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_plan_steps_revision_ordinal_idx" ON "ai_plan_steps" USING btree ("revision_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_plan_steps_one_in_progress_per_revision_idx" ON "ai_plan_steps" USING btree ("revision_id") WHERE "ai_plan_steps"."status" = 'in_progress';--> statement-breakpoint
CREATE INDEX "ai_plan_steps_revision_status_idx" ON "ai_plan_steps" USING btree ("revision_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_plans_one_active_per_conversation_idx" ON "ai_plans" USING btree ("conversation_id") WHERE "ai_plans"."status" IN ('drafting', 'validating', 'awaiting_decision', 'executing', 'paused', 'verifying');--> statement-breakpoint
CREATE INDEX "ai_plans_user_status_idx" ON "ai_plans" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "ai_plans_conversation_created_idx" ON "ai_plans" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE TRIGGER ai_plans_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON ai_plans
FOR EACH ROW EXECUTE FUNCTION bump_ai_conversation_revision();--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_plan_id_ai_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."ai_plans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_plan_revision_id_ai_plan_revisions_id_fk" FOREIGN KEY ("plan_revision_id") REFERENCES "public"."ai_plan_revisions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_runs_plan_status_idx" ON "ai_runs" USING btree ("plan_id","status");
