import { beforeEach, describe, expect, it } from "vitest";
import { syncGatewayOperationStatus, useAppStatusStore } from "./app-status";

describe("app status cross-tab synchronization", () => {
  beforeEach(() => {
    useAppStatusStore.setState({
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
});
