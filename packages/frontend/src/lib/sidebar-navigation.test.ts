import { describe, expect, it } from "vitest";
import { isSidebarNavigationActive } from "./sidebar-navigation";

describe("sidebar navigation matching", () => {
  it.each([
    ["/settings", "/settings"],
    ["/settings/inference", "/settings"],
    ["/administration/users", "/administration"],
    ["/docker/containers/node/container/settings", "/docker"],
    ["/nodes/node-a/overview", "/nodes"],
    ["/profile/authorizations", "/profile"],
  ])("marks %s as a child of %s", (pathname, href) => {
    expect(isSidebarNavigationActive(pathname, href)).toBe(true);
  });

  it("keeps Dashboard and sibling prefixes boundary-safe", () => {
    expect(isSidebarNavigationActive("/settings", "/")).toBe(false);
    expect(isSidebarNavigationActive("/nodes-old", "/nodes")).toBe(false);
  });
});
