CREATE TABLE "ai_run_setup_interactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"round_id" uuid,
	"conversation_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"tool_call_id" varchar(255) NOT NULL,
	"tool_name" varchar(255) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"resolved_by_user_id" uuid,
	"resolve_client_command_id" varchar(128),
	"expires_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_runs" DROP CONSTRAINT IF EXISTS "ai_runs_status_check";--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_status_check" CHECK ("status" IN ('queued', 'running', 'waiting_for_approval', 'waiting_for_answer', 'waiting_for_credential', 'waiting_for_setup', 'completed', 'failed', 'stopped'));--> statement-breakpoint
DROP INDEX "ai_runs_one_active_per_conversation_idx";--> statement-breakpoint
ALTER TABLE "ai_run_setup_interactions" ADD CONSTRAINT "ai_run_setup_interactions_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_run_setup_interactions" ADD CONSTRAINT "ai_run_setup_interactions_round_id_ai_run_tool_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."ai_run_tool_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_run_setup_interactions" ADD CONSTRAINT "ai_run_setup_interactions_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_run_setup_interactions" ADD CONSTRAINT "ai_run_setup_interactions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_run_setup_interactions" ADD CONSTRAINT "ai_run_setup_interactions_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_run_setup_interactions_run_tool_call_idx" ON "ai_run_setup_interactions" USING btree ("run_id","tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_run_setup_interactions_resolve_command_idx" ON "ai_run_setup_interactions" USING btree ("user_id","resolve_client_command_id") WHERE "ai_run_setup_interactions"."resolve_client_command_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ai_run_setup_interactions_conversation_status_idx" ON "ai_run_setup_interactions" USING btree ("conversation_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "ai_runs_one_active_per_conversation_idx" ON "ai_runs" USING btree ("conversation_id") WHERE "ai_runs"."status" IN ('queued', 'running', 'waiting_for_approval', 'waiting_for_answer', 'waiting_for_credential', 'waiting_for_setup');
