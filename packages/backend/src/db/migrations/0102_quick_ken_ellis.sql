CREATE TABLE "ai_run_tool_rounds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"status" varchar(32) DEFAULT 'collecting' NOT NULL,
	"provider_messages" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_conversations" ADD COLUMN "revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_run_questions" ADD COLUMN "round_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_run_questions" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_run_tool_calls" ADD COLUMN "round_id" uuid;--> statement-breakpoint
ALTER TABLE "ai_run_tool_calls" ADD COLUMN "position" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "execution_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "lease_owner" varchar(255);--> statement-breakpoint
ALTER TABLE "ai_runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_run_tool_rounds" ADD CONSTRAINT "ai_run_tool_rounds_run_id_ai_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."ai_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_run_tool_rounds" ADD CONSTRAINT "ai_run_tool_rounds_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_run_tool_rounds_run_sequence_idx" ON "ai_run_tool_rounds" USING btree ("run_id","sequence");--> statement-breakpoint
CREATE INDEX "ai_run_tool_rounds_conversation_status_idx" ON "ai_run_tool_rounds" USING btree ("conversation_id","status");--> statement-breakpoint
ALTER TABLE "ai_run_questions" ADD CONSTRAINT "ai_run_questions_round_id_ai_run_tool_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."ai_run_tool_rounds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_run_tool_calls" ADD CONSTRAINT "ai_run_tool_calls_round_id_ai_run_tool_rounds_id_fk" FOREIGN KEY ("round_id") REFERENCES "public"."ai_run_tool_rounds"("id") ON DELETE cascade ON UPDATE no action;