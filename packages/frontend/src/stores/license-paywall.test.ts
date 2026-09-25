import { afterEach, describe, expect, it } from "vitest";
import { ApiRequestError } from "@/services/api-base";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import {
  handleLicenseApiError,
  handleLicenseError,
  hasLicenseFeature,
  requireLicenseFeature,
  requireMinimumLicensePlan,
  useLicensePaywallStore,
} from "./license-paywall";

function setLicense(
  plan: "community" | "personal" | "business",
  features: string[],
  entitlementsVersion?: number
) {
  useUIBootstrapStore.setState({
    snapshot: {
      license: { plan, entitlementsVersion, entitlements: { features } },
    } as never,
  });
}

afterEach(() => {
  useUIBootstrapStore.setState({ snapshot: null });
  useLicensePaywallStore.setState({ request: null });
});

describe("license paywall store", () => {
  it.each([
    "storage-connections",
    "external-database-connections",
    "gitlab",
    "ai-plan-mode",
    "ai-scenarios",
    "ai-sandboxes",
  ] as const)("requires Personal for %s", (feature) => {
    setLicense("community", []);
    expect(requireLicenseFeature(feature, feature)).toBe(false);
    expect(useLicensePaywallStore.getState().request).toMatchObject({
      requiredPlan: "personal",
      currentPlan: "community",
    });
    setLicense("personal", [feature]);
    useLicensePaywallStore.setState({ request: null });
    expect(requireLicenseFeature(feature, feature)).toBe(true);
  });

  it.each([
    "storage-connections",
    "external-database-connections",
    "ai-plan-mode",
    "ai-scenarios",
    "ai-sandboxes",
  ] as const)("grants %s to a paid pre-v5 license through managed-databases", (feature) => {
    setLicense("personal", ["managed-databases"], 4);
    expect(hasLicenseFeature(feature)).toBe(true);

    setLicense("community", [], 4);
    expect(hasLicenseFeature(feature)).toBe(false);

    // v5 grants name every capability explicitly.
    setLicense("personal", ["managed-databases"], 5);
    expect(hasLicenseFeature(feature)).toBe(false);
  });

  it("does not extend the pre-v5 rule to other paid features", () => {
    setLicense("personal", ["managed-databases"], 4);
    expect(hasLicenseFeature("gitlab")).toBe(false);
    expect(hasLicenseFeature("status-pages")).toBe(false);
  });

  it("opens the dialog for a structured AI WebSocket license denial", () => {
    setLicense("community", []);

    expect(
      handleLicenseError(
        {
          code: "LICENSE_ENTITLEMENT_REQUIRED",
          details: {
            feature: "ai-plan-mode",
            requiredPlan: "personal",
            currentPlan: "community",
            licenseStatus: "community",
          },
        },
        "AI Plan Mode"
      )
    ).toBe(true);
    expect(useLicensePaywallStore.getState().request).toEqual({
      capability: "AI Plan Mode",
      requiredPlan: "personal",
      currentPlan: "community",
      quota: undefined,
    });
  });

  it("ignores other error codes and keeps REST handling limited to API errors", () => {
    setLicense("community", []);

    expect(handleLicenseError({ code: "AI_RATE_LIMITED" }, "AI Plan Mode")).toBe(false);
    expect(handleLicenseApiError({ code: "LICENSE_ENTITLEMENT_REQUIRED" }, "AI Plan Mode")).toBe(
      false
    );
    expect(useLicensePaywallStore.getState().request).toBeNull();
  });

  it.each([
    "community",
    "unavailable",
  ] as const)("distinguishes an entitled feature from a %s module", (commercialModule) => {
    useUIBootstrapStore.setState({
      snapshot: {
        commercialModule,
        license: { plan: "business", entitlements: { features: ["pages"] } },
      } as never,
    });
    expect(requireLicenseFeature("pages", "Pages")).toBe(false);
    expect(useLicensePaywallStore.getState().request).toMatchObject({
      reason: "module-unavailable",
      currentPlan: "business",
    });
  });

  it("reports an unavailable module without suggesting a second license purchase", () => {
    setLicense("business", ["pages"]);
    expect(
      handleLicenseApiError(
        new ApiRequestError("Unavailable", { status: 503, code: "COMMERCIAL_MODULE_UNAVAILABLE" }),
        "Pages"
      )
    ).toBe(true);
    expect(useLicensePaywallStore.getState().request).toMatchObject({
      reason: "module-unavailable",
      currentPlan: "business",
    });
  });
  it("does not speculate before the UI bootstrap is available", () => {
    expect(requireLicenseFeature("secure-runtime", "Secure Runtime")).toBe(true);
    expect(useLicensePaywallStore.getState().request).toBeNull();
  });

  it("opens the shared dialog for an unavailable feature", () => {
    setLicense("community", []);

    expect(requireLicenseFeature("secure-runtime", "Secure Runtime")).toBe(false);
    expect(useLicensePaywallStore.getState().request).toEqual({
      capability: "Secure Runtime",
      requiredPlan: "business",
      currentPlan: "community",
    });
  });

  it("allows an entitled feature without opening the dialog", () => {
    setLicense("business", ["secure-runtime"]);

    expect(requireLicenseFeature("secure-runtime", "Secure Runtime")).toBe(true);
    expect(useLicensePaywallStore.getState().request).toBeNull();
  });

  it("opens the shared dialog when Pages requires Personal+", () => {
    setLicense("community", []);

    expect(requireLicenseFeature("pages", "Pages")).toBe(false);
    expect(useLicensePaywallStore.getState().request).toEqual({
      capability: "Pages",
      requiredPlan: "personal",
      currentPlan: "community",
    });

    setLicense("business", ["pages"]);
    useLicensePaywallStore.setState({ request: null });
    expect(requireLicenseFeature("pages", "Pages")).toBe(true);
    expect(useLicensePaywallStore.getState().request).toBeNull();
  });

  it("keeps Compose discovery visible but gates management behind Personal+", () => {
    setLicense("community", []);

    expect(requireLicenseFeature("compose-applications", "Compose projects")).toBe(false);
    expect(useLicensePaywallStore.getState().request).toEqual({
      capability: "Compose projects",
      requiredPlan: "personal",
      currentPlan: "community",
    });

    setLicense("personal", ["compose-applications"]);
    useLicensePaywallStore.setState({ request: null });
    expect(requireLicenseFeature("compose-applications", "Compose projects")).toBe(true);
    expect(useLicensePaywallStore.getState().request).toBeNull();
  });

  it("gates Git push-to-deploy behind the signed Business feature", () => {
    setLicense("personal", ["compose-applications"]);

    expect(requireLicenseFeature("git-push-to-deploy", "Git push-to-deploy")).toBe(false);
    expect(useLicensePaywallStore.getState().request).toEqual({
      capability: "Git push-to-deploy",
      requiredPlan: "business",
      currentPlan: "personal",
    });

    setLicense("business", ["git-push-to-deploy"]);
    useLicensePaywallStore.setState({ request: null });
    expect(requireLicenseFeature("git-push-to-deploy", "Git push-to-deploy")).toBe(true);
    expect(useLicensePaywallStore.getState().request).toBeNull();
  });

  it("enforces a minimum plan through the shared dialog without a feature entitlement", () => {
    setLicense("community", []);
    expect(requireMinimumLicensePlan("personal", "Disk image volumes")).toBe(false);
    expect(useLicensePaywallStore.getState().request).toEqual({
      capability: "Disk image volumes",
      requiredPlan: "personal",
      currentPlan: "community",
    });

    setLicense("business", []);
    useLicensePaywallStore.setState({ request: null });
    expect(requireMinimumLicensePlan("personal", "Disk image volumes")).toBe(true);
    expect(useLicensePaywallStore.getState().request).toBeNull();
  });

  it("translates a structured quota denial into the same dialog state", () => {
    setLicense("community", []);
    const error = new ApiRequestError("quota reached", {
      status: 409,
      code: "LICENSE_QUOTA_EXCEEDED",
      details: { currentPlan: "community", resource: "users", limit: 10, current: 10 },
    });

    expect(handleLicenseApiError(error, "Create user")).toBe(true);
    expect(useLicensePaywallStore.getState().request).toMatchObject({
      capability: "Create user",
      requiredPlan: "personal",
      currentPlan: "community",
      quota: { resource: "users", limit: 10, current: 10 },
    });
  });
});
