import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DockerAvailabilityPolicy, DockerComposeOperation } from "@/types";
import { AvailabilityProgress, isAvailabilityReplacing } from "./AvailabilityProgress";

function policy(status: string, type = "rollout") {
  return {
    mode: "replicated",
    status: "healthy",
    placements: [],
    latestOperation: {
      id: "operation",
      type,
      status,
      phase: "checking_health",
      progress: { message: "Waiting for all services", completedPlacements: 1, totalPlacements: 2 },
      createdAt: new Date(Date.now() - 20000).toISOString(),
      errorMessage: "Node temporarily unavailable",
    },
  } as unknown as DockerAvailabilityPolicy;
}

describe("Availability replacement progress", () => {
  it("uses one compact panel through the Compose-to-HA handoff", () => {
    const operation = {
      action: "pull_apply",
      progress: "Running pull_apply through Availability",
    } as DockerComposeOperation;
    const view = render(<AvailabilityProgress fallbackOperation={operation} />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Running pull apply through Availability");
    view.rerender(
      <AvailabilityProgress policy={policy("running")} fallbackOperation={operation} />
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for all services");
    expect(screen.getByRole("status")).not.toHaveTextContent("through Availability");
  });
  it("blocks runtime access for a waiting rollout even when the old policy status says healthy", () => {
    expect(isAvailabilityReplacing(policy("waiting"))).toBe(true);
    expect(isAvailabilityReplacing(policy("completed"))).toBe(false);
    expect(isAvailabilityReplacing(policy("running", "stale_cleanup"))).toBe(false);
  });

  it("shows the real phase, placement count, elapsed time and waiting reason", () => {
    render(<AvailabilityProgress policy={policy("waiting")} />);
    expect(screen.getByRole("status")).toHaveTextContent("Waiting for all services");
    expect(screen.getByRole("status")).toHaveTextContent("1/2 placements ready");
    expect(screen.getByRole("status")).toHaveTextContent("20s elapsed");
    expect(screen.getByRole("status")).toHaveTextContent("Node temporarily unavailable");
  });
});
