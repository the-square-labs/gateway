import { describe, expect, it } from "vitest";
import {
  type AdditionalRouteDraft,
  DEFAULT_ADDITIONAL_ROUTE_OPTIONS,
  normalizeAdditionalRoutePath,
  routeRequestFromDraft,
  supportsAdditionalRoutesTemplate,
  validateAdditionalRoutePath,
} from "./AdditionalRoutes";

function draft(overrides: Partial<AdditionalRouteDraft> = {}): AdditionalRouteDraft {
  return {
    path: "/api/",
    targetKind: "manual",
    upstream: {
      kind: "manual",
      scheme: "http",
      manualHost: "127.0.0.1",
      manualPort: 8080,
      dockerNodeId: null,
      containerName: null,
      deploymentId: null,
      containerPort: null,
    },
    pageProjectId: "",
    pageTagId: "",
    ...DEFAULT_ADDITIONAL_ROUTE_OPTIONS,
    ...overrides,
  };
}

describe("Additional Routes path contract", () => {
  it("normalizes only the trailing slash", () => {
    expect(normalizeAdditionalRoutePath(" /api/ ")).toBe("/api");
    expect(normalizeAdditionalRoutePath("/api//v1")).toBeNull();
  });

  it("rejects root, reserved, encoded, and traversal paths", () => {
    expect(validateAdditionalRoutePath("/")).toMatch(/root/i);
    expect(validateAdditionalRoutePath("/_gateway/status")).toMatch(/reserved/i);
    expect(validateAdditionalRoutePath("/.well-known/acme-challenge/foo")).toMatch(/reserved/i);
    expect(validateAdditionalRoutePath("/%5Fgateway")).toMatch(/encoded/i);
    expect(validateAdditionalRoutePath("/api/../admin")).toMatch(/traversal/i);
  });

  it("rejects duplicate normalized paths while allowing a different prefix", () => {
    const routes = [
      {
        id: "route-1",
        path: "/api",
      },
    ] as never;
    expect(validateAdditionalRoutePath("/api/", routes)).toMatch(/already exists/i);
    expect(validateAdditionalRoutePath("/apis", routes)).toBeNull();
    expect(validateAdditionalRoutePath("/api/", routes, "route-1")).toBeNull();
  });
});

describe("Additional Routes request mapping", () => {
  it("forces Pages routes to strip the prefix and omits proxy-only options", () => {
    const request = routeRequestFromDraft(
      draft({
        targetKind: "pages",
        pageProjectId: "project-1",
        pageTagId: "tag-1",
        stripPrefix: false,
        websocketSupport: true,
        requestBuffering: true,
        responseBuffering: true,
      })
    );

    expect(request).toMatchObject({
      targetKind: "pages",
      pageProjectId: "project-1",
      pageTagId: "tag-1",
      stripPrefix: true,
      websocketSupport: false,
      requestBuffering: false,
      responseBuffering: false,
    });
  });
});

describe("Additional Routes template capability", () => {
  it("accepts only the canonical unescaped placeholder", () => {
    expect(
      supportsAdditionalRoutesTemplate(
        "{{{renderAdditionalRoutes additionalRoutes id accessList rateLimitEnabled rateLimitBurst connectionsPerIp}}}"
      )
    ).toBe(true);
    expect(supportsAdditionalRoutesTemplate("{{renderAdditionalRoutes additionalRoutes}}")).toBe(
      false
    );
  });
});
