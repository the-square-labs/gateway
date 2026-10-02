import type { AIConversationRuntimeSnapshot, AIRunToolCall } from "@/types/ai";
import { applyAssistantDeltaToMessages, projectConversationSnapshot } from "./ai.store-runtime";

function toolCall(
  toolCallId: string,
  assistantMessageId: string,
  status: AIRunToolCall["status"]
): AIRunToolCall {
  return {
    id: `row-${toolCallId}`,
    runId: "run-1",
    conversationId: "conversation-1",
    assistantMessageId,
    toolCallId,
    toolName: "list_nodes",
    toolArgs: {},
    classification: "read",
    approvalPolicy: "auto_approved",
    requiredScopes: [],
    status,
    decision: null,
    result: null,
    error: null,
  };
}

// The persisted transcript of a run steered twice: the first steer was accepted between two tool
// rounds, the second is still waiting for the next step. Sequences 1-2 are hidden system events.
function steeredRunSnapshot(): AIConversationRuntimeSnapshot {
  return {
    conversation: {
      id: "conversation-1",
      title: "Steered run",
      createdAt: "2026-10-02T10:00:00.000Z",
      updatedAt: "2026-10-02T10:00:05.000Z",
      lastContext: null,
      discoveredToolsets: [],
      checkpoint: null,
    },
    messages: [
      { id: "user-1", sequence: 0, role: "user", content: "Check the nodes" },
      { id: "text-1", sequence: 3, role: "assistant", content: "Checking the nodes." },
      { id: "boundary-1", sequence: 4, role: "assistant", content: "", toolGroupBoundary: true },
      { id: "steer-1", sequence: 5, role: "user", content: "Only the edge nodes", steer: true },
      { id: "boundary-2", sequence: 6, role: "assistant", content: "", toolGroupBoundary: true },
    ],
    runtime: {
      activeRun: { id: "run-1", status: "running", activeMessageId: "user-1" } as never,
      assistantDraftContent: null,
      assistantDraftVersion: null,
      pendingApprovals: [],
      pendingQuestion: null,
      pendingQuestions: [],
      toolCalls: [
        toolCall("call-1", "boundary-1", "completed"),
        toolCall("call-2", "boundary-2", "running"),
      ],
      pendingInputs: [
        {
          id: "input-2",
          conversationId: "conversation-1",
          targetRunId: "run-1",
          userId: "user",
          clientCommandId: "command-2",
          mode: "steer",
          status: "pending",
          content: "Skip the staging ones",
          attachments: [],
          context: null,
          consumedAt: null,
          createdAt: "2026-10-02T10:00:04.000Z",
          updatedAt: "2026-10-02T10:00:04.000Z",
        },
      ],
    },
  };
}

describe("AI steer ordering", () => {
  it("keeps an accepted steer between its tool groups and a pending steer below the live run", () => {
    const messages = projectConversationSnapshot(steeredRunSnapshot()).messages ?? [];

    expect(messages.map((message) => message.id)).toEqual([
      "user-1",
      "text-1",
      "boundary-1",
      "steer-1",
      "boundary-2",
      "steer:input-2",
    ]);
    const toolCallIds = (id: string) =>
      messages.find((message) => message.id === id)?.toolCalls?.map((call) => call.id);
    expect(toolCallIds("boundary-1")).toEqual(["call-1"]);
    expect(toolCallIds("boundary-2")).toEqual(["call-2"]);

    const streamed = applyAssistantDeltaToMessages(messages, {
      type: "assistant.delta",
      conversationId: "conversation-1",
      runId: "run-1",
      content: "Two edge nodes found.",
      version: 1,
    });
    expect(streamed.slice(-2).map((message) => message.id)).toEqual([
      "run-1:runtime",
      "steer:input-2",
    ]);
  });
});
