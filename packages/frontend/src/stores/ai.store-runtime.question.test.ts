import { afterEach, describe, expect, it } from "vitest";
import { isQuestionAwaitingAnswer } from "@/lib/ai-question-state";
import type { AIConversationRuntimeSnapshot } from "@/types/ai";
import { projectConversationSnapshot } from "./ai.store-runtime";
import { answeredQuestionTombstones } from "./ai.store-shared";

function snapshot(): AIConversationRuntimeSnapshot {
  return {
    conversation: {
      id: "conversation-1",
      title: "Question flow",
      createdAt: "2026-08-30T12:00:00.000Z",
      updatedAt: "2026-08-30T12:00:01.000Z",
      lastContext: null,
      discoveredToolsets: [],
      checkpoint: null,
    },
    messages: [
      {
        id: "assistant-1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "question-1",
            name: "ask_question",
            arguments: { question: "Continue?" },
            status: "awaiting_approval",
          },
        ],
      },
    ],
    runtime: {
      activeRun: { id: "run-1", status: "waiting_for_answer" } as never,
      pendingApprovals: [],
      pendingQuestion: null,
      pendingQuestions: [
        {
          id: "question-row-1",
          runId: "run-1",
          conversationId: "conversation-1",
          toolCallId: "question-1",
          question: "Continue?",
          status: "pending",
          answer: null,
        },
      ],
      toolCalls: [],
    },
  };
}

afterEach(() => answeredQuestionTombstones.clear());

describe("AI question snapshot reconciliation", () => {
  it("does not resurrect an optimistically answered question from a stale snapshot", () => {
    answeredQuestionTombstones.set("question-1", {
      conversationId: "conversation-1",
      runId: "run-1",
      expiresAt: Date.now() + 30_000,
    });

    const projection = projectConversationSnapshot(snapshot());
    const questions = (projection.messages ?? [])
      .flatMap((message) => message.toolCalls ?? [])
      .filter((toolCall) => toolCall.name === "ask_question");

    expect(projection.pendingApprovalToolCallId).toBeNull();
    expect(questions.some(isQuestionAwaitingAnswer)).toBe(false);
  });
});
