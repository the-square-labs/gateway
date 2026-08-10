CREATE UNIQUE INDEX "ai_run_questions_run_tool_call_idx" ON "ai_run_questions" USING btree ("run_id","tool_call_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION bump_ai_conversation_revision() RETURNS trigger AS $$
DECLARE
  target_conversation_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'ai_conversations' THEN
    NEW.revision := OLD.revision + 1;
    RETURN NEW;
  END IF;

  target_conversation_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.conversation_id ELSE NEW.conversation_id END;
  UPDATE ai_conversations
  SET revision = revision + 1
  WHERE id = target_conversation_id;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER ai_conversations_revision_trigger
BEFORE UPDATE ON ai_conversations
FOR EACH ROW EXECUTE FUNCTION bump_ai_conversation_revision();
--> statement-breakpoint
CREATE TRIGGER ai_conversation_messages_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON ai_conversation_messages
FOR EACH ROW EXECUTE FUNCTION bump_ai_conversation_revision();
--> statement-breakpoint
CREATE TRIGGER ai_runs_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON ai_runs
FOR EACH ROW EXECUTE FUNCTION bump_ai_conversation_revision();
--> statement-breakpoint
CREATE TRIGGER ai_run_tool_rounds_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON ai_run_tool_rounds
FOR EACH ROW EXECUTE FUNCTION bump_ai_conversation_revision();
--> statement-breakpoint
CREATE TRIGGER ai_run_tool_calls_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON ai_run_tool_calls
FOR EACH ROW EXECUTE FUNCTION bump_ai_conversation_revision();
--> statement-breakpoint
CREATE TRIGGER ai_run_questions_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON ai_run_questions
FOR EACH ROW EXECUTE FUNCTION bump_ai_conversation_revision();
--> statement-breakpoint
CREATE TRIGGER ai_run_credential_challenges_revision_trigger
AFTER INSERT OR UPDATE OR DELETE ON ai_run_credential_challenges
FOR EACH ROW EXECUTE FUNCTION bump_ai_conversation_revision();
