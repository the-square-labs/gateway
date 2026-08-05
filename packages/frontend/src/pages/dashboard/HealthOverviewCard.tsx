import { Link } from "react-router-dom";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { PanelShell } from "@/components/common/PanelShell";
import { ProxyUpstreamTarget } from "@/components/proxy/ProxyUpstreamTarget";
import { Badge } from "@/components/ui/badge";
import { proxyHostRoute } from "@/lib/resource-routes";
import type { ProxyHost } from "@/types";

interface HealthOverviewCardProps {
  healthHosts: ProxyHost[];
  hasScope: (scope: string) => boolean;
  loading?: boolean;
}

export function HealthOverviewCard({
  healthHosts,
  hasScope,
  loading = false,
}: HealthOverviewCardProps) {
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
        <div className="flex items-center justify-center py-12">
          <div className="flex flex-col items-center gap-3">
            <LoadingSpinner className="" />
            <p className="text-sm text-muted-foreground">Loading health overview...</p>
          </div>
        </div>
      ) : healthHosts.length > 0 ? (
        <div className="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border">
          {healthHosts.slice(0, 6).map((host) => (
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
