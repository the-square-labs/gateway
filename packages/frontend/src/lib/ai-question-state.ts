import type { AIToolCall } from "@/types/ai";

export function questionHasSubmittedAnswer(toolCall: AIToolCall): boolean {
  return Boolean(
    toolCall.result &&
      typeof toolCall.result === "object" &&
      typeof (toolCall.result as { answer?: unknown }).answer === "string"
  );
}

export function isQuestionAwaitingAnswer(toolCall: AIToolCall): boolean {
  if (toolCall.name !== "ask_question") return false;
  if (toolCall.status === "awaiting_approval") return true;
  return toolCall.status === "running" && !questionHasSubmittedAnswer(toolCall);
}
