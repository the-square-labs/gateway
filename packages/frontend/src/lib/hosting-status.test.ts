import { expect, it } from "vitest";
import type { HostingResource } from "@/types/hosting";
import {
  hostingNodeLabel,
  hostingOperationLabel,
  hostingPowerLabel,
  hostingSnapshotBadgeVariant,
  hostingSnapshotLabel,
  isStaleHostingOperation,
  isStaleHostingSnapshotRevision,
} from "./hosting-status";

it("projects provisioning and destruction without altering provider power or daemon health", () => {
  const vm = { powerState: "stopped" } as HostingResource;
  expect(hostingPowerLabel(vm, { action: "create", phase: "configuring" })).toBe("starting");
  expect(hostingPowerLabel(vm, { action: "delete", phase: "unknown" })).toBe("destroying");
  expect(hostingOperationLabel({ action: "create", phase: "unknown" })).toBe("Pending");
  expect(
    hostingOperationLabel({ action: "create", phase: "unknown", errorCode: "HOSTING_NODE_MISSING" })
  ).toBe("Needs attention");
  expect(hostingOperationLabel({ action: "create", phase: "enrolling" })).toBe("Enrolling");
  expect(hostingOperationLabel({ action: "delete", phase: "pending" })).toBe("Destroying");
  expect(hostingPowerLabel(vm, { action: "delete", phase: "failed" })).toBe("stopped");
});
it("keeps the node pending during VM preparation and distinguishes installation from enrollment", () => {
  for (const phase of ["pending", "dispatching", "configuring", "provisioning", "unknown"] as const)
    expect(hostingNodeLabel({ action: "create", phase })).toBe("Pending");
  expect(hostingNodeLabel({ action: "create", phase: "installing" })).toBe("Installing");
  expect(hostingNodeLabel({ action: "create", phase: "enrolling" })).toBe("Enrolling");
  expect(hostingNodeLabel({ action: "delete", phase: "provisioning" })).toBe("Destroying");
});

it.each([
  ["pending", "Pending", "warning"],
  ["ready", "Ready", "success"],
  ["failed", "Failed", "destructive"],
  ["deleting", "Deleting", "warning"],
] as const)("projects snapshot %s state", (status, label, variant) => {
  expect(hostingSnapshotLabel(status)).toBe(label);
  expect(hostingSnapshotBadgeVariant(status)).toBe(variant);
});

it("rejects stale snapshot revisions without relying on event arrival order", () => {
  expect(
    isStaleHostingSnapshotRevision("2026-09-07T10:00:01.000Z", "2026-09-07T10:00:00.000Z")
  ).toBe(true);
  expect(
    isStaleHostingSnapshotRevision("2026-09-07T10:00:00.000Z", "2026-09-07T10:00:01.000Z")
  ).toBe(false);
});

it("rejects stale operation snapshots by updatedAt", () => {
  expect(
    isStaleHostingOperation(
      { id: "op-1", updatedAt: "2026-09-07T10:00:01.000Z" },
      { id: "op-1", updatedAt: "2026-09-07T10:00:00.000Z" }
    )
  ).toBe(true);
  expect(
    isStaleHostingOperation(
      { id: "op-1", updatedAt: "2026-09-07T10:00:01.000Z" },
      { id: "op-2", updatedAt: "2026-09-07T10:00:02.000Z" }
    )
  ).toBe(false);
});
