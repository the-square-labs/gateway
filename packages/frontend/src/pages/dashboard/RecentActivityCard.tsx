import { Link } from "react-router-dom";
import { EmptyState } from "@/components/common/EmptyState";
import { PanelShell } from "@/components/common/PanelShell";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatRelativeDate } from "@/lib/utils";
import type { AuditLogEntry } from "@/types";

interface RecentActivityCardProps {
  activity: AuditLogEntry[];
  hasScope: (scope: string) => boolean;
  loading?: boolean;
}

export function RecentActivityCard({
  activity,
  hasScope,
  loading = false,
}: RecentActivityCardProps) {
  if (!hasScope("admin:audit")) return null;

  const activityColumns: SimpleTableColumn<AuditLogEntry>[] = [
    {
      id: "user",
      header: "User",
      render: (entry) => entry.userName || entry.userEmail || "System",
    },
    {
      id: "action",
      header: "Action",
      render: (entry) => <Badge variant="secondary">{entry.action}</Badge>,
    },
    {
      id: "resource",
      header: "Resource",
      cellClassName: "text-muted-foreground",
      render: (entry) =>
        `${entry.resourceType}${entry.resourceId ? ` / ${entry.resourceId.slice(0, 8)}...` : ""}`,
    },
    {
      id: "time",
      header: "Time",
      cellClassName: "text-muted-foreground",
      render: (entry) => formatRelativeDate(entry.createdAt),
    },
  ];

  return (
    <PanelShell
      title="Recent Activity"
      actions={
        <Link
          to="/administration/audit"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
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
      ) : activity.length > 0 ? (
        <SimpleTable
          columns={activityColumns}
          rows={activity}
          getRowKey={(entry) => entry.id}
          tableClassName="min-w-[640px]"
        />
      ) : (
        <EmptyState message="No recent activity" embedded />
      )}
    </PanelShell>
  );
}
