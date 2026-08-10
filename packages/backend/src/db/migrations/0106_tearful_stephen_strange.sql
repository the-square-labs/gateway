CREATE TABLE "ai_conversation_inputs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"target_run_id" uuid,
	"user_id" uuid NOT NULL,
	"client_command_id" varchar(128) NOT NULL,
	"mode" varchar(16) DEFAULT 'queued' NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"content" text NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"context" jsonb,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_conversation_inputs" ADD CONSTRAINT "ai_conversation_inputs_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversation_inputs" ADD CONSTRAINT "ai_conversation_inputs_target_run_id_ai_runs_id_fk" FOREIGN KEY ("target_run_id") REFERENCES "public"."ai_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_conversation_inputs" ADD CONSTRAINT "ai_conversation_inputs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_conversation_inputs_user_command_idx" ON "ai_conversation_inputs" USING btree ("user_id","client_command_id");--> statement-breakpoint
CREATE INDEX "ai_conversation_inputs_conversation_pending_idx" ON "ai_conversation_inputs" USING btree ("conversation_id","status","created_at");--> statement-breakpoint
CREATE INDEX "ai_conversation_inputs_run_pending_idx" ON "ai_conversation_inputs" USING btree ("target_run_id","status","created_at");--> statement-breakpoint
CREATE TRIGGER ai_conversation_inputs_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON ai_conversation_inputs
FOR EACH ROW EXECUTE FUNCTION bump_ai_conversation_revision();
