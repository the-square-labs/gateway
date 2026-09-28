import { Link } from "react-router-dom";
import { PanelShell } from "@/components/common/PanelShell";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { proxyHostRoute } from "@/lib/resource-routes";
import type { IngressGroupDetail, IngressGroupDomain, IngressGroupRoute } from "@/types";
import { DELIVERY_BADGE, memberName, shortHash } from "./ingress-group-format";

/**
 * Routes of the group with what each member applied (config hash and certificate version), and the group's
 * domains with the addresses DNS lists.
 */
export function IngressGroupRoutesPanel({ group }: { group: IngressGroupDetail }) {
  const memberColumns: SimpleTableColumn<IngressGroupRoute>[] = group.members.map((member) => ({
    id: `member-${member.nodeId}`,
    header: memberName(member),
    render: (route) => {
      const delivery = route.members.find((candidate) => candidate.nodeId === member.nodeId);
      if (!delivery) return <span className="text-xs text-muted-foreground">—</span>;
      const badge = DELIVERY_BADGE[delivery.status];
      return (
        <div className="space-y-1" title={delivery.lastError ?? undefined}>
          <div className="flex flex-wrap gap-1">
            <Badge variant={badge.variant}>{badge.label}</Badge>
            {route.currentCertificateVersion && delivery.status !== "disabled" && (
              <Badge variant={delivery.certificateCurrent ? "secondary" : "warning"}>
                {delivery.certificateCurrent ? "Certificate current" : "Certificate stale"}
              </Badge>
            )}
          </div>
          <p
            className="font-mono text-xs text-muted-foreground"
            title={delivery.appliedConfigHash ?? undefined}
          >
            config {shortHash(delivery.appliedConfigHash)}
          </p>
          {delivery.lastError && (
            <p className="line-clamp-2 text-xs text-destructive">{delivery.lastError}</p>
          )}
        </div>
      );
    },
  }));

  const routeColumns: SimpleTableColumn<IngressGroupRoute>[] = [
    {
      id: "route",
      header: "Route",
      render: (route) => (
        <div className="min-w-0">
          <Link to={proxyHostRoute(route.slug)} className="text-sm font-medium hover:underline">
            {route.domainNames[0] ?? route.slug}
          </Link>
          {route.domainNames.length > 1 && (
            <p className="text-xs text-muted-foreground">+{route.domainNames.length - 1} more</p>
          )}
        </div>
      ),
    },
    ...memberColumns,
  ];

  const domainColumns: SimpleTableColumn<IngressGroupDomain>[] = [
    {
      id: "domain",
      header: "Domain",
      render: (domain) => <span className="text-sm font-medium">{domain.domain}</span>,
    },
    {
      id: "dns",
      header: "DNS",
      render: (domain) => (
        <div className="flex flex-wrap gap-1">
          <Badge variant="secondary">
            {domain.dnsProvider === "cloudflare" ? "Cloudflare" : "External"}
          </Badge>
          <Badge variant={domain.dnsStatus === "valid" ? "success" : "warning"}>
            {domain.dnsStatus}
          </Badge>
        </div>
      ),
    },
    {
      id: "targets",
      header: "Published addresses",
      render: (domain) => (
        <span className="font-mono text-xs text-muted-foreground">
          {domain.dnsTargetIps.join(", ") || "—"}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <PanelShell
        title="Routes"
        description="What each member applied: route config, certificate version, and the reason when a member did not get it."
      >
        <div className="overflow-x-auto">
          <SimpleTable
            columns={routeColumns}
            rows={group.routes}
            getRowKey={(route) => route.id}
            emptyMessage="No route is served by this group. Place a route on it from the route page."
          />
        </div>
      </PanelShell>
      <PanelShell
        title="Domains"
        description="Cloudflare-managed records list every active member's address; external DNS must list them too."
      >
        <SimpleTable
          columns={domainColumns}
          rows={group.domains}
          getRowKey={(domain) => domain.id}
          emptyMessage="No domain is served by this group."
        />
      </PanelShell>
    </div>
  );
}
