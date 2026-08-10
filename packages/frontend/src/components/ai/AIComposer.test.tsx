import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AIConversationInput } from "@/types/ai";
import { AIQueuedMessages } from "./AIComposer";

const queuedInput: AIConversationInput = {
  id: "queued-1",
  conversationId: "conversation-1",
  targetRunId: "run-1",
  userId: "user-1",
  clientCommandId: "command-1",
  mode: "queued",
  status: "pending",
  content: "Use port 8081 instead",
  attachments: [],
  context: null,
  consumedAt: null,
  createdAt: "2026-08-11T00:00:00.000Z",
  updatedAt: "2026-08-11T00:00:00.000Z",
};

describe("AIQueuedMessages", () => {
  it("renders queued actions in a separate compact block", () => {
    const onSendNow = vi.fn();
    const onEdit = vi.fn();
    const onRemove = vi.fn();

    render(
      <AIQueuedMessages
        items={[queuedInput]}
        onSendNow={onSendNow}
        onEdit={onEdit}
        onRemove={onRemove}
      />
    );

    expect(
      screen.getAllByRole("button").map((button) => button.getAttribute("aria-label"))
    ).toEqual(["Edit queued message", "Remove queued message", null]);

    fireEvent.click(screen.getByRole("button", { name: "Edit queued message" }));
    fireEvent.click(screen.getByRole("button", { name: /Send now/i }));
    fireEvent.click(screen.getByRole("button", { name: "Remove queued message" }));

    expect(onEdit).toHaveBeenCalledWith(queuedInput);
    expect(onSendNow).toHaveBeenCalledWith("queued-1");
    expect(onRemove).toHaveBeenCalledWith("queued-1");
  });
});
