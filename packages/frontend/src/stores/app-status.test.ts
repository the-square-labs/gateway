import { beforeEach, describe, expect, it } from "vitest";
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
});
