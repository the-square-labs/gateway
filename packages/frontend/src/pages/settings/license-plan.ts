import type { LicensePlan } from "@/types";

interface LicensePlanStatus {
  plan?: unknown;
  tier?: unknown;
  status?: unknown;
  hasKey?: unknown;
}

const LICENSE_PLANS = new Set<LicensePlan>(["community", "personal", "business", "enterprise"]);

export function resolveLicensePlan(status: LicensePlanStatus): LicensePlan {
  if (typeof status.plan === "string" && LICENSE_PLANS.has(status.plan as LicensePlan)) {
    return status.plan as LicensePlan;
  }

  if (status.status === "community" || status.hasKey === false) return "community";

  switch (status.tier) {
    case "homelab":
      return "personal";
    case "personal":
    case "business":
    case "enterprise":
      return status.tier;
    default:
      return "community";
  }
}
