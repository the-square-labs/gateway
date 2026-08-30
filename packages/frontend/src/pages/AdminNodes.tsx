import { FolderPlus, Plus, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { NodeEnrollmentDialog } from "@/components/nodes/NodeEnrollmentDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRealtime } from "@/hooks/use-realtime";
import { daemonTypeForNode, nodeIconClassNames, nodeTypeLabel } from "@/lib/node-appearance";
import { confirmAndDeleteNode } from "@/lib/remove-node";
import { nodeRoute } from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { useDaemonUpdatesStore } from "@/stores/daemon-updates";
import { useNodesStore } from "@/stores/nodes";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import type { Node, NodeStatus } from "@/types";
import { effectiveNodeStatus, isNodeIncompatible, isNodeUpdating } from "@/types";

const STATUS_BADGE: Record<
  string,
  "default" | "secondary" | "destructive" | "success" | "warning"
> = {
  online: "success",
  offline: "destructive",
  degraded: "warning",
  pending: "secondary",
  error: "destructive",
};

function formatLastSeen(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return "Just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return d.toLocaleDateString();
}

function formatDaemonVersion(version: string | null | undefined): string {
  if (!version) return "";
  return version.startsWith("v") ? version : `v${version}`;
}

export function AdminNodes() {
  const navigate = useNavigate();
  const { hasScope } = useAuthStore();
  const { nodes, isLoading, filters, total, fetchNodes, setFilters, resetFilters } =
    useNodesStore();

  const [searchInput, setSearchInput] = useState(filters.search);
  const [enrollDialogOpen, setEnrollDialogOpen] = useState(false);
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const daemonUpdates = useDaemonUpdatesStore((s) => s.statuses);
  const fetchDaemonUpdates = useDaemonUpdatesStore((s) => s.fetchDaemonUpdates);

  const loadDaemonUpdates = useCallback(
    async (options?: { force?: boolean }) => {
      if (!hasScope("admin:update")) return;
      try {
        await fetchDaemonUpdates(options);
      } catch {
        // ignore
      }
    },
    [fetchDaemonUpdates, hasScope]
  );

  useEffect(() => {
    fetchNodes();
  }, [fetchNodes]);

  useRealtime("node.changed", () => {
    void loadDaemonUpdates({ force: true });
  });

  // Fetch daemon update statuses
  useEffect(() => {
    void loadDaemonUpdates();
  }, [loadDaemonUpdates]);

  const handleSearch = () => setFilters({ search: searchInput });
  const hasActiveFilters = filters.search !== "" || filters.status !== "all";
  const canManageFolders = hasScope("nodes:folders:manage");

  const handleDelete = useCallback(
    async (nodeId: string, hostname: string) => {
      try {
        if (!(await confirmAndDeleteNode(nodeId, hostname))) return;
        usePinnedNodesStore.getState().removePin(nodeId);
        toast.success("Node removed");
        fetchNodes();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to remove node");
      }
    },
    [fetchNodes]
  );

  const columns = useMemo<ResourceListColumn<Node>[]>(
    () => [
      {
        id: "name",
        label: "Name",
        width: "34%",
        renderCell: (node) => {
          const iconClassNames = nodeIconClassNames(node.appearanceColor);
          return (
            <div className="flex min-w-0 items-center gap-4">
              <div className={iconClassNames.wrapper}>
                <Server className={cn("h-5 w-5", iconClassNames.icon)} />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{node.displayName || node.hostname}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {node.displayName ? node.hostname : ""} {formatDaemonVersion(node.daemonVersion)}
                </p>
              </div>
            </div>
          );
        },
      },
      {
        id: "type",
        label: "Type",
        width: "13%",
        align: "center",
        renderCell: (node) => <Badge variant="secondary">{nodeTypeLabel(node.type)}</Badge>,
      },
      {
        id: "lock",
        label: "Lock",
        width: "13%",
        align: "center",
        renderCell: (node) =>
          (node.type === "nginx" || node.type === "docker") && node.serviceCreationLocked ? (
            <Badge variant="warning">LOCKED</Badge>
          ) : (
            <span className="text-muted-foreground">-</span>
          ),
      },
      {
        id: "lastSeen",
        label: "Last Seen",
        width: "16%",
        align: "center",
        renderCell: (node) => <Badge variant="outline">{formatLastSeen(node.lastSeenAt)}</Badge>,
      },
      {
        id: "status",
        label: "Status",
        width: "14%",
        align: "center",
        renderCell: (node) => {
          if (isNodeUpdating(node)) return <Badge variant="warning">UPDATING</Badge>;
          if (isNodeIncompatible(node)) return <Badge variant="destructive">INCOMPATIBLE</Badge>;
          const eStatus = effectiveNodeStatus(node);
          const daemonType = daemonTypeForNode(node.type);
          const typeStatus = daemonUpdates.find((s) => s.daemonType === daemonType);
          const nodeStatus = typeStatus?.nodes.find((n) => n.nodeId === node.id);
          if (eStatus === "online" && nodeStatus?.updateAvailable && typeStatus?.latestVersion) {
            return <Badge className="bg-warning text-black">{typeStatus.latestVersion}</Badge>;
          }
          return <Badge variant={STATUS_BADGE[eStatus] || "secondary"}>{eStatus}</Badge>;
        },
      },
      {
        id: "actions",
        label: "Actions",
        width: "10%",
        align: "right",
        renderCell: (node) =>
          hasScope("nodes:delete") || hasScope(`nodes:delete:${node.id}`) ? (
            <Button
              variant="ghost"
              size="icon"
              disabled={isNodeUpdating(node)}
              onClick={(event) => {
                event.stopPropagation();
                void handleDelete(node.id, node.hostname);
              }}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          ) : null,
      },
    ],
    [daemonUpdates, hasScope, handleDelete]
  );

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-3">
            <LiteModeBackButton />
            <div>
              <h1 className="text-2xl font-bold">Nodes</h1>
              <p className="text-sm text-muted-foreground">
                {total} node{total !== 1 ? "s" : ""} registered
              </p>
            </div>
          </div>
          <ResponsiveHeaderActions
            actions={[
              ...(canManageFolders && createFolderAction
                ? [
                    {
                      label: "Add Folder",
                      icon: <FolderPlus className="h-4 w-4" />,
                      onClick: createFolderAction,
                    },
                  ]
                : []),
              ...(hasScope("nodes:create")
                ? [
                    {
                      label: "Add Node",
                      icon: <Plus className="h-4 w-4" />,
                      onClick: () => setEnrollDialogOpen(true),
                    },
                  ]
                : []),
            ]}
          >
            {canManageFolders && (
              <Button variant="outline" onClick={() => createFolderAction?.()}>
                <FolderPlus className="h-4 w-4" />
                Add Folder
              </Button>
            )}
            {hasScope("nodes:create") && (
              <Button onClick={() => setEnrollDialogOpen(true)}>
                <Plus className="h-4 w-4 mr-1" />
                Add Node
              </Button>
            )}
          </ResponsiveHeaderActions>
        </div>

        <FolderedResourceList<Node>
          resourceType="node"
          realtimeChannel="node.folder.changed"
          resources={nodes}
          columns={columns}
          search={{
            search: searchInput,
            onSearchChange: setSearchInput,
            onSearchSubmit: handleSearch,
            placeholder: "Search by hostname...",
            hasActiveFilters,
            onReset: () => {
              setSearchInput("");
              resetFilters();
            },
            filters: (
              <Select
                value={filters.status}
                onValueChange={(v) => setFilters({ status: v as NodeStatus | "all" })}
              >
                <SelectTrigger className="w-36">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="online">Online</SelectItem>
                  <SelectItem value="offline">Offline</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                </SelectContent>
              </Select>
            ),
          }}
          loading={isLoading}
          loadingLabel="Loading nodes..."
          emptyState={
            <EmptyState
              message="No nodes found. Add a node to start managing infrastructure remotely."
              actionLabel={hasScope("nodes:create") ? "Add Node" : undefined}
              onAction={hasScope("nodes:create") ? () => setEnrollDialogOpen(true) : undefined}
              hasActiveFilters={hasActiveFilters}
              onReset={() => {
                setSearchInput("");
                resetFilters();
              }}
            />
          }
          minWidth={900}
          canManageFolders={canManageFolders}
          canViewItem={(node) => hasScope("nodes:details") || hasScope(`nodes:details:${node.id}`)}
          canReorganizeItem={() => canManageFolders}
          getResourceLabel={(node) => node.displayName || node.hostname}
          onItemClick={(node) => navigate(nodeRoute(node.slug))}
          onRefresh={() => fetchNodes()}
          onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}
        />
      </div>

      <NodeEnrollmentDialog
        open={enrollDialogOpen}
        onOpenChange={setEnrollDialogOpen}
        onNodeCreated={() => fetchNodes()}
        onNodeEnrolled={() => fetchNodes()}
      />
    </PageTransition>
  );
}
