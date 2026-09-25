import { Link } from "react-router-dom";
import { PanelShell } from "@/components/common/PanelShell";
import { proxyHealthTone } from "@/components/common/resource-status";
import { ProxyUpstreamTarget } from "@/components/proxy/ProxyUpstreamTarget";
import { Badge } from "@/components/ui/badge";
import { proxyHostRoute } from "@/lib/resource-routes";
import type { ProxyHost } from "@/types";

interface HealthOverviewCardProps {
  healthHosts: ProxyHost[];
  hasScope: (scope: string) => boolean;
}

function healthOverviewPriority(host: ProxyHost): number {
  const status = host.effectiveHealthStatus ?? host.healthStatus;
  if (status === "offline") return 0;
  if (status === "degraded" || status === "recovering") return 1;
  if (status === "unknown") return 2;
  if (status === "online") return 3;
  if (status === "disabled") return 4;
  return 2;
}

export function sortHealthOverviewHosts(hosts: ProxyHost[]): ProxyHost[] {
  return [...hosts].sort((left, right) => {
    const priorityDifference = healthOverviewPriority(left) - healthOverviewPriority(right);
    if (priorityDifference !== 0) return priorityDifference;

    const leftDomain = [...left.domainNames].sort().join(", ").toLowerCase();
    const rightDomain = [...right.domainNames].sort().join(", ").toLowerCase();
    return leftDomain.localeCompare(rightDomain) || left.id.localeCompare(right.id);
  });
}

export function HealthOverviewCard({ healthHosts, hasScope }: HealthOverviewCardProps) {
  // Omit the panel entirely when there is nothing useful to show on the dashboard.
  if (!hasScope("proxy:view") || healthHosts.length === 0) return null;

  return (
    <PanelShell
      title="Health Overview"
      actions={
        <Link to="/proxy-hosts" className="text-sm text-muted-foreground hover:text-foreground">
          View all
        </Link>
      }
    >
      <div className="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border">
        {sortHealthOverviewHosts(healthHosts)
          .slice(0, 6)
          .map((host) => (
            <Link
              key={host.id}
              to={proxyHostRoute(host.slug)}
              className="flex items-center gap-3 px-4 py-3 hover:bg-accent transition-colors"
            >
              <span className="text-sm font-medium truncate flex-1">
                {host.domainNames.join(", ")}
              </span>
              <ProxyUpstreamTarget host={host} size="inline" />
              <Badge
                variant={proxyHealthTone(host.effectiveHealthStatus ?? host.healthStatus)}
                size="inline"
              >
                {(host.effectiveHealthStatus ?? host.healthStatus) === "online"
                  ? "healthy"
                  : (host.effectiveHealthStatus ?? host.healthStatus)}
              </Badge>
            </Link>
          ))}
      </div>
    </PanelShell>
  );
}
