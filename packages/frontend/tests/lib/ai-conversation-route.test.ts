import { describe, expect, it } from "vitest";
import { aiConversationRoute } from "../../src/lib/ai-conversation-route";

describe("aiConversationRoute", () => {
  it("builds a reloadable path for a conversation id", () => {
    expect(aiConversationRoute("conversation/id")).toBe("/ai/chats/conversation%2Fid");
  });
});
