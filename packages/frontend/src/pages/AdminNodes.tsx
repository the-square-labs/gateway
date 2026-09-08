import { Cloud, FolderPlus, Plus, Server, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { InterfaceChoiceDialog } from "@/components/ai/InterfaceChoiceDialog";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtime } from "@/hooks/use-realtime";
import { hostingNodeLabel } from "@/lib/hosting-status";
import { daemonTypeForNode, nodeIconClassNames, nodeTypeLabel } from "@/lib/node-appearance";
import { confirmAndDeleteNode } from "@/lib/remove-node";
import { nodeRoute } from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { authContextKey, useAuthStore } from "@/stores/auth";
import { useDaemonUpdatesStore } from "@/stores/daemon-updates";
import { useNodesStore } from "@/stores/nodes";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import type { Node, NodeStatus } from "@/types";
import { effectiveNodeStatus, isNodeIncompatible, isNodeUpdating } from "@/types";
import type { HostingConnector } from "@/types/hosting";
import { HOSTING_PROVIDER_LABELS, type HostingNodeBinding } from "@/types/hosting";
import { HostingIntegrationsSection } from "./settings/HostingIntegrationsSection";

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
  const { hasScope, hasScopedAccess } = useAuthStore();
  const authKey = useAuthStore((state) => authContextKey(state.user));
  const canViewHosting = hasScopedAccess("integrations:hosting:view");
  const [selectedTab, setSelectedTab] = useState("nodes");
  const { nodes, isLoading, filters, total, fetchNodes, setFilters, resetFilters } =
    useNodesStore();

  const [searchInput, setSearchInput] = useState(filters.search);
  const [enrollDialogOpen, setEnrollDialogOpen] = useState(false);
  const [choiceOpen, setChoiceOpen] = useState(false);
  const [enrollMode, setEnrollMode] = useState<"external" | "hosting">("external");
  const [hostingUnavailable, setHostingUnavailable] = useState(false);
  const [checkingHosting, setCheckingHosting] = useState(false);
  const choiceRequest = useRef(0);
  useEffect(
    () => () => {
      choiceRequest.current += 1;
    },
    []
  );
  const closeChoice = () => {
    choiceRequest.current += 1;
    setChoiceOpen(false);
    setCheckingHosting(false);
  };
  const chooseExternal = () => {
    closeChoice();
    setEnrollMode("external");
    setEnrollDialogOpen(true);
  };
  const chooseHosted = async () => {
    const request = ++choiceRequest.current;
    setCheckingHosting(true);
    try {
      const connectors = await api.listHostingConnectors();
      if (request !== choiceRequest.current) return;
      closeChoice();
      if (!connectors.some((connector) => connector.enabled)) {
        setHostingUnavailable(true);
        return;
      }
      setEnrollMode("hosting");
      setEnrollDialogOpen(true);
    } catch (error) {
      if (request === choiceRequest.current) {
        setCheckingHosting(false);
        toast.error(
          error instanceof Error ? error.message : "Failed to load hosting integrations."
        );
      }
    }
  };
  const [hostingBindings, setHostingBindings] = useState<Record<string, HostingNodeBinding>>({});
  const [hostingAccounts, setHostingAccounts] = useState<Array<{ value: string; label: string }>>(
    []
  );
  const hostingGeneration = useRef(0);
  const updateHostingAccounts = useCallback((accounts: HostingConnector[]) => {
    setHostingAccounts(accounts.map((account) => ({ value: account.id, label: account.name })));
  }, []);
  const refreshHosting = useCallback(() => {
    const generation = ++hostingGeneration.current;
    void api
      .listNodeHostingBindings()
      .then((bindings) => {
        if (generation === hostingGeneration.current) setHostingBindings(bindings);
      })
      .catch(() => {
        if (generation === hostingGeneration.current) setHostingBindings({});
      });
    if (!canViewHosting) {
      setHostingAccounts([]);
      return;
    }
    void api
      .listHostingConnectors()
      .then((accounts) => {
        if (generation === hostingGeneration.current) updateHostingAccounts(accounts);
      })
      .catch(() => {
        // Keep a loaded provider tab available during a transient refresh failure.
        // Identity/permission changes clear this list in the auth-context effect below.
      });
  }, [canViewHosting, updateHostingAccounts]);
  useEffect(() => {
    if (authKey !== authContextKey(useAuthStore.getState().user)) return;
    setHostingAccounts([]);
    setHostingBindings({});
    setSelectedTab("nodes");
    refreshHosting();
    return () => {
      hostingGeneration.current++;
    };
  }, [refreshHosting, authKey]);
  useRealtime("integration.connector.changed", refreshHosting, { onReconnect: refreshHosting });
  const showProviderTabs = canViewHosting && hostingAccounts.length > 0;
  const activeTab = showProviderTabs ? selectedTab : "nodes";
  useEffect(() => {
    if (!showProviderTabs) setSelectedTab("nodes");
  }, [showProviderTabs]);
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
  const hasActiveFilters =
    filters.search !== "" || filters.status !== "all" || filters.hosting !== "all";
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
                  {hostingBindings[node.id] && (
                    <>
                      {" "}
                      ·{" "}
                      {hostingBindings[node.id].connectorName ??
                        HOSTING_PROVIDER_LABELS[hostingBindings[node.id].provider]}
                    </>
                  )}
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
          const hostingPhase = hostingBindings[node.id]?.operationPhase;
          const hostingAction = hostingBindings[node.id]?.operationAction;
          if (
            (node.status === "pending" ||
              ["create", "install", "delete"].includes(hostingAction ?? "")) &&
            hostingPhase &&
            hostingPhase !== "ready"
          ) {
            return (
              <Badge variant={hostingPhase === "failed" ? "destructive" : "warning"}>
                {hostingPhase === "failed"
                  ? "Provisioning failed"
                  : hostingNodeLabel({
                      action: hostingAction ?? "create",
                      phase: hostingPhase,
                    })}
              </Badge>
            );
          }
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
              aria-label="Remove node"
              disabled={
                isNodeUpdating(node) ||
                (node.status !== "pending" &&
                  ["create", "install", "delete"].includes(
                    hostingBindings[node.id]?.operationAction ?? ""
                  ) &&
                  !["ready", "failed"].includes(
                    hostingBindings[node.id]?.operationPhase ?? "ready"
                  ))
              }
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
    [daemonUpdates, hasScope, handleDelete, hostingBindings]
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
                {activeTab === "providers"
                  ? `${hostingAccounts.length} hosting account${hostingAccounts.length === 1 ? "" : "s"} connected`
                  : `${total} node${total !== 1 ? "s" : ""} registered`}
              </p>
            </div>
          </div>
          {activeTab === "nodes" && (
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
                ...(hasScopedAccess("nodes:create")
                  ? [
                      {
                        label: "Add Node",
                        icon: <Plus className="h-4 w-4" />,
                        onClick: () => setChoiceOpen(true),
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
              {hasScopedAccess("nodes:create") && (
                <Button onClick={() => setChoiceOpen(true)}>
                  <Plus className="h-4 w-4 mr-1" />
                  Add Node
                </Button>
              )}
            </ResponsiveHeaderActions>
          )}
        </div>

        <Tabs value={activeTab} onValueChange={setSelectedTab}>
          {showProviderTabs && (
            <TabsList aria-label="Infrastructure views">
              <TabsTrigger value="nodes">Nodes</TabsTrigger>
              <TabsTrigger value="providers">Providers</TabsTrigger>
            </TabsList>
          )}
          <TabsContent value="nodes" className={showProviderTabs ? undefined : "mt-0"}>
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
                  <>
                    <Select
                      value={filters.hosting}
                      onValueChange={(hosting) => setFilters({ hosting })}
                    >
                      <SelectTrigger className="w-36">
                        <SelectValue placeholder="Hosting" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">All hosting</SelectItem>
                        <SelectItem value="unmanaged">No hosting link</SelectItem>
                        {hostingAccounts.map((account) => (
                          <SelectItem key={account.value} value={account.value}>
                            {account.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
                  </>
                ),
              }}
              loading={isLoading}
              loadingLabel="Loading nodes..."
              emptyState={
                <EmptyState
                  message="No nodes found. Add a node to start managing infrastructure remotely."
                  actionLabel={hasScopedAccess("nodes:create") ? "Add Node" : undefined}
                  onAction={hasScopedAccess("nodes:create") ? () => setChoiceOpen(true) : undefined}
                  hasActiveFilters={hasActiveFilters}
                  onReset={() => {
                    setSearchInput("");
                    resetFilters();
                  }}
                />
              }
              minWidth={900}
              canManageFolders={canManageFolders}
              canViewItem={(node) =>
                hasScope("nodes:details") || hasScope(`nodes:details:${node.id}`)
              }
              canReorganizeItem={() => canManageFolders}
              getResourceLabel={(node) => node.displayName || node.hostname}
              onItemClick={(node) => navigate(nodeRoute(node.slug))}
              onRefresh={() => fetchNodes()}
              onCreateFolderRef={(fn) => setCreateFolderAction(() => fn)}
            />
          </TabsContent>
          {showProviderTabs && (
            <TabsContent value="providers">
              <HostingIntegrationsSection
                key={authKey}
                title="Providers"
                onConnectorsChange={updateHostingAccounts}
              />
            </TabsContent>
          )}
        </Tabs>
      </div>

      <InterfaceChoiceDialog
        open={choiceOpen}
        busy={checkingHosting}
        onOpenChange={(open) => !open && closeChoice()}
        title="Add Node"
        description="Connect an existing machine or create a new VM through a hosting integration."
        choices={[
          {
            label: "External VM",
            icon: Server,
            description:
              "Connect a machine you already manage. Run the setup command on that host to install the daemon and enroll it with Gateway.",
            onSelect: chooseExternal,
          },
          {
            label: "Hosted VM",
            icon: Cloud,
            description:
              "Create a VM using a connected hosting provider. Gateway provisions the machine, installs the daemon and enrolls the node automatically.",
            onSelect: () => void chooseHosted(),
          },
        ]}
      />
      <Dialog open={hostingUnavailable} onOpenChange={setHostingUnavailable}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Connect a hosting provider</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            To create a hosted VM, connect or enable a hosting provider in Integrations first. You
            can still connect an existing machine as an External VM.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHostingUnavailable(false)}>
              Close
            </Button>
            <Button
              onClick={() => {
                setHostingUnavailable(false);
                navigate("/settings/integrations", {
                  state: { scrollTarget: "hosting-integrations" },
                });
              }}
            >
              Open integrations
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <NodeEnrollmentDialog
        open={enrollDialogOpen}
        onOpenChange={setEnrollDialogOpen}
        initialMode={enrollMode}
        lockMode
        onNodeCreated={() => fetchNodes()}
        onNodeEnrolled={() => fetchNodes()}
        onHostingCreated={fetchNodes}
      />
    </PageTransition>
  );
}
