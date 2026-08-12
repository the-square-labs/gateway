import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AIMessage, AIPlanRuntimeSnapshot } from "@/types/ai";
import { AIPlanTimeline, getPlanInsertionIndex } from "./AIPlanTimeline";

const plan: AIPlanRuntimeSnapshot = {
  id: "plan-1",
  conversationId: "conversation-1",
  status: "executing",
  title: "Implementation plan",
  model: "test-model",
  reasoningEffort: "medium",
  revisionId: "revision-1",
  revision: 1,
  revisionStatus: "accepted",
  publishedAt: "2026-08-12T00:02:00.000Z",
  timelineAnchorAt: "2026-08-12T00:02:00.000Z",
  acceptedAt: "2026-08-12T00:03:00.000Z",
  goal: "Implement and verify the request.",
  scope: [],
  assumptions: [],
  research: [],
  intentReview: null,
  securityReview: null,
  verification: [],
  changeSummary: null,
  steps: [],
  noProgressRuns: 0,
  activeTimeMs: 0,
  activeSince: null,
  pauseReason: null,
  createdAt: "2026-08-12T00:00:00.000Z",
  updatedAt: "2026-08-12T00:04:00.000Z",
};

const messages: AIMessage[] = [
  {
    id: "planning-message",
    role: "assistant",
    content: "Planning research",
    createdAt: "2026-08-12T00:01:00.000Z",
  },
  {
    id: "implementation-message",
    role: "assistant",
    content: "Implementation started",
    createdAt: "2026-08-12T00:03:30.000Z",
  },
];

describe("AIPlanTimeline", () => {
  it("keeps the published plan between planning and implementation messages", () => {
    render(<AIPlanTimeline messages={messages} plans={[plan]} />);

    const planning = screen.getByText("Planning research");
    const planHeading = screen.getByRole("heading", { name: "Implementation plan" });
    const implementation = screen.getByText("Implementation started");

    expect(
      planning.compareDocumentPosition(planHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      planHeading.compareDocumentPosition(implementation) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      getPlanInsertionIndex(messages, { ...plan, updatedAt: "2027-01-01T00:00:00.000Z" })
    ).toBe(1);
  });

  it("keeps a refined plan at its first published position", () => {
    expect(
      getPlanInsertionIndex(messages, {
        ...plan,
        revisionId: "revision-2",
        revision: 2,
        publishedAt: "2026-08-12T00:04:00.000Z",
      })
    ).toBe(1);
  });

  it("keeps every published plan in the conversation timeline", () => {
    const secondPlan: AIPlanRuntimeSnapshot = {
      ...plan,
      id: "plan-2",
      revisionId: "revision-2",
      title: "Follow-up plan",
      publishedAt: "2026-08-12T00:04:00.000Z",
      timelineAnchorAt: "2026-08-12T00:04:00.000Z",
      createdAt: "2026-08-12T00:03:45.000Z",
    };

    render(<AIPlanTimeline messages={messages} plans={[plan, secondPlan]} />);

    expect(screen.getByRole("heading", { name: "Implementation plan" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Follow-up plan" })).toBeInTheDocument();
  });
});
