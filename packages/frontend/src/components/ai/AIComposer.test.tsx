import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { AIConversationInput, AIPlanRuntimeSnapshot } from "@/types/ai";
import { AIPlanBlock, AIPlanDecision, AIPlanProgress, AIQueuedMessages } from "./AIComposer";

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

const plan: AIPlanRuntimeSnapshot = {
  id: "plan-1",
  conversationId: "conversation-1",
  status: "awaiting_decision",
  title: "Configure the gateway",
  model: "gpt-5.6-luna",
  reasoningEffort: "medium",
  revisionId: "revision-1",
  revision: 1,
  revisionStatus: "published",
  publishedAt: "2026-08-11T00:01:00.000Z",
  timelineAnchorAt: "2026-08-11T00:01:00.000Z",
  acceptedAt: null,
  goal: "Configure and verify the requested gateway changes.",
  scope: ["Gateway configuration"],
  assumptions: [],
  research: [{ title: "Current state", summary: "The existing configuration was inspected." }],
  intentReview: { verdict: "pass", summary: "The plan matches the request.", findings: [] },
  securityReview: {
    verdict: "pass",
    summary: "No unsafe planning action is required.",
    findings: [],
  },
  verification: [{ title: "Runtime check", description: "Verify the resulting configuration." }],
  changeSummary: null,
  steps: [
    {
      id: "step-1",
      ordinal: 0,
      title: "1. Apply configuration",
      description: "Apply the requested configuration.",
      verification: "Inspect the resulting state.",
      status: "pending",
      evidence: [],
      skipReason: null,
      startedAt: null,
      completedAt: null,
    },
  ],
  noProgressRuns: 0,
  activeTimeMs: 65_000,
  activeSince: null,
  pauseReason: null,
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

describe("AIPlanBlock", () => {
  it("renders a published plan without embedding decision controls", () => {
    const { container } = render(<AIPlanBlock plan={plan} />);

    expect(screen.getByText("Configure the gateway")).toBeInTheDocument();
    expect(screen.getByText("Apply configuration")).toBeInTheDocument();
    expect(screen.queryByText("1. Apply configuration")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Implement plan" })).not.toBeInTheDocument();
    expect(container.firstElementChild?.children).toHaveLength(2);
    for (const block of Array.from(container.firstElementChild?.children ?? [])) {
      expect(block).toHaveClass("bg-muted/30");
    }
    expect(screen.getByText("Configure the gateway").closest("div.border-b")).toHaveClass(
      "bg-muted/50"
    );
  });
});

describe("AIPlanDecision", () => {
  it("exposes every decision path in a separate block", () => {
    const onImplement = vi.fn();
    const onRefine = vi.fn();
    const onCustom = vi.fn();

    render(<AIPlanDecision onImplement={onImplement} onRefine={onRefine} onCustom={onCustom} />);

    expect(screen.getByText("Implement this plan?")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Implement plan/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Refine details/ }));
    const customAnswer = screen.getByPlaceholderText("Or type your answer...");
    fireEvent.change(customAnswer, {
      target: { value: "Start with the proxy configuration" },
    });
    fireEvent.keyDown(customAnswer, { key: "Enter" });

    expect(onImplement).toHaveBeenCalledOnce();
    expect(onRefine).toHaveBeenCalledOnce();
    expect(onCustom).toHaveBeenCalledWith("Start with the proxy configuration");
  });
});

describe("AIPlanProgress", () => {
  it("shows a paused plan and resumes it from the existing progress block", () => {
    const onResume = vi.fn();
    const { container } = render(
      <AIPlanProgress
        plan={{ ...plan, status: "paused", pauseReason: "Waiting for credentials" }}
        onPause={vi.fn()}
        onResume={onResume}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByText("0/1 · 1:05")).toBeInTheDocument();
    expect(screen.getByText("Waiting for credentials")).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Plan progress" })).toHaveAttribute(
      "aria-valuenow",
      "0"
    );
    expect(container.firstElementChild).toHaveClass("bg-primary/5");
    fireEvent.click(screen.getByRole("button", { name: /Resume/i }));
    expect(onResume).toHaveBeenCalledOnce();
  });
});
