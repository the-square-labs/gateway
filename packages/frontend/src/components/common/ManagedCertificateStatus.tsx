import { AlertTriangle, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn, formatDate, formatDateTime } from "@/lib/utils";
import type { ManagedCertificateStatus as ManagedCertificateStatusView } from "@/types";

/** One line of what the automatic renewal is doing, or null when nothing needs saying. */
export function describeCertificateRenewal(
  status: ManagedCertificateStatusView
): { tone: "info" | "warning"; text: string } | null {
  const { renewal } = status;
  const next = renewal.nextAttemptAt
    ? ` Next attempt ${formatDateTime(renewal.nextAttemptAt)}.`
    : "";
  switch (renewal.state) {
    case "failed":
      return {
        tone: "warning",
        text: `Automatic renewal failed${renewal.attempts > 1 ? ` (${renewal.attempts} attempts)` : ""}: ${renewal.lastError ?? "unknown error"}.${next}`,
      };
    case "ca_limited":
      return {
        tone: "warning",
        text:
          renewal.lastError ??
          "The issuing CA expires before a renewed certificate would; renew or replace the CA.",
      };
    case "waiting_for_daemon":
      return {
        tone: "warning",
        text: "Renewal is waiting for the node daemon to be updated, so the certificate can be reloaded without a restart. A restart is used only once 7 days or less remain.",
      };
    case "awaiting_reload":
    case "delivering":
      return {
        tone: "info",
        text: `A renewed certificate was delivered; the service loads it on its own schedule and Gateway confirms it.${next}`,
      };
    default:
      if (renewal.due && renewal.skipReason)
        return {
          tone: "info",
          text: `Renewal is due and runs once the service is available again (${renewal.skipReason.replaceAll("_", " ")}).`,
        };
      if (renewal.due) return { tone: "info", text: "Renewal is due and runs within the hour." };
      return null;
  }
}

/**
 * Server certificate of a managed storage cluster or managed database: when
 * it expires and what its automatic renewal is doing. Renders nothing when
 * the resource has no TLS certificate.
 */
export function ManagedCertificateStatus({
  load,
  onRenew,
  renewLabel = "Renew now",
  refreshKey,
}: {
  load: () => Promise<ManagedCertificateStatusView>;
  /** Shown as a button when set (the caller checks permissions and confirms). */
  onRenew?: () => Promise<boolean>;
  renewLabel?: string;
  refreshKey?: unknown;
}) {
  const [status, setStatus] = useState<ManagedCertificateStatusView | null>(null);
  const [renewing, setRenewing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await load());
    } catch {
      // TLS off, no permission, or an older Gateway: nothing to show.
      setStatus(null);
    }
  }, [load]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey reloads the status when the owning resource changes.
  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  if (!status?.certificate) return null;
  const note = describeCertificateRenewal(status);
  const { certificate } = status;
  const expiring = certificate.daysRemaining <= 7;

  const renew = async () => {
    if (!onRenew) return;
    setRenewing(true);
    try {
      if (await onRenew()) await refresh();
    } finally {
      setRenewing(false);
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-2 border p-3 sm:flex-row sm:items-center",
        note?.tone === "warning" || expiring ? "border-warning/30 bg-warning/5" : "border-border"
      )}
    >
      <div className="flex flex-1 items-start gap-2">
        {note?.tone === "warning" || expiring ? (
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning-foreground" />
        ) : (
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <div className="space-y-0.5">
          <p className="text-sm font-medium">
            TLS certificate expires {formatDate(certificate.notAfter)} ({certificate.daysRemaining}{" "}
            {certificate.daysRemaining === 1 ? "day" : "days"})
          </p>
          <p className="text-xs text-muted-foreground">
            {note?.text ??
              (status.renewal.lastSuccessAt
                ? `Renewed automatically ${formatDateTime(status.renewal.lastSuccessAt)}${status.renewal.lastRestarted ? " (with a restart)" : " without a restart"}.`
                : "Gateway renews it automatically before it expires, without a restart.")}
          </p>
        </div>
      </div>
      {onRenew && (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => void renew()}
          disabled={renewing}
        >
          <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", renewing && "animate-spin")} />
          {renewing ? "Renewing..." : renewLabel}
        </Button>
      )}
    </div>
  );
}
