import { describe, expect, it } from "vitest";
import {
  type AppNavigationVisibility,
  keyboardNavigationRoutes,
  visibleNavigationGroups,
} from "./app-navigation";

function context(overrides: Partial<AppNavigationVisibility> = {}): AppNavigationVisibility {
  return {
    scopes: [],
    pkiEnabled: false,
    siemEnabled: false,
    loggingEnabled: false,
    inferenceEnabled: false,
    ...overrides,
  };
}

describe("app navigation registry", () => {
  it("hides Dashboard when none of its content is available", () => {
    const groups = visibleNavigationGroups(context());
    const ids = groups.flatMap((group) => group.items.map((item) => item.id));

    expect(ids).not.toContain("dashboard");
    expect(ids).toContain("profile");
  });

  it("shows Dashboard for personal inference usage only when a quota is low", () => {
    const regularUsageGroups = visibleNavigationGroups(
      context({ scopes: ["feat:ai:use"], inferenceEnabled: true })
    );
    const regularUsageIds = regularUsageGroups.flatMap((group) =>
      group.items.map((item) => item.id)
    );
    const groups = visibleNavigationGroups(
      context({
        scopes: ["feat:ai:use"],
        inferenceEnabled: true,
        hasLowInferenceUsage: true,
      })
    );
    const ids = groups.flatMap((group) => group.items.map((item) => item.id));

    expect(regularUsageIds).not.toContain("dashboard");
    expect(ids).toContain("dashboard");
  });

  it("keeps numeric shortcuts aligned with their visible destinations", () => {
    const routes = keyboardNavigationRoutes(
      context({
        scopes: [
          "proxy:view",
          "domains:view",
          "ssl:cert:view",
          "pki:ca:view:root",
          "pki:cert:view",
          "pki:templates:view",
          "docker:containers:view",
          "nodes:details",
          "acl:view",
        ],
        pkiEnabled: true,
        hasCloudflareIntegration: true,
      })
    );

    expect(routes).toEqual({
      "1": "/",
      "2": "/domains",
      "3": "/proxy-hosts",
      "4": "/ssl-certificates",
      "5": "/cas",
      "6": "/certificates",
      "7": "/templates",
      "8": "/docker",
      "9": "/nodes",
      "0": "/access-lists",
    });
  });

  it("shows Settings for Cloudflare-only integration administrators", () => {
    const groups = visibleNavigationGroups(context({ scopes: ["integrations:cloudflare:view"] }));

    expect(groups.flatMap((group) => group.items.map((item) => item.id))).toContain("settings");
  });

  it("shows Domains before a Cloudflare integration is configured", () => {
    const ids = visibleNavigationGroups(
      context({ scopes: ["domains:view"], hasCloudflareIntegration: false })
    ).flatMap((group) => group.items.map((item) => item.id));

    expect(ids).toContain("domains");
  });

  it("shows Domains for an individual domain grant", () => {
    const ids = visibleNavigationGroups(context({ scopes: ["domains:view:domain-1"] })).flatMap(
      (group) => group.items.map((item) => item.id)
    );

    expect(ids).toContain("domains");
  });

  it("shows Docker for a node-scoped task grant", () => {
    const ids = visibleNavigationGroups(
      context({ scopes: ["docker:tasks:docker-node-1"], hasDockerNodes: true })
    ).flatMap((group) => group.items.map((item) => item.id));

    expect(ids).toContain("docker");
  });

  it("hides feature-backed destinations while their features are disabled", () => {
    const groups = visibleNavigationGroups(
      context({
        scopes: ["pki:ca:view:root", "pki:cert:view", "logs:environments:view", "status-page:view"],
        statusPageEnabled: false,
      })
    );
    const ids = groups.flatMap((group) => group.items.map((item) => item.id));

    expect(ids).not.toContain("authorities");
    expect(ids).not.toContain("certificates");
    expect(ids).not.toContain("logging");
    expect(ids).not.toContain("status-page");
  });

  it("hides Notifications from SIEM-only users while SIEM is disabled", () => {
    const disabledIds = visibleNavigationGroups(
      context({ scopes: ["audit:siem:view"], siemEnabled: false })
    ).flatMap((group) => group.items.map((item) => item.id));
    const enabledIds = visibleNavigationGroups(
      context({ scopes: ["audit:siem:view"], siemEnabled: true })
    ).flatMap((group) => group.items.map((item) => item.id));

    expect(disabledIds).not.toContain("notifications");
    expect(enabledIds).toContain("notifications");
  });
});
