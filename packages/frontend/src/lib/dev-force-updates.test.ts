import { beforeEach, describe, expect, it } from "vitest";
import {
  applyForcedGatewayUpdateStatus,
  DEV_FORCE_UPDATES_STORAGE_KEY,
  setDevForcedUpdateMode,
} from "@/lib/dev-force-updates";
import type { UpdateStatus } from "@/types";

const status: UpdateStatus = {
  currentVersion: "v2.6.12",
  latestVersion: null,
  updateAvailable: false,
  releaseNotes: null,
  releaseUrl: null,
  lastCheckedAt: null,
  relay: {
    currentVersion: "v2.6.12",
    latestVersion: null,
    updateAvailable: false,
    releaseNotes: null,
    releaseUrl: null,
    operation: null,
  },
};

describe("dev forced update states", () => {
  beforeEach(() => window.localStorage.removeItem(DEV_FORCE_UPDATES_STORAGE_KEY));

  it.each([
    ["gateway", true, false],
    ["relay", false, true],
    ["both", true, true],
  ] as const)("renders the %s update state", (mode, gateway, relay) => {
    setDevForcedUpdateMode(mode);

    const forced = applyForcedGatewayUpdateStatus(status);

    expect(forced.updateAvailable).toBe(gateway);
    expect(forced.relay.updateAvailable).toBe(relay);
    expect(forced.latestVersion).toBe(gateway ? "v9.9.9" : null);
    expect(forced.relay.latestVersion).toBe(relay ? "v9.9.9" : null);
  });

  it("normalizes a legacy Gateway response without Relay status", () => {
    setDevForcedUpdateMode("relay");

    const forced = applyForcedGatewayUpdateStatus({
      ...status,
      relay: undefined,
    } as unknown as UpdateStatus);

    expect(forced.updateAvailable).toBe(false);
    expect(forced.relay).toMatchObject({
      currentVersion: "v2.6.12",
      latestVersion: "v9.9.9",
      updateAvailable: true,
    });
  });
});
