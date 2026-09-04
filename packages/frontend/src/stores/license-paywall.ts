import { create } from "zustand";
import { ApiRequestError } from "@/services/api-base";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
import type { LicensePlan } from "@/types";

export const LICENSE_FEATURE_PLANS = {
  "container-export": "personal",
  "blue-green": "personal",
  "cross-node-migration": "personal",
  "managed-databases": "personal",
  "status-pages": "personal",
  "registry-discovery": "personal",
  pages: "personal",
  "secure-runtime": "business",
  "structured-logging": "business",
  "audit-export": "business",
  "git-push-to-deploy": "business",
  "multi-node-availability": "business",
  "compose-applications": "personal",
  "internal-pki": "enterprise",
  "siem-export": "enterprise",
} as const satisfies Record<string, Exclude<LicensePlan, "community">>;

export type LicenseFeature = keyof typeof LICENSE_FEATURE_PLANS;
export type PaidLicensePlan = Exclude<LicensePlan, "community">;

const LICENSE_PLAN_RANK: Record<LicensePlan, number> = {
  community: 0,
  personal: 1,
  business: 2,
  enterprise: 3,
};

export interface LicensePaywallRequest {
  capability: string;
  requiredPlan: PaidLicensePlan;
  currentPlan: LicensePlan;
  quota?: {
    resource?: string;
    limit?: number;
    current?: number;
  };
}

interface LicensePaywallState {
  request: LicensePaywallRequest | null;
  open: (request: LicensePaywallRequest) => void;
  close: () => void;
}

export const useLicensePaywallStore = create<LicensePaywallState>()((set) => ({
  request: null,
  open: (request) => set({ request }),
  close: () => set({ request: null }),
}));

function currentPlan(): LicensePlan {
  return useUIBootstrapStore.getState().snapshot?.license.plan ?? "community";
}

export function hasLicenseFeature(feature: LicenseFeature): boolean | null {
  const license = useUIBootstrapStore.getState().snapshot?.license;
  if (!license) return null;
  return license.entitlements.features.includes(feature);
}

export function requireLicenseFeature(feature: LicenseFeature, capability: string): boolean {
  const allowed = hasLicenseFeature(feature);
  if (allowed !== false) return true;
  useLicensePaywallStore.getState().open({
    capability,
    requiredPlan: LICENSE_FEATURE_PLANS[feature],
    currentPlan: currentPlan(),
  });
  return false;
}

export function requireMinimumLicensePlan(
  requiredPlan: PaidLicensePlan,
  capability: string
): boolean {
  const license = useUIBootstrapStore.getState().snapshot?.license;
  if (!license) return true;
  if (LICENSE_PLAN_RANK[license.plan] >= LICENSE_PLAN_RANK[requiredPlan]) return true;
  useLicensePaywallStore.getState().open({
    capability,
    requiredPlan,
    currentPlan: license.plan,
  });
  return false;
}

interface LicenseErrorDetails {
  feature?: unknown;
  requiredPlan?: unknown;
  currentPlan?: unknown;
  resource?: unknown;
  limit?: unknown;
  current?: unknown;
}

function isPaidPlan(value: unknown): value is PaidLicensePlan {
  return value === "personal" || value === "business" || value === "enterprise";
}

function isLicensePlan(value: unknown): value is LicensePlan {
  return value === "community" || isPaidPlan(value);
}

export function handleLicenseApiError(error: unknown, capability: string): boolean {
  if (!(error instanceof ApiRequestError)) return false;
  if (error.code !== "LICENSE_ENTITLEMENT_REQUIRED" && error.code !== "LICENSE_QUOTA_EXCEEDED") {
    return false;
  }

  const details =
    error.details && typeof error.details === "object"
      ? (error.details as LicenseErrorDetails)
      : undefined;
  const feature =
    typeof details?.feature === "string" && details.feature in LICENSE_FEATURE_PLANS
      ? (details.feature as LicenseFeature)
      : undefined;
  const requiredPlan = isPaidPlan(details?.requiredPlan)
    ? details.requiredPlan
    : feature
      ? LICENSE_FEATURE_PLANS[feature]
      : "personal";

  useLicensePaywallStore.getState().open({
    capability,
    requiredPlan,
    currentPlan: isLicensePlan(details?.currentPlan) ? details.currentPlan : currentPlan(),
    quota:
      error.code === "LICENSE_QUOTA_EXCEEDED"
        ? {
            resource: typeof details?.resource === "string" ? details.resource : undefined,
            limit: typeof details?.limit === "number" ? details.limit : undefined,
            current: typeof details?.current === "number" ? details.current : undefined,
          }
        : undefined,
  });
  return true;
}
