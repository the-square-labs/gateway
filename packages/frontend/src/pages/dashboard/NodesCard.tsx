import { Link } from "react-router-dom";
import { LoadingSpinner } from "@/components/common/LoadingSpinner";
import { PanelShell } from "@/components/common/PanelShell";
import { Badge } from "@/components/ui/badge";
import { nodeRoute } from "@/lib/resource-routes";
import type { Node } from "@/types";
import { effectiveNodeStatus } from "@/types";

interface NodesCardProps {
  nodesList: Node[];
  hasScope: (scope: string) => boolean;
  loading?: boolean;
}

export function NodesCard({ nodesList, hasScope, loading = false }: NodesCardProps) {
  if (!hasScope("nodes:details") || (!loading && nodesList.length === 0)) return null;

  return (
    <PanelShell
      title="Nodes"
      actions={
        <Link to="/nodes" className="text-sm text-muted-foreground hover:text-foreground">
          View all
        </Link>
      }
    >
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="flex flex-col items-center gap-3">
            <LoadingSpinner className="" />
            <p className="text-sm text-muted-foreground">Loading nodes...</p>
          </div>
        </div>
      ) : nodesList.length > 0 ? (
        <div className="divide-y divide-border -mb-px [&>*:last-child]:border-b [&>*:last-child]:border-border">
          {nodesList.slice(0, 8).map((node) => (
            <Link
              key={node.id}
              to={nodeRoute(node.slug)}
              className="flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors"
            >
              <span className="text-sm font-medium truncate flex-1">
                {node.displayName || node.hostname}
              </span>
              <Badge variant="secondary" size="inline" className="uppercase">
                {node.type}
              </Badge>
              {node.daemonVersion && (
                <Badge variant="outline" size="inline" className="uppercase">
                  {node.daemonVersion}
                </Badge>
              )}
              {(() => {
                const s = effectiveNodeStatus(node);
                const v =
                  s === "online"
                    ? "success"
                    : s === "degraded"
                      ? "warning"
                      : s === "pending"
                        ? "secondary"
                        : "destructive";
                return (
                  <Badge variant={v} size="inline" className="uppercase">
                    {s}
                  </Badge>
                );
              })()}
            </Link>
          ))}
        </div>
      ) : null}
    </PanelShell>
  );
}
