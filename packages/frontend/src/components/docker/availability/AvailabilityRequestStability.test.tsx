import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { DockerAvailabilityPolicy } from "@/types";
import { AvailabilitySection } from "./AvailabilitySection";
import { AvailabilitySummary } from "./AvailabilitySummary";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

describe("Availability request stability", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "getDockerAvailability").mockResolvedValue(null);
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 0,
    });
  });

  it("does not refetch the summary when its parent recreates an equivalent resource prop", async () => {
    const { rerender } = render(
      <AvailabilitySummary resource={{ type: "deployment", deploymentId: "deployment-1" }} />
    );

    await screen.findByRole("heading", { name: "Availability" });
    expect(api.getDockerAvailability).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender(
        <AvailabilitySummary resource={{ type: "deployment", deploymentId: "deployment-1" }} />
      );
      await Promise.resolve();
    });

    expect(api.getDockerAvailability).toHaveBeenCalledTimes(1);
  });

  it("does not refetch settings when its parent recreates an equivalent resource prop", async () => {
    const { rerender } = render(
      <AvailabilitySection
        resource={{ type: "deployment", deploymentId: "deployment-1" }}
        canManage
      />
    );

    await waitFor(() => expect(api.listNodes).toHaveBeenCalledTimes(1));
    expect(api.getDockerAvailability).toHaveBeenCalledTimes(1);

    await act(async () => {
      rerender(
        <AvailabilitySection
          resource={{ type: "deployment", deploymentId: "deployment-1" }}
          canManage
        />
      );
      await Promise.resolve();
    });

    expect(api.getDockerAvailability).toHaveBeenCalledTimes(1);
    expect(api.listNodes).toHaveBeenCalledTimes(1);
  });

  it("keeps the Enable draft off while Availability is disabling", async () => {
    const disablingPolicy: DockerAvailabilityPolicy = {
      id: "policy-1",
      resourceKind: "deployment",
      originNodeId: null,
      sourceNodeId: null,
      containerName: null,
      deploymentId: "deployment-1",
      composeProjectId: null,
      displayName: "Deployment",
      specFingerprint: "fingerprint",
      imageReference: null,
      composeRevisionId: null,
      shouldRun: true,
      mode: "replicated",
      desiredReplicaCount: 2,
      nodeSelectionMode: "all_compatible",
      selectedNodeIds: [],
      desiredGeneration: 2,
      rolloutPolicy: { maxUnavailable: 0, maxSurge: 1, drainSeconds: 30 },
      offlineReplacementGraceSeconds: 15,
      status: "disabling",
      lastErrorCode: null,
      lastErrorMessage: null,
      placements: [],
      latestOperation: null,
    };
    vi.spyOn(api, "getDockerAvailability").mockResolvedValue(disablingPolicy);

    render(
      <AvailabilitySection
        resource={{ type: "deployment", deploymentId: "deployment-1" }}
        canManage
      />
    );

    const toggle = await screen.findByRole("button", { name: "Enable Availability" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toBeDisabled();
    expect(screen.getByText("Rolling Out")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
