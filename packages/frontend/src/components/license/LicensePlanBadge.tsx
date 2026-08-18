import { Badge } from "@/components/ui/badge";
import type { PaidLicensePlan } from "@/stores/license-paywall";

const LABELS: Record<PaidLicensePlan, string> = {
  personal: "Personal",
  business: "Business",
  enterprise: "Enterprise",
};

const VARIANTS: Record<PaidLicensePlan, "secondary" | "info" | "default"> = {
  personal: "secondary",
  business: "info",
  enterprise: "default",
};

export function LicensePlanBadge({ plan, label }: { plan: PaidLicensePlan; label?: string }) {
  return (
    <Badge size="inline" variant={VARIANTS[plan]}>
      {label ?? LABELS[plan]}
    </Badge>
  );
}
