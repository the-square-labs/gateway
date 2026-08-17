import { Link } from "react-router-dom";
import { PanelShell } from "@/components/common/PanelShell";
import { ProxyUpstreamTarget } from "@/components/proxy/ProxyUpstreamTarget";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { proxyHostRoute } from "@/lib/resource-routes";
import type { ProxyHost } from "@/types";

interface HealthOverviewCardProps {
  healthHosts: ProxyHost[];
  hasScope: (scope: string) => boolean;
  loading?: boolean;
}

export function sortHealthOverviewHosts(hosts: ProxyHost[]): ProxyHost[] {
  return [...hosts].sort((left, right) => {
    const leftDomain = [...left.domainNames].sort().join(", ").toLowerCase();
    const rightDomain = [...right.domainNames].sort().join(", ").toLowerCase();
    return leftDomain.localeCompare(rightDomain) || left.id.localeCompare(right.id);
  });
}

export function HealthOverviewCard({
  healthHosts,
  hasScope,
  loading = false,
}: HealthOverviewCardProps) {
  // Keep the panel's geometry while its permitted data resolves, then omit it
  // entirely when there is nothing useful to show on the dashboard.
  if (!hasScope("proxy:view") || (!loading && healthHosts.length === 0)) return null;

  return (
    <PanelShell
      title="Health Overview"
      actions={
        <Link to="/proxy-hosts" className="text-sm text-muted-foreground hover:text-foreground">
          View all
        </Link>
      }
    >
      {loading ? (
        <div className="space-y-3 px-4 py-4" aria-busy="true">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="h-9 w-full" />
          ))}
        </div>
      ) : healthHosts.length > 0 ? (
        <div className="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border">
          {sortHealthOverviewHosts(healthHosts)
            .slice(0, 6)
            .map((host) => (
              <Link
                key={host.id}
                to={proxyHostRoute(host.slug)}
                className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors"
              >
                <span className="text-sm font-medium truncate flex-1">
                  {host.domainNames.join(", ")}
                </span>
                <ProxyUpstreamTarget host={host} size="inline" />
                <Badge
                  variant={
                    (
                      {
                        online: "success",
                        offline: "destructive",
                        degraded: "warning",
                        recovering: "warning",
                        unknown: "secondary",
                        disabled: "outline",
                      } as const
                    )[(host.effectiveHealthStatus ?? host.healthStatus) as string] || "secondary"
                  }
                  size="inline"
                  className="uppercase"
                >
                  {(host.effectiveHealthStatus ?? host.healthStatus) === "online"
                    ? "healthy"
                    : (host.effectiveHealthStatus ?? host.healthStatus)}
                </Badge>
              </Link>
            ))}
        </div>
      ) : null}
    </PanelShell>
  );
}
