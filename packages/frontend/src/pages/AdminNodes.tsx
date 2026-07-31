import { FolderPlus, Plus, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { CopyCodeBlock } from "@/components/common/CopyCodeBlock";
import { CopyValueField } from "@/components/common/CopyValueField";
import { EmptyState } from "@/components/common/EmptyState";
import { FolderedResourceList } from "@/components/common/FolderedResourceList";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtime } from "@/hooks/use-realtime";
import { nodeIconClassNames } from "@/lib/node-appearance";
import { nodeRoute } from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDaemonUpdatesStore } from "@/stores/daemon-updates";
import { useNodesStore } from "@/stores/nodes";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import type { Node, NodeStatus } from "@/types";
import { effectiveNodeStatus, isNodeIncompatible, isNodeUpdating } from "@/types";

type EnrollmentTargets = {
  public?: {
    label: string;
    gateway: string | null;
  };
  local?: {
    label: string;
    gateway: string;
  };
};

const NODE_TYPES = [
  {
    value: "nginx",
    label: "Nginx",
    description: "Reverse proxy node running nginx",
    disabled: false,
  },
  {
    value: "docker",
    label: "Docker",
    description: "Docker container management agent",
    disabled: false,
  },
  {
    value: "monitoring",
    label: "Monitoring",
    description: "System monitoring agent — no nginx required",
    disabled: false,
  },
  {
    value: "bastion",
    label: "Bastion",
    description: "SSH bastion host (coming soon)",
    disabled: true,
  },
];

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
  const [enrollResultDialogOpen, setEnrollResultDialogOpen] = useState(false);
  const [enrollType, setEnrollType] = useState<string>("nginx");
  const [enrollDisplayName, setEnrollDisplayName] = useState("");
  const [enrollResult, setEnrollResult] = useState<{
    type: string;
    token: string;
    gatewayCertSha256: string;
    targets?: EnrollmentTargets;
  } | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [createFolderAction, setCreateFolderAction] = useState<(() => void) | null>(null);
  const enrollResultResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  useEffect(() => {
    return () => {
      if (enrollResultResetTimerRef.current) clearTimeout(enrollResultResetTimerRef.current);
    };
  }, []);

  const handleSearch = () => setFilters({ search: searchInput });
  const hasActiveFilters = filters.search !== "" || filters.status !== "all";
  const canManageFolders = hasScope("nodes:folders:manage");

  const handleDelete = useCallback(
    async (nodeId: string, hostname: string) => {
      const ok = await confirm({
        title: "Remove Node",
        description: `Are you sure you want to remove "${hostname}"? This cannot be undone.`,
        confirmLabel: "Remove",
      });
      if (!ok) return;
      try {
        await api.deleteNode(nodeId);
        usePinnedNodesStore.getState().removePin(nodeId);
        toast.success("Node removed");
        fetchNodes();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to remove node");
      }
    },
    [fetchNodes]
  );

  const handleEnroll = async () => {
    const displayName = enrollDisplayName.trim();
    if (!displayName) {
      toast.error("Node name is required");
      return;
    }

    setEnrolling(true);
    try {
      const result = await api.createNode({
        type: enrollType,
        hostname: "pending",
        displayName,
      });
      setEnrollResult({
        type: enrollType,
        token: result.enrollmentToken,
        gatewayCertSha256: result.gatewayCertSha256,
        targets: result.gatewayEnrollmentTargets,
      });
      setEnrollDialogOpen(false);
      setEnrollResultDialogOpen(true);
      setEnrollType("nginx");
      setEnrollDisplayName("");
      fetchNodes();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create node");
    } finally {
      setEnrolling(false);
    }
  };

  const closeEnrollDialog = () => {
    setEnrollDialogOpen(false);
  };

  const handleEnrollDialogOpenChange = (open: boolean) => {
    if (open) {
      setEnrollType("nginx");
      setEnrollDisplayName("");
      setEnrollDialogOpen(true);
      return;
    }

    closeEnrollDialog();
  };

  const closeEnrollResultDialog = () => {
    setEnrollResultDialogOpen(false);
    if (enrollResultResetTimerRef.current) clearTimeout(enrollResultResetTimerRef.current);
    enrollResultResetTimerRef.current = setTimeout(() => {
      setEnrollResult(null);
      enrollResultResetTimerRef.current = null;
    }, 220);
  };

  const scriptUrl = "https://gitlab.wiolett.net/wiolett/gateway/-/raw/main/scripts/setup-daemon.sh";

  const fallbackGatewayAddr = `${window.location.hostname}:9443`;
  const enrollmentTargets = enrollResult
    ? [
        {
          id: "public",
          label: enrollResult.targets?.public?.label ?? "Public node",
          gateway: enrollResult.targets?.public?.gateway ?? fallbackGatewayAddr,
        },
        ...(enrollResult.targets?.local
          ? [
              {
                id: "local",
                label: enrollResult.targets.local.label,
                gateway: enrollResult.targets.local.gateway,
              },
            ]
          : []),
      ]
    : [];

  const commandForTarget = (gateway: string, transport: "curl" | "wget") => {
    if (!enrollResult) return "";
    const fetcher = transport === "curl" ? `curl -sSL ${scriptUrl}` : `wget -qO- ${scriptUrl}`;
    return `${fetcher} | sudo bash -s -- \\\n  --type ${enrollResult.type} \\\n  --gateway ${gateway} \\\n  --token ${enrollResult.token} \\\n  --gateway-cert-sha256 ${enrollResult.gatewayCertSha256}`;
  };

  const copyCommandValue = (command: string) => command.replace(/\\\n\s*/g, "");
  const canCreateNode = enrollDisplayName.trim().length > 0;
  const warningClassName =
    "border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-foreground";

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
        renderCell: (node) => <Badge variant="secondary">{node.type}</Badge>,
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
          const typeStatus = daemonUpdates.find((s) => s.daemonType === node.type);
          const nodeStatus = typeStatus?.nodes.find((n) => n.nodeId === node.id);
          if (nodeStatus?.updateAvailable && typeStatus?.latestVersion) {
            return <Badge className="bg-warning text-black">{typeStatus.latestVersion}</Badge>;
          }
          const eStatus = effectiveNodeStatus(node);
          return <Badge variant={STATUS_BADGE[eStatus] || "secondary"}>{eStatus}</Badge>;
        },
      },
      {
        id: "actions",
        label: "Actions",
        width: "10%",
        align: "right",
        renderCell: (node) =>
          hasScope("nodes:delete") ? (
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
              message="No nodes found. Add a node to start managing nginx instances remotely."
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

      {/* Enrollment Create Dialog */}
      <Dialog open={enrollDialogOpen} onOpenChange={handleEnrollDialogOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Node</DialogTitle>
            <DialogDescription>
              Create a node entry and get the setup command to run on the target host.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Node Type</label>
              <Select value={enrollType} onValueChange={setEnrollType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {NODE_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value} disabled={t.disabled}>
                      <div className="flex items-center gap-2">
                        <span>{t.label}</span>
                        {t.disabled && (
                          <span className="text-xs text-muted-foreground">(coming soon)</span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {NODE_TYPES.find((t) => t.value === enrollType)?.description}
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Node Name</label>
              <Input
                value={enrollDisplayName}
                onChange={(e) => setEnrollDisplayName(e.target.value)}
                placeholder="US-East Proxy"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeEnrollDialog}>
              Cancel
            </Button>
            <Button onClick={handleEnroll} disabled={enrolling || !canCreateNode}>
              {enrolling ? "Creating..." : "Create Node"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Enrollment Result Dialog */}
      <Dialog
        open={enrollResultDialogOpen}
        onOpenChange={(open) => !open && closeEnrollResultDialog()}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Node Created</DialogTitle>
          </DialogHeader>

          {enrollResult && (
            <div className="space-y-4">
              <div className={warningClassName}>
                <p className="font-medium">
                  The enrollment token is single-use and will not be shown again.
                </p>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium">Setup Command</label>
                <p className="text-xs text-muted-foreground">
                  Run on the target host as root.{" "}
                  {enrollResult.type === "docker"
                    ? "Installs the Docker management daemon and enrolls with this Gateway."
                    : enrollResult.type === "monitoring"
                      ? "Installs the monitoring agent and enrolls with this Gateway."
                      : "Installs nginx, the daemon, and enrolls with this Gateway."}
                </p>
                {enrollmentTargets.length > 1 && (
                  <p className="text-xs text-muted-foreground">
                    Use the public command for remote hosts and the local command for nodes on the
                    private network.
                  </p>
                )}
                <Tabs defaultValue={enrollmentTargets[0]?.id ?? "public"}>
                  {enrollmentTargets.length > 1 && (
                    <TabsList className="mb-2">
                      {enrollmentTargets.map((target) => (
                        <TabsTrigger key={target.id} value={target.id}>
                          {target.label}
                        </TabsTrigger>
                      ))}
                    </TabsList>
                  )}
                  {enrollmentTargets.map((target) => {
                    const curlCommand = commandForTarget(target.gateway, "curl");
                    const wgetCommand = commandForTarget(target.gateway, "wget");
                    return (
                      <TabsContent key={target.id} value={target.id} className="mt-0">
                        <Tabs defaultValue="curl">
                          <TabsList>
                            <TabsTrigger value="curl">curl</TabsTrigger>
                            <TabsTrigger value="wget">wget</TabsTrigger>
                          </TabsList>
                          <TabsContent value="curl" className="mt-2">
                            <CopyCodeBlock
                              label="curl command"
                              value={curlCommand}
                              copyValue={copyCommandValue(curlCommand)}
                              className="[&>p]:hidden"
                            />
                          </TabsContent>
                          <TabsContent value="wget" className="mt-2">
                            <CopyCodeBlock
                              label="wget command"
                              value={wgetCommand}
                              copyValue={copyCommandValue(wgetCommand)}
                              className="[&>p]:hidden"
                            />
                          </TabsContent>
                        </Tabs>
                      </TabsContent>
                    );
                  })}
                </Tabs>
              </div>

              <div className="space-y-1.5">
                <label className="text-sm font-medium">Enrollment Token</label>
                <p className="text-xs text-muted-foreground">
                  For manual setup. See the documentation for details.
                </p>
                <CopyValueField label="Enrollment token" value={enrollResult.token} />
              </div>
            </div>
          )}

          <DialogFooter>
            <Button onClick={closeEnrollResultDialog}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
