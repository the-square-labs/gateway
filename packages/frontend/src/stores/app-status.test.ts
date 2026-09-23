import { beforeEach, describe, expect, it, vi } from "vitest";
import { syncGatewayOperationStatus, useAppStatusStore } from "./app-status";

describe("app status cross-tab synchronization", () => {
  beforeEach(() => {
    useAppStatusStore.setState({
      maintenanceActive: false,
      gatewayUpdatingActive: false,
      gatewayUpdatingTargetVersion: null,
      gatewayRestartingActive: false,
      gatewayRestartTargetUrl: null,
    });
  });

  it("does not write the same operation state back to another tab", () => {
    const snapshot = {
      gatewayUpdatingActive: false,
      gatewayUpdatingTargetVersion: null,
      gatewayRestartingActive: true,
      gatewayRestartTargetUrl: null,
    };

    expect(syncGatewayOperationStatus(snapshot)).toBe(true);
    expect(syncGatewayOperationStatus(snapshot)).toBe(false);
    expect(useAppStatusStore.getState()).toMatchObject(snapshot);
  });

  it("applies clearing both operation modes atomically", () => {
    useAppStatusStore.setState({
      gatewayUpdatingActive: false,
      gatewayUpdatingTargetVersion: null,
      gatewayRestartingActive: true,
      gatewayRestartTargetUrl: "https://gateway.test",
    });

    const cleared = {
      gatewayUpdatingActive: false,
      gatewayUpdatingTargetVersion: null,
      gatewayRestartingActive: false,
      gatewayRestartTargetUrl: null,
    };
    expect(syncGatewayOperationStatus(cleared)).toBe(true);
    expect(syncGatewayOperationStatus(cleared)).toBe(false);
    expect(useAppStatusStore.getState()).toMatchObject(cleared);
  });

  it("does not latch maintenance while a known restart is active", () => {
    useAppStatusStore.getState().setGatewayRestartingActive(true);
    useAppStatusStore.getState().setMaintenanceActive(true);

    expect(useAppStatusStore.getState()).toMatchObject({
      gatewayRestartingActive: true,
      maintenanceActive: false,
    });
  });

  it("clears a previously latched maintenance state when restart begins", () => {
    useAppStatusStore.setState({ maintenanceActive: true });

    useAppStatusStore.getState().setGatewayRestartingActive(true);

    expect(useAppStatusStore.getState()).toMatchObject({
      gatewayRestartingActive: true,
      maintenanceActive: false,
    });
  });

  it("remembers when the update screen started, across repeated announcements of the same update", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-23T12:00:00Z"));
      useAppStatusStore.getState().setGatewayUpdatingActive(true, "v2.5.0");
      const startedAt = useAppStatusStore.getState().gatewayUpdatingStartedAt;
      expect(startedAt).toBe(Date.now());

      vi.setSystemTime(new Date("2026-09-23T12:10:00Z"));
      useAppStatusStore.getState().setGatewayUpdatingActive(true, "v2.5.0");
      expect(useAppStatusStore.getState().gatewayUpdatingStartedAt).toBe(startedAt);

      useAppStatusStore
        .getState()
        .setGatewayUpdateError("rolled back", "v2.5.0", { rolledBack: true });
      expect(useAppStatusStore.getState()).toMatchObject({
        gatewayUpdatingActive: false,
        gatewayUpdatingStartedAt: null,
        gatewayUpdateError: { message: "rolled back", targetVersion: "v2.5.0", rolledBack: true },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
