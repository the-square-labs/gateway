import { describe, expect, it } from "vitest";
import type { AIToolCall } from "@/types/ai";
import { isQuestionAwaitingAnswer } from "./ai-question-state";

function question(status: AIToolCall["status"], answer?: string): AIToolCall {
  return {
    id: "question-1",
    name: "ask_question",
    arguments: { question: "Continue?" },
    status,
    result: answer ? { answer } : undefined,
  };
}

describe("AI question state", () => {
  it("hides a question immediately after its answer has been submitted", () => {
    expect(isQuestionAwaitingAnswer(question("awaiting_approval"))).toBe(true);
    expect(isQuestionAwaitingAnswer(question("running"))).toBe(true);
    expect(isQuestionAwaitingAnswer(question("running", "yes"))).toBe(false);
    expect(isQuestionAwaitingAnswer(question("completed", "yes"))).toBe(false);
  });
});
