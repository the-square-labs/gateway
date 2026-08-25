import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
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
  it("prefers a canonical conversation resource label over a message hash fallback", () => {
    const refId = "gwr_0123456789abcdef01234567";
    render(
      <MemoryRouter>
        <AIMessage
          message={{
            id: "assistant-resource",
            role: "assistant",
            content: `Контейнер [[resource:${refId}|527b02985e9b37cf9252b29f01de321f]].`,
            resourceReferences: [
              {
                refId,
                type: "docker_container",
                resourceId: "527b02985e9b37cf9252b29f01de321f",
                label: "527b02985e9b37cf9252b29f01de321f",
                relation: "verified",
                nodeSlug: "docker-src",
              },
            ],
          }}
          resourceReferences={[
            {
              refId,
              type: "docker_container",
              resourceId: "527b02985e9b37cf9252b29f01de321f",
              label: "ai-e2e-restart",
              relation: "read",
              nodeSlug: "docker-src",
            },
          ]}
        />
      </MemoryRouter>
    );

    expect(screen.getByRole("link", { name: "Container: ai-e2e-restart" })).toHaveAttribute(
      "href",
      "/docker/containers/docker-src/ai-e2e-restart"
    );
    expect(screen.queryByText("527b02985e9b37cf9252b29f01de321f")).not.toBeInTheDocument();
  });

  it("repairs a stored proxy host collection href and renders its marker as wrapping inline text", () => {
    const refId = "gwr_abcdef0123456789abcdef01";
    render(
      <MemoryRouter>
        <AIMessage
          message={{
            id: "assistant-proxy-resource",
            role: "assistant",
            content: `Host [[resource:${refId}|additional-e2e.test, additional-e2e.localhost]] is unavailable.`,
            resourceReferences: [
              {
                refId,
                type: "proxy_host",
                resourceId: "fa2f2344-7d51-41d3-8945-7b2b9ec3a1ea",
                label: "additional-e2e.test, additional-e2e.localhost",
                relation: "read",
                uiHref: "/proxy-hosts",
              },
            ],
          }}
        />
      </MemoryRouter>
    );

    const link = screen.getByRole("link", { name: "Proxy host: additional-e2e.test" });
    expect(link).toHaveAttribute("href", "/proxy-hosts/fa2f2344-7d51-41d3-8945-7b2b9ec3a1ea");
    expect(link).toHaveClass("inline", "box-decoration-clone", "[overflow-wrap:anywhere]");
    expect(link).not.toHaveClass("inline-flex");
    expect(link).toHaveTextContent("additional-e2e.test");
    expect(link).not.toHaveTextContent("additional-e2e.localhost");
  });

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

  it("marks a steer while it waits for the next model boundary", () => {
    const { container } = render(
      <AIMessage
        message={{
          id: "steer-1",
          role: "user",
          content: "Use port 8081 instead",
          steer: true,
          steerPending: true,
        }}
      />
    );

    expect(screen.getByText("Steer · waiting for next step")).toBeInTheDocument();
    expect(screen.getByText("Steer · waiting for next step").parentElement).toHaveClass(
      "opacity-0",
      "group-hover:opacity-100"
    );
    expect(container.querySelectorAll(".absolute.right-0.top-full")).toHaveLength(1);
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

    const alert = screen.getByRole("alert");
    const retry = screen.getByRole("button", { name: "Retry" });
    expect(alert).toHaveTextContent("Error: Provider quota is exhausted.");
    expect(alert).toHaveAttribute("data-ai-timeline-divider");
    expect(alert).toHaveClass("py-3");
    expect(retry).toHaveClass("text-primary");
    fireEvent.click(retry);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("reveals completed live comments in random one-to-three-word batches", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.99);
    const { container } = render(
      <AIMessage
        message={{
          id: "run-1:comment:1",
          role: "assistant",
          content: "One two three four five",
          streamingChunk: "One two three four five",
          isStreaming: false,
        }}
      />
    );

    expect(container).not.toHaveTextContent("One");
    act(() => vi.advanceTimersByTime(55));
    expect(container).toHaveTextContent("One");
    expect(container).not.toHaveTextContent("two");
    expect(container.querySelector(".ai-streaming-chunk")).toHaveTextContent("One");

    act(() => vi.advanceTimersByTime(55));
    expect(container).toHaveTextContent("One two three four");
    expect(container).not.toHaveTextContent("five");

    act(() => vi.advanceTimersByTime(240));
    expect(container).toHaveTextContent("One two three four five");
    vi.useRealTimers();
    vi.restoreAllMocks();
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

  it("unmounts collapsed tool details only after the close animation", async () => {
    render(
      <AIMessage message={message([toolCall("animation-tool-1"), toolCall("animation-tool-2")])} />
    );

    const group = screen.getByRole("button", { name: /called 2 tools/i });
    fireEvent.click(group);
    expect(screen.getAllByRole("button", { name: /find resource/i })).toHaveLength(2);

    fireEvent.click(group);
    expect(screen.getAllByRole("button", { name: /find resource/i })).toHaveLength(2);
    await waitFor(
      () =>
        expect(screen.queryByRole("button", { name: /find resource/i })).not.toBeInTheDocument(),
      { timeout: 500 }
    );
  });

  it("keeps a manual tool group preference across changing first tool calls", () => {
    const { rerender } = render(
      <AIMessage message={message([toolCall("shifting-tool-1"), toolCall("shifting-tool-2")])} />
    );

    fireEvent.click(screen.getByRole("button", { name: /called 2 tools/i }));
    expect(screen.getByRole("button", { name: /called 2 tools/i })).toHaveAttribute(
      "aria-expanded",
      "true"
    );

    rerender(
      <AIMessage message={message([toolCall("shifting-tool-2"), toolCall("shifting-tool-3")])} />
    );
    expect(screen.getByRole("button", { name: /called 2 tools/i })).toHaveAttribute(
      "aria-expanded",
      "true"
    );

    fireEvent.click(screen.getByRole("button", { name: /called 2 tools/i }));
    rerender(
      <AIMessage message={message([toolCall("shifting-tool-1"), toolCall("shifting-tool-2")])} />
    );
    expect(screen.getByRole("button", { name: /called 2 tools/i })).toHaveAttribute(
      "aria-expanded",
      "false"
    );
  });

  it("keeps questions separate and does not group a single regular durable-round call", () => {
    render(
      <AIMessage
        message={message([
          {
            ...toolCall("question-1", "awaiting_approval"),
            roundId: "round-1",
            position: 0,
            name: "ask_question",
            arguments: { question: "Which target?" },
          },
          {
            ...toolCall("approval-1", "awaiting_approval"),
            roundId: "round-1",
            position: 1,
            name: "restart_docker_container",
          },
        ])}
      />
    );

    expect(screen.queryByRole("button", { name: /called 2 tools/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /ask question/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /restart docker container/i })).toBeInTheDocument();
    expect(screen.queryByText("Which target?")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("renders a single running tool directly without a one-item group", () => {
    render(<AIMessage message={message([toolCall("tool-3", "running")])} />);

    expect(screen.queryByRole("button", { name: /called 1 tool/i })).not.toBeInTheDocument();
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

  it("renders markdown while the assistant response is still streaming", () => {
    render(
      <AIMessage
        message={{
          id: "assistant-streaming-markdown",
          role: "assistant",
          content: "Доступно:\n\n- **Docker**\n- Базы данных",
          isStreaming: true,
          streamingChunk: "Базы данных",
        }}
      />
    );

    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Docker").tagName).toBe("STRONG");
    expect(screen.getByText("Базы данных")).toHaveClass("ai-streaming-chunk");
    expect(screen.getByText("Docker")).not.toHaveClass("ai-streaming-chunk");
  });

  it("renders a large provider delta immediately through the streaming animation", () => {
    const streamingMessage: AIMessageType = {
      id: "assistant-large-delta",
      role: "assistant",
      content: "One two three four five six seven eight nine ten eleven twelve",
      isStreaming: true,
      streamingChunk: "One two three four five six seven eight nine ten eleven twelve",
    };
    const { container } = render(<AIMessage message={streamingMessage} />);

    expect(container).toHaveTextContent(
      "One two three four five six seven eight nine ten eleven twelve"
    );
    expect(container.querySelector(".ai-streaming-chunk")).toBeInTheDocument();
  });

  it("waits for heading text before rendering a streaming heading", () => {
    const message: AIMessageType = {
      id: "assistant-streaming-heading",
      role: "assistant",
      content: "## ",
      isStreaming: true,
      streamingChunk: "## ",
    };
    const { rerender } = render(<AIMessage message={message} />);

    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(document.querySelector("p")).toHaveTextContent("##");

    rerender(
      <AIMessage message={{ ...message, content: "## Gateway", streamingChunk: "Gateway" }} />
    );
    expect(screen.getByRole("heading", { level: 2, name: "Gateway" })).toBeInTheDocument();
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

  it("shows waiting for approval instead of hiding the activity indicator", () => {
    render(
      <AIMessage
        message={{
          id: "assistant-approval",
          role: "assistant",
          content: "",
          isStreaming: true,
          toolCalls: [
            {
              id: "approval-1",
              name: "manage_docker_volume",
              arguments: { operation: "create", name: "data" },
              status: "awaiting_approval",
            },
          ],
        }}
      />
    );

    expect(screen.getByText("Waiting for approval")).toBeInTheDocument();
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
  });

  it("keeps thinking visible while a tool is running", () => {
    render(<AIMessage message={message([toolCall("tool-3", "running")])} />);

    expect(screen.getByText("Thinking")).toBeInTheDocument();
  });

  it("never renders send_comment as a user-visible tool or waiting state", () => {
    render(
      <AIMessage
        message={{
          id: "assistant-comment-control",
          role: "assistant",
          content: "Проверяю конфигурацию.",
          isStreaming: false,
          toolCalls: [
            {
              id: "tool-visible",
              name: "get_current_context",
              arguments: {},
              status: "completed",
            },
            {
              id: "tool-comment",
              name: "send_comment",
              arguments: { message: "Проверяю конфигурацию." },
              status: "running",
            },
          ],
        }}
      />
    );

    expect(screen.getByRole("button", { name: /Get Current Context/i })).toBeInTheDocument();
    expect(screen.queryByText(/Send Comment/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
  });
});
