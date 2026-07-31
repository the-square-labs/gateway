import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AIMessage } from "@/types/ai";
import { AIMessageList } from "./AIMessageList";

describe("AIMessageList", () => {
  it("groups assistant tool calls with the following assistant answer", () => {
    const messages: AIMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "Check databases",
      },
      {
        id: "tool-boundary-1",
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "tool-1",
            name: "find_resource",
            arguments: {},
            status: "completed",
          },
        ],
      },
      {
        id: "assistant-1",
        role: "assistant",
        content: "По базам сейчас так:",
      },
    ];

    const { container } = render(<AIMessageList messages={messages} />);

    expect(screen.getByRole("button", { name: /find resource/i })).toBeInTheDocument();
    expect(screen.getByText("По базам сейчас так:")).toBeInTheDocument();
    const compactAssistantTurn = container.querySelector(".space-y-1");
    expect(compactAssistantTurn).not.toBeNull();
    expect(compactAssistantTurn).toContainElement(
      screen.getByRole("button", { name: /find resource/i })
    );
    expect(compactAssistantTurn).toContainElement(screen.getByText("По базам сейчас так:"));
  });

  it("retries the user turn preceding a persisted run error", () => {
    const onRetryUserMessage = vi.fn();
    const messages: AIMessage[] = [
      {
        id: "user-1",
        role: "user",
        content: "Give me an overview",
      },
      {
        id: "assistant-error",
        role: "assistant",
        content: "**Error:** Provider rejected the request.",
        localOnly: true,
        runError: true,
      },
    ];

    render(<AIMessageList messages={messages} onRetryUserMessage={onRetryUserMessage} />);

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetryUserMessage).toHaveBeenCalledWith("user-1");
  });

  it("renders a persisted model change as a timeline divider", () => {
    const { container } = render(
      <AIMessageList
        messages={[
          {
            id: "model-change-1",
            role: "assistant",
            content: "",
            localOnly: true,
            modelChange: {
              fromModel: "model-a",
              toModel: "model-b",
              fromDisplayName: "Model A",
              toDisplayName: "Model B",
            },
          },
        ]}
      />
    );

    expect(screen.getByText("Model changed from Model A to Model B")).toBeInTheDocument();
    expect(container.querySelector(".lucide-box")).toBeInTheDocument();
  });

  it("renders only the latest divider from consecutive model changes", () => {
    render(
      <AIMessageList
        messages={[
          {
            id: "model-change-1",
            role: "assistant",
            content: "",
            localOnly: true,
            modelChange: {
              fromModel: "model-a",
              toModel: "model-b",
              fromDisplayName: "Model A",
              toDisplayName: "Model B",
            },
          },
          {
            id: "model-change-2",
            role: "assistant",
            content: "",
            localOnly: true,
            modelChange: {
              fromModel: "model-b",
              toModel: "model-c",
              fromDisplayName: "Model B",
              toDisplayName: "Model C",
            },
          },
        ]}
      />
    );

    expect(screen.queryByText("Model changed from Model A to Model B")).not.toBeInTheDocument();
    expect(screen.getByText("Model changed from Model B to Model C")).toBeInTheDocument();
  });

  it("hides a consecutive model-change chain that returns to its original model", () => {
    render(
      <AIMessageList
        messages={[
          {
            id: "model-change-1",
            role: "assistant",
            content: "",
            localOnly: true,
            modelChange: {
              fromModel: "model-a",
              toModel: "model-b",
              fromDisplayName: "Model A",
              toDisplayName: "Model B",
            },
          },
          {
            id: "model-change-2",
            role: "assistant",
            content: "",
            localOnly: true,
            modelChange: {
              fromModel: "model-b",
              toModel: "model-a",
              fromDisplayName: "Model B",
              toDisplayName: "Model A",
            },
          },
        ]}
      />
    );

    expect(screen.queryByText(/Model changed from/)).not.toBeInTheDocument();
  });
});
