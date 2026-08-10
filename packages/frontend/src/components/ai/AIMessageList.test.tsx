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

  it("merges tool-only assistant boundaries created by approvals into one visual group", () => {
    render(
      <AIMessageList
        messages={[
          {
            id: "before-approval",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tool-1",
                name: "list_docker_volumes",
                arguments: {},
                status: "completed",
              },
            ],
          },
          {
            id: "after-approval",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tool-2",
                name: "create_docker_container",
                arguments: {},
                status: "failed",
                error: "No such image",
              },
            ],
          },
        ]}
      />
    );

    const groupButton = screen.getByRole("button", { name: "Called 2 tools, 1 failed" });
    expect(groupButton).toBeInTheDocument();
    expect(groupButton.parentElement).toContainElement(
      screen.getByRole("button", { name: /list docker volumes/i })
    );
  });

  it("keeps progress comments and following tools in the same compact assistant turn", () => {
    const { container } = render(
      <AIMessageList
        messages={[
          {
            id: "comment-1",
            role: "assistant",
            content: "Проверяю образ.",
          },
          {
            id: "tool-boundary-1",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "tool-1",
                name: "pull_docker_image",
                arguments: {},
                status: "completed",
              },
            ],
          },
        ]}
      />
    );

    const compactAssistantTurn = container.querySelector(".space-y-1");
    expect(compactAssistantTurn).toContainElement(screen.getByText("Проверяю образ."));
    expect(compactAssistantTurn).toContainElement(
      screen.getByRole("button", { name: /pull docker image/i })
    );
  });

  it("keeps Thinking visible after a completed progress comment while the run continues", () => {
    render(
      <AIMessageList
        isStreaming
        messages={[
          {
            id: "run-1:comment:1",
            role: "assistant",
            content: "Проверяю конфигурацию.",
            isStreaming: false,
          },
        ]}
      />
    );

    expect(screen.getByText("Проверяю конфигурацию.")).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });

  it("does not duplicate Thinking when the run already has a streaming placeholder", () => {
    render(
      <AIMessageList
        isStreaming
        messages={[
          {
            id: "run-1:runtime",
            role: "assistant",
            content: "",
            isStreaming: true,
          },
        ]}
      />
    );

    expect(screen.getAllByText("Thinking")).toHaveLength(1);
  });

  it("keeps one stable activity row while pending tools appear and complete", () => {
    const { rerender } = render(
      <AIMessageList
        isStreaming
        messages={[
          {
            id: "run-1:comment:1",
            role: "assistant",
            content: "Проверяю контейнер.",
            isStreaming: false,
          },
        ]}
      />
    );
    const activity = screen.getByTestId("ai-run-activity");
    expect(activity.parentElement).toHaveClass("space-y-1");

    rerender(
      <AIMessageList
        isStreaming
        messages={[
          {
            id: "run-1:comment:1",
            role: "assistant",
            content: "Проверяю контейнер.",
            isStreaming: false,
          },
          {
            id: "run-1:runtime",
            role: "assistant",
            content: "",
            isStreaming: true,
            toolCalls: [
              {
                id: "tool-pending",
                name: "get_docker_container",
                arguments: {},
                status: "running",
              },
            ],
          },
        ]}
      />
    );
    expect(screen.getByTestId("ai-run-activity")).toBe(activity);
    expect(screen.getByTestId("ai-run-activity").parentElement).toContainElement(
      screen.getByRole("button", { name: /get docker container/i })
    );
    expect(screen.getAllByText("Thinking")).toHaveLength(1);

    rerender(
      <AIMessageList
        isStreaming
        messages={[
          {
            id: "run-1:comment:1",
            role: "assistant",
            content: "Проверяю контейнер.",
            isStreaming: false,
          },
          {
            id: "run-1:runtime",
            role: "assistant",
            content: "",
            isStreaming: false,
            toolCalls: [
              {
                id: "tool-pending",
                name: "get_docker_container",
                arguments: {},
                status: "completed",
              },
            ],
          },
        ]}
      />
    );
    expect(screen.getByTestId("ai-run-activity")).toBe(activity);
    expect(screen.getAllByText("Thinking")).toHaveLength(1);
  });

  it("keeps a user-expanded tool group open when another assistant tool boundary arrives", () => {
    const firstMessages: AIMessage[] = [
      {
        id: "stable-group-boundary",
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "stable-group-tool-1", name: "find_resource", arguments: {}, status: "completed" },
          {
            id: "stable-group-tool-2",
            name: "list_docker_images",
            arguments: {},
            status: "completed",
          },
        ],
      },
    ];
    const { rerender } = render(<AIMessageList messages={firstMessages} />);

    fireEvent.click(screen.getByRole("button", { name: "Called 2 tools" }));
    expect(screen.getByRole("button", { name: "Called 2 tools" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );

    rerender(
      <AIMessageList
        messages={[
          ...firstMessages,
          {
            id: "new-tool-boundary",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "stable-group-tool-3",
                name: "pull_docker_image",
                arguments: {},
                status: "completed",
              },
            ],
          },
        ]}
      />
    );

    expect(screen.getByRole("button", { name: "Called 3 tools" })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
  });

  it("keeps a user-expanded tool open when it moves into an updated visual group", () => {
    const firstMessage: AIMessage = {
      id: "stable-tool-boundary",
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "stable-expanded-tool",
          name: "create_docker_container",
          arguments: { name: "demo" },
          status: "failed",
          error: "No such image",
        },
      ],
    };
    const { rerender } = render(<AIMessageList messages={[firstMessage]} />);

    fireEvent.click(screen.getByRole("button", { name: /create docker container/i }));
    expect(screen.getByRole("button", { name: /create docker container/i })).toHaveAttribute(
      "aria-expanded",
      "true"
    );

    rerender(
      <AIMessageList
        messages={[
          firstMessage,
          {
            id: "stable-tool-followup",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "stable-tool-followup-call",
                name: "pull_docker_image",
                arguments: {},
                status: "completed",
              },
            ],
          },
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Called 2 tools, 1 failed" }));
    expect(screen.getByRole("button", { name: /create docker container/i })).toHaveAttribute(
      "aria-expanded",
      "true"
    );
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
