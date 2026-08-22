import { afterEach, describe, expect, it } from "vitest";
import { ApiRequestError } from "@/services/api-base";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import {
  handleLicenseApiError,
  requireLicenseFeature,
  requireMinimumLicensePlan,
  useLicensePaywallStore,
} from "./license-paywall";

function setLicense(plan: "community" | "business", features: string[]) {
  useUIBootstrapStore.setState({
    snapshot: {
      license: { plan, entitlements: { features } },
    } as never,
  });
}

afterEach(() => {
  useUIBootstrapStore.setState({ snapshot: null });
  useLicensePaywallStore.setState({ request: null });
});

describe("license paywall store", () => {
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
