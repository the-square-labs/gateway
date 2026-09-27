import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { DockerAvailabilityPolicy } from "@/types";
import { AvailabilitySummary } from "./AvailabilitySummary";

vi.mock("./AvailabilityOperationsPanel", () => ({
  AvailabilityOperationsPanel: () => <div>Operations</div>,
}));

function policy(operationStatus: "running" | "failed") {
  return {
    id: "policy-1",
    mode: "replicated",
    shouldRun: true,
    desiredReplicaCount: 2,
    desiredGeneration: 3,
    status: "healthy",
    lastErrorMessage: null,
    placements: [
      { actualState: "serving", serving: true, applicationHealth: "healthy" },
      { actualState: "serving", serving: true, applicationHealth: "healthy" },
    ],
    latestOperation: {
      type: "heal",
      status: operationStatus,
      phase: "preparing_images",
    },
  } as never;
}

describe("AvailabilitySummary", () => {
  it.each<DockerAvailabilityPolicy | null>([
    null,
    { ...(policy("failed") as DockerAvailabilityPolicy), mode: "single", placements: [] },
  ])("tracks single-node stop/start without waiting for a policy update (%j)", (singlePolicy) => {
    const props = {
      resource: { type: "deployment" as const, deploymentId: "deployment-1" },
      policy: singlePolicy,
      loading: false,
    };
    const { rerender } = render(<AvailabilitySummary {...props} runtimeState="running" />);
    const serving = () => within(screen.getByText("Serving").parentElement!);
    const health = () => within(screen.getByText("Placement health").parentElement!);
    expect(serving().getByText("1/1")).toBeInTheDocument();
    rerender(<AvailabilitySummary {...props} runtimeState="stopped" />);
    expect(serving().getByText("Stopped")).toBeInTheDocument();
    expect(health().getByText("Stopped")).toBeInTheDocument();
    expect(screen.queryByText("Healthy")).not.toBeInTheDocument();
    rerender(<AvailabilitySummary {...props} runtimeState="running" />);
    expect(serving().getByText("1/1")).toBeInTheDocument();
    expect(health().getByText("Healthy")).toBeInTheDocument();
  });

  it("keeps HA policy authoritative when one runtime is stopped", () => {
    render(
      <AvailabilitySummary
        resource={{ type: "deployment", deploymentId: "deployment-1" }}
        policy={policy("failed")}
        runtimeState="stopped"
      />
    );
    expect(screen.getByText("2/2")).toBeInTheDocument();
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.queryByText("Stopped")).not.toBeInTheDocument();
  });

  it("shows neutral stopped health instead of stale unhealthy placement alerts", () => {
    const stopped = { ...(policy("failed") as DockerAvailabilityPolicy), shouldRun: false };
    stopped.placements = stopped.placements.map((placement) => ({
      ...placement,
      serving: false,
      applicationHealth: "unhealthy",
    }));
    render(
      <AvailabilitySummary
        resource={{ type: "deployment", deploymentId: "deployment-1" }}
        policy={stopped}
        loading={false}
      />
    );
    const row = screen.getByText("Placement health").parentElement!;
    expect(within(row).getByText("Stopped")).toBeInTheDocument();
    expect(screen.queryByText(/need attention/)).not.toBeInTheDocument();
  });

  it("does not present a finished failed operation as current", () => {
    render(
      <AvailabilitySummary
        resource={{ type: "deployment", deploymentId: "deployment-1" }}
        policy={policy("failed")}
        loading={false}
      />
    );

    const row = screen.getByText("Current operation").parentElement;
    expect(row).not.toBeNull();
    expect(within(row as HTMLElement).getByText("—")).toBeInTheDocument();
  });

  it("shows an actually running operation as current", () => {
    render(
      <AvailabilitySummary
        resource={{ type: "deployment", deploymentId: "deployment-1" }}
        policy={policy("running")}
        loading={false}
      />
    );

    expect(screen.getByText("Heal · Preparing Images")).toBeInTheDocument();
  });

  it("shows the lease mode, reason, holder and an insufficient voter margin warning", async () => {
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [{ id: "node-a", displayName: "Node A", type: "docker", status: "online" }],
    } as never);
    const leasePolicy = {
      ...(policy("failed") as DockerAvailabilityPolicy),
      lease: {
        mode: "bootstrapping",
        reason: { code: "voter_config_pending", message: "Waiting for the voter configuration" },
        manifestVersion: 3,
        epoch: 2,
        publishedPartitionMode: "strict",
        holders: [
          {
            slot: 0,
            holderNodeId: "node-a",
            placementId: "placement-1",
            ballot: null,
            observedAt: "2026-09-28T00:00:00.000Z",
            holderSince: "2026-09-28T00:00:00.000Z",
            source: "daemon",
          },
        ],
        bootstrap: [],
        strictPending: false,
        copiesStoppedAt: null,
        voterMargin: { epoch: 2, joint: false, voters: 5, reachable: 3, required: 3, margin: 0 },
        witness: {
          memberId: "node-b",
          kind: "node",
          auto: true,
          minRttMs: 1,
          warning: "same_site",
        },
      },
    } as DockerAvailabilityPolicy;

    render(
      <AvailabilitySummary
        resource={{ type: "deployment", deploymentId: "deployment-1" }}
        policy={leasePolicy}
        loading={false}
      />
    );

    expect(screen.getByText("Lease mode")).toBeInTheDocument();
    expect(screen.getByText("Bootstrapping")).toBeInTheDocument();
    expect(await screen.findByText("Node A")).toBeInTheDocument();
    expect(screen.getByText(/Voter reachability margin is insufficient/)).toBeInTheDocument();
    expect(screen.getByText("Witness")).toBeInTheDocument();
    expect(
      screen.getByText(/witness is likely on the same site as a candidate/)
    ).toBeInTheDocument();
  });
});
