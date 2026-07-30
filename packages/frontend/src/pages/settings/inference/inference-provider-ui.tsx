import { Badge } from "@/components/ui/badge";
import type { InferenceProviderConnection } from "@/types/inference";

export function HealthBadge({ status }: { status: string }) {
  return (
    <Badge
      variant={
        status === "healthy"
          ? "success"
          : status === "quota_hot" || status === "stale" || status === "cooldown"
            ? "warning"
            : status === "unavailable" || status === "reauth_required"
              ? "destructive"
              : "secondary"
      }
      size="inline"
    >
      {status.replaceAll("_", " ")}
    </Badge>
  );
}

export function formatWorstQuota(connections: InferenceProviderConnection[]) {
  const apiBudget = connections.find(
    (connection) => connection.apiMonthlyLimitMicrodollars !== null
  );
  if (
    apiBudget?.apiMonthlyLimitMicrodollars !== null &&
    apiBudget?.apiMonthlyLimitMicrodollars !== undefined
  ) {
    return `${formatUsd(apiBudget.apiMonthlySpentMicrodollars)} / ${formatUsd(apiBudget.apiMonthlyLimitMicrodollars)}`;
  }
  const fractions = connections.flatMap((connection) =>
    connection.quota.flatMap((quota) =>
      quota.remainingFraction == null ? [] : [quota.remainingFraction]
    )
  );
  if (!fractions.length) return "Not reported";
  return `${Math.round(Math.min(...fractions) * 100)}% remaining`;
}

function formatUsd(microdollars: number) {
  return `$${(microdollars / 1_000_000).toFixed(2)}`;
}

export function connectionIdentity(connection: InferenceProviderConnection) {
  if (connection.accountLabel) return connection.accountLabel;
  if (connection.credential?.last4) return `•••• ${connection.credential.last4}`;
  return connection.authType.replaceAll("_", " ");
}
