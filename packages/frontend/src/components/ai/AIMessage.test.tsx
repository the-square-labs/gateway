import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AIMessage as AIMessageType, AIToolCall } from "@/types/ai";
import { AIMessage } from "./AIMessage";

function toolCall(id: string, status: AIToolCall["status"] = "completed"): AIToolCall {
  return {
    id,
    name: id === "tool-3" ? "read_process_output" : "find_resource",
    arguments: { query: id },
    status,
    result: { ok: true },
  };
}

function message(toolCalls: AIToolCall[]): AIMessageType {
  return {
    id: "assistant-1",
    role: "assistant",
    content: "",
    isStreaming: true,
    toolCalls,
  };
}

function artifactToolCall(): AIToolCall {
  return {
    id: "artifact-1",
    name: "send_artifact",
    arguments: { path: "generated.txt" },
    status: "completed",
    result: {
      artifactId: "artifact-id",
      filename: "generated.txt",
      mediaType: "text/plain",
      sizeBytes: 25,
      downloadUrl: "/api/ai/sandbox/artifacts/artifact-id/download",
    },
  };
}

describe("AIMessage tool call groups", () => {
  it("does not crash when a restored user message has no generated id timestamp", () => {
    render(
      <AIMessage
        message={
          {
            role: "user",
            content: "Show health summary",
          } as AIMessageType
        }
      />
    );

    expect(screen.getByText("Show health summary")).toBeInTheDocument();
  });

  it("does not render an empty local-only message bubble", () => {
    const { container } = render(
      <AIMessage
        message={{
          id: "local-empty",
          role: "assistant",
          content: "",
          localOnly: true,
        }}
      />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("renders run errors as left-aligned assistant blocks with retry", () => {
    const onRetry = vi.fn();
    render(
      <AIMessage
        message={{
          id: "run-error",
          role: "assistant",
          content: "**Error:** Provider quota is exhausted.",
          localOnly: true,
          runError: true,
        }}
        onRetry={onRetry}
      />
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Error: Provider quota is exhausted.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders local-only tool calls through the normal tool call UI", () => {
    render(
      <AIMessage
        message={{
          id: "local-tool",
          role: "assistant",
          content: "",
          localOnly: true,
          toolCalls: [toolCall("tool-1", "running")],
        }}
      />
    );

    expect(screen.getByRole("button", { name: /find resource/i })).toBeInTheDocument();
  });

  it("keeps an expanded completed tool group open when a new tool call appears", () => {
    const { rerender } = render(
      <AIMessage message={message([toolCall("tool-1"), toolCall("tool-2")])} />
    );

    fireEvent.click(screen.getByRole("button", { name: /called 2 tools/i }));
    expect(screen.getAllByRole("button", { name: /find resource/i })).toHaveLength(2);

    rerender(
      <AIMessage
        message={message([toolCall("tool-1"), toolCall("tool-2"), toolCall("tool-3", "running")])}
      />
    );

    expect(screen.getAllByRole("button", { name: /find resource/i })).toHaveLength(2);
    expect(screen.getByRole("button", { name: /read process output/i })).toBeInTheDocument();
  });

  it("shows artifact attachments only after the assistant turn finishes", () => {
    const streamingMessage: AIMessageType = {
      id: "assistant-2",
      role: "assistant",
      content: "Готовлю файл.",
      isStreaming: true,
      toolCalls: [artifactToolCall()],
    };

    const { rerender } = render(<AIMessage message={streamingMessage} />);
    expect(screen.getByText("Готовлю файл.")).toBeInTheDocument();
    expect(screen.queryByText("generated.txt")).not.toBeInTheDocument();

    rerender(<AIMessage message={{ ...streamingMessage, isStreaming: false }} />);
    expect(screen.getByText("Готовлю файл.")).toBeInTheDocument();
    expect(screen.getByText("generated.txt")).toBeInTheDocument();
  });

  it("separates consecutive markdown tables", () => {
    const { container } = render(
      <AIMessage
        message={{
          id: "assistant-tables",
          role: "assistant",
          content: `| Field | Value |
| --- | --- |
| Name | Main |

| Capability | Enabled |
| --- | --- |
| Projects | yes |`,
        }}
      />
    );

    const tableWrappers = [...container.querySelectorAll("table")].map(
      (table) => table.parentElement
    );
    expect(tableWrappers).toHaveLength(2);
    expect(tableWrappers.every((wrapper) => wrapper?.classList.contains("my-3"))).toBe(true);
  });

  it("renders running compact context with the thinking shimmer", () => {
    const { container } = render(
      <AIMessage
        message={message([
          {
            id: "compact-tool",
            name: "compact_context",
            arguments: { trigger: "manual" },
            status: "running",
          },
        ])}
      />
    );

    const compactButton = screen.getByRole("button", { name: /compact context/i });
    expect(compactButton).toBeInTheDocument();
    expect(compactButton.querySelector(".thinking-shimmer")).toBeInTheDocument();
    expect(container).not.toHaveTextContent("trigger");
  });

  it("opens completed compact context summaries from tool results", () => {
    render(
      <AIMessage
        message={{
          id: "assistant-compact",
          role: "assistant",
          content: "",
          isStreaming: false,
          toolCalls: [
            {
              id: "compact-tool",
              name: "compact_context",
              arguments: { trigger: "manual" },
              status: "completed",
              result: {
                compacted: true,
                summary: "Старый контекст сжат и сохранён.",
                trigger: "manual",
              },
            },
          ],
        }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /compact context/i }));

    expect(screen.getByText("Старый контекст сжат и сохранён.")).toBeInTheDocument();
    expect(screen.queryByText(/manual/)).not.toBeInTheDocument();
  });

  it("does not show waiting for response after a question already has an answer", () => {
    render(
      <AIMessage
        message={{
          id: "assistant-question",
          role: "assistant",
          content: "",
          isStreaming: true,
          toolCalls: [
            {
              id: "question-1",
              name: "ask_question",
              arguments: { question: "Continue?" },
              status: "awaiting_approval",
              result: { answer: "yes" },
            },
          ],
        }}
      />
    );

    expect(screen.queryByText("Waiting for response")).not.toBeInTheDocument();
  });

  it("keeps thinking visible while a progress comment is active", () => {
    render(
      <AIMessage
        message={{
          id: "run-1:comment:1",
          role: "assistant",
          content: "Проверяю конфигурацию.",
          isStreaming: true,
        }}
      />
    );

    expect(screen.getByText("Проверяю конфигурацию.")).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });
});
