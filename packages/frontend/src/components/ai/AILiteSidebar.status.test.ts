import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { AIConversationSummary } from "@/services/ai-conversations";
import {
  AIConversationStatusIndicator,
  isConversationProgressActive,
} from "./AIConversationStatusIndicator";

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

  it("uses the canonical loader for active work", () => {
    render(
      createElement(AIConversationStatusIndicator, {
        conversation: conversation({ activeRunStatus: "running", planStatus: "drafting" }),
      })
    );

    expect(screen.getByRole("progressbar", { name: "Work Session in progress" })).toBeVisible();
  });

  it("uses the canonical attention icon for conversations waiting on the user", () => {
    const { container } = render(
      createElement(AIConversationStatusIndicator, {
        conversation: conversation({ activeRunStatus: "waiting_for_answer" }),
      })
    );

    expect(container.querySelector(".lucide-circle-alert")).toHaveClass("text-warning-foreground");
  });

  it("uses the canonical default and locked icons for idle conversations", () => {
    const active = render(
      createElement(AIConversationStatusIndicator, { conversation: conversation() })
    );
    expect(active.container.querySelector(".lucide-message-square")).toBeInTheDocument();
    active.unmount();

    const archived = render(
      createElement(AIConversationStatusIndicator, {
        conversation: conversation({ status: "ended" }),
      })
    );
    expect(archived.container.querySelector(".lucide-lock")).toBeInTheDocument();
  });
});
