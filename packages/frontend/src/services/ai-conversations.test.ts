import { beforeEach, describe, expect, it, vi } from "vitest";
import { listConversations } from "./ai-conversations";
import { api } from "./api";

vi.mock("./api", () => ({
  api: {
    listAIConversations: vi.fn(),
  },
}));

describe("AI conversation mappings", () => {
  beforeEach(() => {
    vi.mocked(api.listAIConversations).mockReset();
  });

  it("preserves plan status when loading the sidebar conversation list", async () => {
    vi.mocked(api.listAIConversations).mockResolvedValue([
      {
        id: "conversation-1",
        title: "Plan awaiting decision",
        createdAt: "2026-08-12T00:00:00.000Z",
        updatedAt: "2026-08-12T00:01:00.000Z",
        lastUserMessageAt: "2026-08-12T00:00:30.000Z",
        folderId: null,
        messageCount: 2,
        status: "active",
        blockReason: null,
        activeRunStatus: null,
        planStatus: "awaiting_decision",
      },
    ]);

    await expect(listConversations()).resolves.toMatchObject([
      { id: "conversation-1", planStatus: "awaiting_decision" },
    ]);
  });
});
