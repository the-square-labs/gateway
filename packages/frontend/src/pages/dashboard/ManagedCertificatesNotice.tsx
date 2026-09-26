import { Link } from "react-router-dom";
import { Notice } from "@/components/common/Notice";
import { databaseRoute, storageRoute } from "@/lib/resource-routes";
import type { DashboardManagedCertificate } from "@/types";

function reasonLabel(certificate: DashboardManagedCertificate) {
  switch (certificate.reason) {
    case "renewal_failed":
      return "renewal failed";
    case "ca_limited":
      return "renewal limited by its CA";
    case "waiting_for_daemon":
      return "renewal waits for the node daemon";
    case "awaiting_reload":
      return "renewed certificate not loaded yet";
    case "expiring":
      return certificate.daysRemaining <= 0
        ? "expires today"
        : `expires in ${certificate.daysRemaining} ${certificate.daysRemaining === 1 ? "day" : "days"}`;
  }
}

/**
 * Dashboard warning for managed database and storage TLS certificates that
 * do not renew on their own, each linking to its resource.
 */
export function ManagedCertificatesNotice({
  certificates,
}: {
  certificates: readonly DashboardManagedCertificate[];
}) {
  if (certificates.length === 0) return null;
  return (
    <Notice
      tone="warning"
      role="status"
      title={
        certificates.length === 1
          ? "A managed TLS certificate needs attention"
          : `${certificates.length} managed TLS certificates need attention`
      }
    >
      <ul className="mt-1 space-y-0.5 text-sm">
        {certificates.map((certificate) => (
          <li key={`${certificate.kind}:${certificate.id}`} className="min-w-0">
            <Link
              to={
                certificate.kind === "storage"
                  ? storageRoute(certificate.slug)
                  : databaseRoute(certificate.slug)
              }
              className="font-medium text-link hover:underline"
            >
              {certificate.name}
            </Link>
            <span className="text-muted-foreground"> · {reasonLabel(certificate)}</span>
          </li>
        ))}
      </ul>
    </Notice>
  );
}
