import { describe, expect, it } from "vitest";
import { resolveAvailabilitySurfaceStatus } from "./availability-status";

describe("Availability lifecycle status", () => {
  it.each([
    ["start", "starting"],
    ["stop", "stopping"],
    ["restart", "restarting"],
  ])("labels %s without calling it rollout", (type, expected) => {
    expect(
      resolveAvailabilitySurfaceStatus({
        policyStatus: "rolling_out",
        shouldRun: type !== "stop",
        serving: 0,
        desired: 2,
        operation: { type, status: "running" },
      })
    ).toBe(expected);
  });
  it("settles to stopped even while old Docker snapshots still say serving", () => {
    expect(
      resolveAvailabilitySurfaceStatus({
        policyStatus: "healthy",
        shouldRun: false,
        serving: 2,
        desired: 2,
        operation: { type: "stop", status: "completed" },
      })
    ).toBe("stopped");
  });
});
