import { afterEach, describe, expect, it } from "vitest";
import { shouldBlockDemoRequest, useDemoModeStore } from "./demo-mode";

afterEach(() => useDemoModeStore.setState({ enabled: false, open: false }));

describe("demo request preflight", () => {
  it("is inert until the authenticated bootstrap enables demo mode", () => {
    expect(shouldBlockDemoRequest("/api/docker/containers", "POST")).toBe(false);
  });

  it("blocks mutations and sensitive reads while preserving exploration reads", () => {
    useDemoModeStore.setState({ enabled: true });

    expect(shouldBlockDemoRequest("/api/docker/containers", "POST")).toBe(true);
    expect(shouldBlockDemoRequest("/api/nodes/node-1/config", "GET")).toBe(true);
    expect(
      shouldBlockDemoRequest("/api/docker/nodes/node-1/containers/container-1/env", "GET")
    ).toBe(true);
    expect(shouldBlockDemoRequest("/api/audit", "GET")).toBe(true);
    expect(shouldBlockDemoRequest("/api/docker/registry/token", "GET")).toBe(true);
    expect(shouldBlockDemoRequest("/api/docker/containers", "GET")).toBe(false);
    expect(shouldBlockDemoRequest("/api/monitoring/dashboard/bootstrap", "POST")).toBe(false);
    expect(shouldBlockDemoRequest("/auth/logout", "POST")).toBe(false);
  });
});
