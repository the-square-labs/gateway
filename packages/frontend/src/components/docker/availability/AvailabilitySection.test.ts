import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isAvailabilityTransition, resolveAvailabilitySurfaceStatus } from "./availability-status";

const sharedImport = "@/components/docker/availability/AvailabilitySection";
const sharedSummaryImport = "@/components/docker/availability/AvailabilitySummary";

function source(relativePath: string) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("shared Docker Availability composition", () => {
  it.each([
    ["Container", "../../../pages/docker-detail/SettingsTab.tsx"],
    ["Deployment", "../../../pages/docker-deployment-detail/DeploymentSettings.tsx"],
    ["Compose", "../../../pages/DockerComposeProjectDetail.tsx"],
  ])("reuses the shared Availability section on the %s settings surface", (_name, path) => {
    const contents = source(path);
    expect(contents).toContain(sharedImport);
    expect(contents).toContain("<AvailabilitySection");
  });

  it("keeps all Availability UI implementation in the shared domain component", () => {
    const contents = source("./AvailabilitySection.tsx");
    const operations = source("./AvailabilityOperationsPanel.tsx");
    expect(contents).toContain("SettingsControlRow");
    expect(contents).toContain("PanelShell");
    expect(contents).toContain("Placements");
    expect(contents).not.toContain('title="Operations"');
    expect(operations).toContain('title="Operations"');
    expect(operations).toContain("View all");
    expect(operations).toContain("fixedRowHeight={49}");
    expect(operations).toContain("IntersectionObserver");
    expect(contents).toContain("Maximum unavailable");
    expect(contents).toContain("Maximum surge");
    expect(contents).toContain("Drain interval");
    expect(contents).toContain('title="Enable"');
    expect(contents).toContain("<Switch");
    expect(contents).toContain('size="inline"');
    expect(contents).toContain("<Save />");
    expect(contents).toContain('policy.status !== "disabling"');
    expect(contents).not.toContain("Swarm");
    expect(contents).not.toContain('size="sm"');
    expect(contents).not.toContain('className="h-3.5 w-3.5');
    expect(contents).not.toContain('<SettingsInlineControl label="Availability mode">');
    expect(contents).not.toContain('<SettingsInlineControl label="Replicas">');
    expect(contents).not.toContain('<SettingsInlineControl label="Node selection">');
    expect(contents).not.toContain('<SettingsInlineControl label="Seconds">');
    expect(contents).not.toContain('<SettingsInlineControl label="Placements">');
    expect(contents).not.toContain("Desired serving placements are healthy.");
    expect(contents).toContain('help="Replicated serves traffic from multiple nodes');
    expect(contents).toContain('help="Gateway waits this many seconds');
    expect(contents).not.toContain("<Layers3");
    expect(contents).not.toContain("<Boxes");
    expect(contents).not.toContain("<Server");
    expect(contents).not.toContain("<Timer");
    expect(contents).toContain('placement.actualState !== "serving"');
    expect(contents).not.toContain("Workload configuration");
    expect(contents).not.toContain("bg-destructive/5");
    expect(contents).not.toContain("bg-warning/5");
    expect(contents).toContain('toast.error("Availability check failed"');
    expect(contents).toContain('toast.warning("Availability check passed with warnings"');
    expect(contents).toContain("resolveAvailabilitySurfaceStatus");
    expect(contents).not.toContain("AvailabilityOperationsPanel");
    expect(operations).toContain("operation.targetGeneration < desiredGeneration");
    expect(operations).toContain(
      "return retryable && operation.targetGeneration < desiredGeneration"
    );
    expect(operations).toContain("limit: 5");
    expect(operations).toContain("result.data.slice(0, 5)");
    expect(operations).toContain("limit: 50");
    expect(operations).toContain("DataTable");
    expect(operations).toContain("IntersectionObserver");
    expect(operations).not.toContain("row.errorMessage ||");
  });

  it("never presents a zero-serving Availability policy as healthy", () => {
    const contents = source("./AvailabilitySummary.tsx");
    expect(contents).toContain("resolveAvailabilitySurfaceStatus");
    expect(contents).toContain('"offline"');
    expect(contents).toContain('size="inline"');
    expect(contents).toContain("toast.error");
    expect(contents).not.toContain('label="Attention"');
  });

  it("keeps Availability settings reachable after the standalone origin moves during failover", () => {
    const contents = source("../../../pages/DockerContainerDetail.tsx");
    const settings = source("../../../pages/docker-detail/SettingsTab.tsx");
    expect(contents).toContain("availabilityManaged");
    expect(contents).toContain("(!unavailable || availabilityManaged)");
    expect(settings).toContain("<AvailabilitySection");
    expect(contents).toContain("availabilityRuntimePlacement");
    expect(contents).toContain("managementContainerId");
    expect(contents).toContain("availabilityPolicy?.sourceImageReference");
  });

  it("presents every planned Availability mutation as one stable rolling-out state", () => {
    for (const status of ["enabling", "scaling", "rolling_out", "disabling"]) {
      expect(isAvailabilityTransition(status)).toBe(true);
      expect(
        resolveAvailabilitySurfaceStatus({
          policyStatus: status,
          shouldRun: true,
          serving: 0,
          desired: 2,
        })
      ).toBe("rolling_out");
    }
    expect(
      resolveAvailabilitySurfaceStatus({
        policyStatus: "healthy",
        shouldRun: true,
        serving: 2,
        desired: 2,
      })
    ).toBe("online");
  });

  it.each([
    ["Container", "../../../pages/docker-detail/OverviewTab.tsx"],
    ["Deployment", "../../../pages/docker-deployment-detail/DeploymentPanels.tsx"],
    ["Compose", "../../../pages/DockerComposeProjectDetail.tsx"],
  ])("reuses the shared Availability summary on the %s overview surface", (_name, path) => {
    const contents = source(path);
    expect(contents).toContain(sharedSummaryImport);
    expect(contents).toContain("<AvailabilitySummary");
  });

  it("uses the standard settings section gap for Availability and Placements everywhere", () => {
    const contents = source("./AvailabilitySection.tsx");
    expect(contents).toContain('<div className="flex flex-col gap-6">');
    for (const path of [
      "../../../pages/docker-detail/SettingsTab.tsx",
      "../../../pages/docker-deployment-detail/DeploymentSettings.tsx",
      "../../../pages/DockerComposeProjectDetail.tsx",
    ]) {
      expect(source(path)).toContain("<AvailabilitySection");
    }
  });

  it("uses logical Availability state instead of origin-node drift in the Compose header", () => {
    const contents = source("../../../pages/DockerComposeProjectDetail.tsx");
    expect(contents).toContain("availabilityStatus");
    expect(contents).toContain("logicalServiceCount");
    expect(contents).toContain(
      "const displayedDrift = availabilityActive ? false : project.drifted"
    );
    expect(contents).toContain(
      'availabilityStatus ?? (project.drifted ? "Drift" : project.status)'
    );
    expect(contents).toContain('displayedDrift ? "Detected" : "None"');
  });

  it("uses the shared shell and stable sentence-case headers for deployment slots", () => {
    const contents = source("../../../pages/docker-deployment-detail/DeploymentPanels.tsx");
    const slots = contents.slice(
      contents.indexOf("export function DeploymentSlots"),
      contents.indexOf("function ReleaseRow")
    );
    expect(contents).toContain('import { PanelShell } from "@/components/common/PanelShell"');
    expect(slots).toContain(
      "title={`" + "$" + "{slot.slot[0].toUpperCase()}" + "$" + "{slot.slot.slice(1)} slot`}"
    );
    expect(slots).toContain('headerClassName="min-h-[4.25rem]"');
    expect(slots).toContain('? "border-white" : undefined');
    expect(slots).toContain("const activeSlot = activeSlotOverride ?? deployment.activeSlot");
    expect(slots).toContain("const inspect = slotInspects?.[slot.slot]");
    expect(slots).toContain("statusVariant(status)");
    expect(slots).not.toContain("$" + '{actions ? "py-3" : "py-4"}');
  });
});
