import { describe, expect, it } from "vitest";
import type { AIConversationSummary } from "@/services/ai-conversations";
import { isConversationProgressActive } from "./AILiteSidebar";

function conversation(overrides: Partial<AIConversationSummary> = {}): AIConversationSummary {
  return {
    id: "conversation-1",
    title: "Work Session",
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    lastUserMessageAt: "2026-08-14T00:00:00.000Z",
    folderId: null,
    messageCount: 1,
    status: "active",
    blockReason: null,
    activeRunStatus: null,
    planStatus: null,
    ...overrides,
  };
}

describe("AI Workspace conversation progress", () => {
  it("does not keep the loader active for an idle draft after validation fails", () => {
    expect(isConversationProgressActive(conversation({ planStatus: "drafting" }))).toBe(false);
    expect(isConversationProgressActive(conversation({ planStatus: "validating" }))).toBe(false);
  });

  it("keeps the loader for an active run or executing plan", () => {
    expect(
      isConversationProgressActive(
        conversation({ activeRunStatus: "running", planStatus: "drafting" })
      )
    ).toBe(true);
    expect(isConversationProgressActive(conversation({ planStatus: "executing" }))).toBe(true);
  });
});
