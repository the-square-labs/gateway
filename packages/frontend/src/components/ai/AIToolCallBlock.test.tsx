import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { AIToolCallBlock, QuestionBlock } from "./AIToolCallBlock";

describe("AIToolCallBlock tool-output artifacts", () => {
  it("renders a bounded manifest and download action instead of dumping the descriptor", () => {
    renderWithRouter(
      <AIToolCallBlock
        toolCall={{
          id: "call-1",
          name: "get_docker_container_logs",
          arguments: { tail: 10_000 },
          status: "completed",
          result: {
            outputOffloaded: true,
            artifactId: "artifact-1",
            format: "text",
            sizeBytes: 2 * 1024 * 1024,
            estimatedTokens: 524_288,
            preview: "first log line",
            downloadUrl: "/api/ai/sandbox/artifacts/artifact-1/download",
            readTool: "read_tool_output",
            searchTool: "search_tool_output",
          },
        }}
      />
    );

    const toggle = screen.getByRole("button", { name: /Get Docker Container Logs/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Large output saved to this chat")).toBeInTheDocument();
    expect(screen.getByText(/2.0 MiB/)).toBeInTheDocument();
    expect(screen.getByText("first log line")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Download/i })).toHaveAttribute(
      "href",
      "/api/ai/sandbox/artifacts/artifact-1/download"
    );
    expect(screen.queryByText(/outputOffloaded/)).not.toBeInTheDocument();
  });

  it("does not render durable-round approval controls inside message history", () => {
    renderWithRouter(
      <AIToolCallBlock
        toolCall={{
          id: "call-approval",
          runId: "run-1",
          roundId: "round-1",
          position: 1,
          name: "restart_docker_container",
          arguments: { containerId: "container-1" },
          status: "awaiting_approval",
        }}
      />
    );

    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reject" })).not.toBeInTheDocument();
  });

  it("uses one red leading cross for a rejected call", () => {
    renderWithRouter(
      <AIToolCallBlock
        toolCall={{
          id: "call-rejected",
          name: "manage_docker_volume",
          arguments: { operation: "create", name: "data" },
          status: "rejected",
        }}
      />
    );

    const toolButton = screen.getByRole("button", { name: /Manage Docker Volume/i });
    const crosses = toolButton.querySelectorAll(".lucide-x");
    expect(crosses).toHaveLength(1);
    expect(crosses[0]).toHaveClass("text-destructive");
  });
});

describe("QuestionBlock", () => {
  it("names the free-text send action and keeps it inert until an answer is typed", async () => {
    const user = userEvent.setup();
    const onAnswer = vi.fn();
    renderWithRouter(
      <QuestionBlock
        toolCall={{
          id: "question-1",
          name: "ask_question",
          arguments: { question: "Which port?", allowFreeText: true },
          status: "awaiting_approval",
        }}
        onAnswer={onAnswer}
      />
    );

    const send = screen.getByRole("button", { name: "Send answer" });
    expect(send).toHaveAttribute("type", "button");
    expect(send).toBeDisabled();

    await user.type(screen.getByPlaceholderText("Type your answer..."), "8081");
    await user.click(send);

    expect(onAnswer).toHaveBeenCalledWith("question-1", "8081");
  });
});
