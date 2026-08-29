import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildGatewayReloadUrl,
  getGatewayReloadToken,
  isGatewayReloadMessageActionable,
  reloadGatewayClient,
  resetGatewayReloadNavigationGuardForTest,
  stripGatewayReloadParam,
} from "../../src/lib/gateway-update-reload";

afterEach(() => {
  resetGatewayReloadNavigationGuardForTest();
  vi.restoreAllMocks();
});

describe("gateway update reload url helpers", () => {
  it("adds a cache-busting version parameter without dropping existing URL state", () => {
    expect(buildGatewayReloadUrl("https://gateway.test/settings?tab=updates#top", 123)).toBe(
      "/settings?tab=updates&_v=123#top"
    );
  });

  it("removes only the update cache-busting parameter on startup", () => {
    expect(stripGatewayReloadParam("https://gateway.test/settings?tab=updates&_v=123#top")).toBe(
      "/settings?tab=updates#top"
    );
    expect(stripGatewayReloadParam("https://gateway.test/settings?tab=updates#top")).toBeNull();
  });

  it("reads the reload token before startup removes it from the URL", () => {
    expect(getGatewayReloadToken("https://gateway.test/settings?_v=reload-123")).toBe("reload-123");
  });

  it("ignores an already handled or stale cross-tab reload", () => {
    const message = {
      id: "reload-123",
      at: 1_000_000,
      version: "2.5.0",
      reason: "gateway-version-changed",
    };

    expect(isGatewayReloadMessageActionable(message, "reload-123", 1_001_000)).toBe(false);
    expect(isGatewayReloadMessageActionable(message, null, 1_121_000)).toBe(false);
    expect(isGatewayReloadMessageActionable(message, null, 1_001_000)).toBe(true);
  });

  it("accepts only one reload navigation per page lifecycle", () => {
    const originalLocation = window.location;
    const location = { href: "https://gateway.test/dashboard" };
    Object.defineProperty(window, "location", { configurable: true, value: location });

    expect(reloadGatewayClient("reload-1")).toBe(true);
    expect(reloadGatewayClient("reload-2")).toBe(false);
    expect(location.href).toContain("_v=reload-1");

    Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  });
});
