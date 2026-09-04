import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { AvailabilitySection, canKeepPlacement } from "./AvailabilitySection";
import { AvailabilitySummary } from "./AvailabilitySummary";

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));
vi.mock("@/stores/license-paywall", () => ({
  requireLicenseFeature: () => true,
  handleLicenseApiError: () => false,
}));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "getDockerAvailability").mockResolvedValue(null);
  vi.spyOn(api, "listNodes").mockResolvedValue({
    data: [
      { id: "one", type: "docker", status: "online" },
      { id: "two", type: "docker", status: "online" },
    ],
  } as never);
  vi.spyOn(api, "preflightDockerAvailability").mockResolvedValue({
    eligible: true,
    blockers: [],
    warnings: [],
  } as never);
  vi.spyOn(api, "enableDockerAvailability").mockResolvedValue({} as never);
});

describe("Availability public preview consent", () => {
  it.each([
    "removed",
    "stale",
    "cleanup_pending",
    "unreachable",
    "pending",
  ])("never offers %s as a stopped workload survivor", (actualState) => {
    expect(canKeepPlacement({ actualState } as never, false)).toBe(false);
  });
  it("allows a stopped surviving runtime", () => {
    expect(canKeepPlacement({ actualState: "stopped" } as never, false)).toBe(true);
  });
  it("explains unverified scenarios and workload validation on keyboard focus", async () => {
    render(
      <AvailabilitySection
        resource={{ type: "container", nodeId: "one", containerName: "app" }}
        canManage
      />
    );
    const badge = (await screen.findByText("Tech Preview")).closest("[tabindex]")!;
    expect(badge).toHaveAttribute("tabindex", "0");
    fireEvent.focus(badge);
    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("Not all scenarios and edge cases have been verified");
    expect(tooltip).toHaveTextContent("Validate it with your own workload before using it");
  });

  it("does not show a preview badge in the read-only Availability summary", () => {
    render(
      <AvailabilitySummary
        resource={{ type: "container", nodeId: "one", containerName: "app" }}
        policy={null}
      />
    );
    expect(screen.queryByText("Tech Preview")).not.toBeInTheDocument();
    expect(screen.queryByText("Beta Preview")).not.toBeInTheDocument();
  });

  it.each([
    "container",
    "deployment",
    "compose",
  ] as const)("requires confirmation before enabling %s HA", async (kind) => {
    const resource =
      kind === "container"
        ? { type: kind, nodeId: "one", containerName: "app" }
        : kind === "deployment"
          ? { type: kind, deploymentId: "deployment" }
          : { type: kind, composeProjectId: "project" };
    render(<AvailabilitySection resource={resource} canManage />);
    expect(await screen.findByText("Tech Preview")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Enable Availability" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(
      await screen.findByRole("dialog", { name: "Enable Availability Tech Preview?" })
    ).toBeInTheDocument();
    expect(api.enableDockerAvailability).not.toHaveBeenCalled();
    expect(api.preflightDockerAvailability).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(api.enableDockerAvailability).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    fireEvent.click(await screen.findByRole("button", { name: "Enable Tech Preview" }));
    await waitFor(() => expect(api.enableDockerAvailability).toHaveBeenCalledOnce());
  });
});
