import { Network, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PageTransition } from "@/components/common/PageTransition";
import { PanelShell } from "@/components/common/PanelShell";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { SimpleTable, type SimpleTableColumn } from "@/components/common/SimpleTable";
import { DockerFolderedResourceList } from "@/components/docker/DockerFolderedResourceList";
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
import { RefreshButton } from "@/components/ui/refresh-button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TruncateStart } from "@/components/ui/truncate-start";
import { useDeferredDialogState } from "@/hooks/use-deferred-dialog-state";
import { useRealtime } from "@/hooks/use-realtime";
import { loadVisibleDockerNodes } from "@/lib/docker-node-access";
import { nodeBadgeClassName } from "@/lib/node-appearance";
import { dockerContainerRoute } from "@/lib/resource-routes";
import { createReturnNavigationState } from "@/lib/return-navigation";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import type { DockerNetwork, Node, NodeAppearanceColor } from "@/types";

interface DockerNetworkListItem extends DockerNetwork {
  _nodeId: string;
  _nodeSlug: string;
  _nodeName?: string;
  _nodeColor?: NodeAppearanceColor | null;
}

const CONTROLLER_NETWORK_PREFIXES = ["gwav-", "gwdep-", "gateway-db-", "gateway-db-av-"];

function isControllerOwnedNetwork(network: DockerNetwork): boolean {
  const name = String(network.name ?? "").toLowerCase();
  const labels = ((network as any).labels ?? (network as any).Labels ?? {}) as Record<
    string,
    string
  >;
  return (
    CONTROLLER_NETWORK_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    labels["wiolett.gateway.internal"] === "true" ||
    labels["wiolett.gateway.availability.policy-id"] !== undefined ||
    labels["wiolett.gateway.deployment-id"] !== undefined ||
    labels["wiolett.gateway.managed-database-binding-id"] !== undefined
  );
}

interface NetworkContainerRow {
  id: string;
  name: string;
  state: string;
  nodeId: string;
  nodeSlug: string;
}

export function DockerNetworks({
  embedded,
  onCreateRef,
  onCreateFolderRef,
  onRefreshRef,
  fixedNodeId,
}: {
  embedded?: boolean;
  onCreateRef?: (fn: () => void) => void;
  onCreateFolderRef?: (fn: () => void) => void;
  onRefreshRef?: (fn: () => void) => void;
  fixedNodeId?: string;
} = {}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { hasScope, hasScopedAccess, user } = useAuthStore();
  const { networks, selectedNodeId, setSelectedNode, fetchNetworks } = useDockerStore();
  const requestSnapshotRefresh = useDockerStore((s) => s.requestSnapshotRefresh);
  const isLoading = useDockerStore((s) => s.loading.networks);
  const storeDockerNodes = useDockerStore((s) => s.dockerNodes);
  const dockerNodesLoaded = useDockerStore((s) => s.dockerNodesLoaded);
  const visibleNodeId = fixedNodeId ?? selectedNodeId;
  const canFetchData = !!visibleNodeId || dockerNodesLoaded;

  const [dockerNodes, setDockerNodes] = useState<Node[]>([]);
  const [nodesLoaded, setNodesLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const createFolderRef = useRef<(() => void) | null>(null);

  // Create dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [createNodeId, setCreateNodeId] = useState<string>("");
  const openCreate = useCallback(() => {
    setCreateNodeId(selectedNodeId || "");
    setCreateName("");
    setCreateDriver("bridge");
    setCreateSubnet("");
    setCreateGateway("");
    setCreateOpen(true);
  }, [selectedNodeId]);
  useEffect(() => {
    onCreateRef?.(() => openCreate());
  }, [onCreateRef, openCreate]);
  useEffect(() => {
    onRefreshRef?.(() => void requestSnapshotRefresh("networks", visibleNodeId));
  }, [onRefreshRef, requestSnapshotRefresh, visibleNodeId]);
  const [createName, setCreateName] = useState("");
  const [createDriver, setCreateDriver] = useState("bridge");
  const [createSubnet, setCreateSubnet] = useState("");
  const [createGateway, setCreateGateway] = useState("");
  const [creating, setCreating] = useState(false);

  // Details dialog
  const {
    open: networkDetailsOpen,
    value: selectedNetwork,
    setValue: setSelectedNetwork,
    close: closeNetworkDetails,
    onOpenChange: onNetworkDetailsOpenChange,
  } = useDeferredDialogState<DockerNetworkListItem>();
  const [detailContainers, setDetailContainers] = useState<NetworkContainerRow[]>([]);
  const [detailContainersLoading, setDetailContainersLoading] = useState(false);

  const openNetworkDetails = useCallback(
    async (net: DockerNetworkListItem) => {
      const nid = (net as any)._nodeId || selectedNodeId;
      const nodeSlug = net._nodeSlug;
      if (!nid) return;
      setSelectedNetwork(net);
      setDetailContainersLoading(true);
      try {
        const c = (net as any).containers ?? (net as any).Containers ?? {};
        const containerIds = Object.keys(c);
        const previewRows = containerIds.map((id) => ({
          id,
          name: c[id]?.name ?? c[id]?.Name ?? id.slice(0, 12),
          state: "",
          nodeId: nid,
          nodeSlug,
        }));
        const containers = await api.listDockerContainers(nid);
        const matched = (containers ?? [])
          .filter((ct: any) => containerIds.includes(ct.id))
          .map((ct: any) => ({
            id: ct.id,
            name: (ct.name ?? "").replace(/^\//, ""),
            state: ct.state,
            nodeId: nid,
            nodeSlug,
          }));
        setDetailContainers(matched.length > 0 ? matched : previewRows);
      } catch {
        const c = (net as any).containers ?? (net as any).Containers ?? {};
        setDetailContainers(
          Object.keys(c).map((id) => ({
            id,
            name: c[id]?.name ?? c[id]?.Name ?? id.slice(0, 12),
            state: "",
            nodeId: nid,
            nodeSlug,
          }))
        );
      } finally {
        setDetailContainersLoading(false);
      }
    },
    [selectedNodeId, setSelectedNetwork]
  );

  const loadNetworkNodes = useCallback(async () => {
    if (embedded && !fixedNodeId) {
      setNodesLoaded(dockerNodesLoaded);
      return;
    }
    if (fixedNodeId) {
      setSelectedNode(fixedNodeId);
      setNodesLoaded(true);
      return;
    }

    try {
      const onlineNodes = await loadVisibleDockerNodes(
        user?.scopes ?? [],
        ["docker:networks:view"],
        hasScopedAccess("nodes:details")
      );
      setDockerNodes(onlineNodes);
      useDockerStore.getState().setDockerNodes(onlineNodes);
      setNodesLoaded(true);
    } catch {
      toast.error("Failed to load Docker nodes");
    }
  }, [dockerNodesLoaded, embedded, fixedNodeId, hasScopedAccess, setSelectedNode, user?.scopes]);

  useEffect(() => {
    void loadNetworkNodes();
  }, [loadNetworkNodes]);

  useEffect(() => {
    if (!canFetchData) return;
    fetchNetworks(fixedNodeId, search);
    const interval = setInterval(() => fetchNetworks(fixedNodeId, search), 30_000);
    return () => clearInterval(interval);
  }, [canFetchData, fetchNetworks, fixedNodeId, search]);

  useRealtime("docker.network.changed", (payload) => {
    const ev = payload as { nodeId?: string };
    if (visibleNodeId && ev?.nodeId && ev.nodeId !== visibleNodeId) return;
    fetchNetworks(fixedNodeId, search);
  });
  useRealtime("docker.snapshot.changed", (payload) => {
    const ev = payload as { nodeId?: string; kind?: string };
    if (ev.kind !== "networks" || (visibleNodeId && ev.nodeId && ev.nodeId !== visibleNodeId))
      return;
    void fetchNetworks(fixedNodeId, search);
  });

  const filteredNetworks = useMemo(() => {
    const sorted = networks
      .filter((network) => !isControllerOwnedNetwork(network))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!search) return sorted;
    const q = search.toLowerCase();
    return sorted.filter(
      (n) =>
        n.name.toLowerCase().includes(q) ||
        n.driver.toLowerCase().includes(q) ||
        n.id.toLowerCase().includes(q)
    );
  }, [networks, search]);
  const truncatedListMeta = networks.find((network) => network._listTruncated);
  const canManageFolders = !fixedNodeId && hasScope("docker:containers:folders:manage");

  const containerCount = useCallback((net: DockerNetwork): number => {
    if (typeof (net as any).containersCount === "number") return (net as any).containersCount;
    const c = (net as any).containers ?? (net as any).Containers;
    return c ? Object.keys(c).length : 0;
  }, []);

  const getIPAM = useCallback((net: DockerNetwork): { subnet: string; gateway: string } => {
    const ipam = (net as any).ipam ?? (net as any).IPAM;
    const cfg = ipam?.Config?.[0] ?? ipam?.config?.[0] ?? {};
    return {
      subnet: cfg.Subnet ?? cfg.subnet ?? "-",
      gateway: cfg.Gateway ?? cfg.gateway ?? "-",
    };
  }, []);

  const handleRemove = useCallback(
    async (net: DockerNetwork & { _nodeId?: string }) => {
      const count = containerCount(net);
      const extra =
        count > 0 ? ` ${count} container${count > 1 ? "s are" : " is"} currently connected.` : "";
      const ok = await confirm({
        title: "Remove Network",
        description: `Remove network "${net.name}"?${extra} This cannot be undone.`,
        confirmLabel: "Remove",
      });
      if (!ok) return;
      try {
        const nid = net._nodeId || selectedNodeId;
        if (!nid) return;
        await api.removeNetwork(nid, net.id);
        toast.success("Network removed");
        fetchNetworks(undefined, search);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to remove network");
      }
    },
    [containerCount, fetchNetworks, selectedNodeId, search]
  );

  const handleCreate = async () => {
    if (!createNodeId || !createName.trim()) return;
    setCreating(true);
    try {
      await api.createNetwork(createNodeId, {
        name: createName.trim(),
        driver: createDriver,
        subnet: createSubnet.trim() || undefined,
        gateway: createGateway.trim() || undefined,
      });
      toast.success("Network created");
      closeCreate();
      fetchNetworks(undefined, search);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create network");
    } finally {
      setCreating(false);
    }
  };

  const closeCreate = () => {
    setCreateOpen(false);
  };

  const selectedNode = dockerNodes.find((n) => n.id === selectedNodeId);

  const allNetworkColumns: ResourceListColumn<DockerNetworkListItem>[] = useMemo(
    () => [
      {
        id: "name",
        label: "Name",
        width: "minmax(0, 1.35fr)",
        renderCell: (net) => (
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-muted shrink-0">
              <Network className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <TruncateStart text={net.name} className="text-sm font-medium" />
              <p className="text-xs text-muted-foreground font-mono truncate">
                {net.id.slice(0, 12)}
              </p>
            </div>
          </div>
        ),
      },
      {
        id: "driver",
        label: "Driver",
        width: "7rem",
        renderCell: (net) => <Badge variant="secondary">{net.driver}</Badge>,
      },
      {
        id: "subnet",
        label: "Subnet",
        width: "10rem",
        renderCell: (net) => {
          const ipam = getIPAM(net);
          return ipam.subnet !== "-" ? (
            <Badge variant="secondary" className="font-mono w-fit">
              {ipam.subnet}
            </Badge>
          ) : (
            <span className="text-xs text-muted-foreground">-</span>
          );
        },
      },
      {
        id: "node",
        label: "Node",
        width: "minmax(0, 1.15fr)",
        renderCell: (n) => (
          <div className="min-w-0">
            <Badge variant="secondary" className={nodeBadgeClassName((n as any)._nodeColor)}>
              <span className="truncate">{(n as any)._nodeName || "-"}</span>
            </Badge>
          </div>
        ),
      },
      {
        id: "usage",
        label: "Usage",
        width: "6.5rem",
        renderCell: (net) => {
          if (net.availability === "unavailable") {
            return (
              <Badge variant="secondary" className="w-fit">
                Unavailable
              </Badge>
            );
          }
          const count = containerCount(net);
          return count > 0 ? (
            <Badge variant="success" className="w-fit">
              In use
            </Badge>
          ) : (
            <Badge variant="secondary" className="w-fit">
              Unused
            </Badge>
          );
        },
      },
      {
        id: "actions",
        label: "Actions",
        width: "5.75rem",
        align: "right" as const,
        renderCell: (net) => {
          const count = containerCount(net);
          return (
            <div
              className="flex items-center justify-end pr-1"
              onClick={(e) => e.stopPropagation()}
            >
              {(hasScope("docker:networks:delete") ||
                hasScope(`docker:networks:delete:${net._nodeId}`)) &&
                count === 0 &&
                net.availability !== "unavailable" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => handleRemove(net)}
                    title="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
            </div>
          );
        },
      },
    ],
    [hasScope, handleRemove, containerCount, getIPAM]
  );
  const networkColumns = allNetworkColumns.filter((c) => {
    if (fixedNodeId && c.id === "node") return false;
    if (!hasScopedAccess("docker:networks:delete") && c.id === "actions") return false;
    return true;
  });
  const detailContainerColumns = useMemo<SimpleTableColumn<NetworkContainerRow>[]>(
    () => [
      {
        id: "container",
        header: "Container",
        cellClassName: "font-medium",
        render: (container) => container.name,
      },
      {
        id: "id",
        header: "ID",
        cellClassName: "font-mono text-muted-foreground",
        render: (container) => container.id.slice(0, 12),
      },
      {
        id: "state",
        header: "State",
        align: "right",
        render: (container) =>
          container.state ? (
            <Badge variant={container.state === "running" ? "success" : "secondary"}>
              {container.state}
            </Badge>
          ) : (
            "-"
          ),
      },
    ],
    []
  );

  const content = (
    <>
      {/* Header — hidden in embedded mode */}
      {!embedded && (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">Docker Networks</h1>
              {!isLoading && visibleNodeId && (
                <Badge variant="secondary" size="inline">
                  {networks.length}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              Manage Docker networks across your nodes
            </p>
          </div>
          <ResponsiveHeaderActions
            actions={
              selectedNodeId
                ? [
                    {
                      label: "Refresh",
                      icon: <RefreshCw className="h-4 w-4" />,
                      onClick: () => requestSnapshotRefresh("networks", visibleNodeId),
                      disabled: isLoading,
                    },
                    ...(canManageFolders
                      ? [
                          {
                            label: "New Folder",
                            onClick: () => createFolderRef.current?.(),
                          },
                        ]
                      : []),
                    ...(hasScope("docker:networks:create") ||
                    hasScope(`docker:networks:create:${selectedNodeId}`)
                      ? [
                          {
                            label: "Create Network",
                            icon: <Plus className="h-4 w-4" />,
                            onClick: () => openCreate(),
                          },
                        ]
                      : []),
                  ]
                : []
            }
          >
            {selectedNodeId && (
              <>
                <RefreshButton
                  onClick={() => requestSnapshotRefresh("networks", visibleNodeId)}
                  disabled={isLoading}
                />
                {canManageFolders && (
                  <Button variant="outline" onClick={() => createFolderRef.current?.()}>
                    New Folder
                  </Button>
                )}
                {(hasScope("docker:networks:create") ||
                  hasScope(`docker:networks:create:${selectedNodeId}`)) && (
                  <Button onClick={() => openCreate()}>
                    <Plus className="h-4 w-4 mr-1" />
                    Create Network
                  </Button>
                )}
              </>
            )}
          </ResponsiveHeaderActions>
        </div>
      )}

      <DockerFolderedResourceList<DockerNetworkListItem>
        resourceType="network"
        resources={filteredNetworks as DockerNetworkListItem[]}
        columns={networkColumns}
        search={{
          search,
          onSearchChange: setSearch,
          placeholder: "Search networks by name or driver...",
          hasActiveFilters: search !== "" || !!selectedNodeId,
          onReset: () => {
            setSearch("");
            setSelectedNode(null);
          },
          filters: (
            <Select
              value={selectedNodeId ?? "__all__"}
              onValueChange={(v) => setSelectedNode(v === "__all__" ? null : v)}
            >
              <SelectTrigger className="w-48">
                <SelectValue placeholder="All nodes" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All nodes</SelectItem>
                {(embedded ? storeDockerNodes : dockerNodes).map((n) => (
                  <SelectItem key={n.id} value={n.id}>
                    {n.displayName || n.hostname}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ),
        }}
        afterSearch={
          truncatedListMeta ? (
            <div className="border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
              Showing first {truncatedListMeta._listLimit ?? networks.length} of{" "}
              {truncatedListMeta._listTotal ?? "many"} networks. Narrow the node or search filters
              for more specific data.
            </div>
          ) : null
        }
        loading={isLoading || (!visibleNodeId && !nodesLoaded)}
        loadingLabel="Loading networks..."
        emptyState={
          <EmptyState
            message="No networks found."
            hasActiveFilters={search !== ""}
            onReset={() => setSearch("")}
            actionLabel={
              hasScope("docker:networks:create") ||
              (!!selectedNodeId && hasScope(`docker:networks:create:${selectedNodeId}`))
                ? "Create a network"
                : undefined
            }
            onAction={
              hasScope("docker:networks:create") ||
              (!!selectedNodeId && hasScope(`docker:networks:create:${selectedNodeId}`))
                ? () => openCreate()
                : undefined
            }
          />
        }
        minWidth={fixedNodeId ? "720px" : "860px"}
        fixedNodeId={fixedNodeId}
        canManageFolders={canManageFolders}
        getResourceKey={(network) => network.id}
        getResourceLabel={(network) => network.name}
        onItemClick={openNetworkDetails}
        onRefresh={() => fetchNetworks(undefined, search)}
        onCreateFolderRef={(fn) => {
          createFolderRef.current = fn;
          onCreateFolderRef?.(fn);
        }}
      />

      {/* Create Network Dialog */}
      <Dialog open={createOpen} onOpenChange={closeCreate}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Network</DialogTitle>
            <DialogDescription>
              Create a new network on{" "}
              {selectedNode?.displayName || selectedNode?.hostname || "the selected node"}.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Node <span className="text-destructive">*</span>
              </label>
              <Select value={createNodeId} onValueChange={setCreateNodeId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a node" />
                </SelectTrigger>
                <SelectContent>
                  {(useDockerStore.getState().dockerNodes.length > 0
                    ? useDockerStore.getState().dockerNodes
                    : dockerNodes
                  ).map((n) => (
                    <SelectItem key={n.id} value={n.id}>
                      {n.displayName || n.hostname}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Name <span className="text-destructive">*</span>
              </label>
              <Input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="my-network"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Driver</label>
              <Select value={createDriver} onValueChange={setCreateDriver}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bridge">bridge</SelectItem>
                  <SelectItem value="overlay">overlay</SelectItem>
                  <SelectItem value="host">host</SelectItem>
                  <SelectItem value="macvlan">macvlan</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Subnet <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                value={createSubnet}
                onChange={(e) => setCreateSubnet(e.target.value)}
                placeholder="172.20.0.0/16"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">
                Gateway <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                value={createGateway}
                onChange={(e) => setCreateGateway(e.target.value)}
                placeholder="172.20.0.1"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeCreate}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={creating || !createName.trim() || !createNodeId}
            >
              {creating ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Network Details Dialog */}
      <Dialog open={networkDetailsOpen} onOpenChange={onNetworkDetailsOpenChange}>
        <DialogContent className="max-w-full sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Network Details</DialogTitle>
            <DialogDescription>
              <span className="font-mono text-xs">{selectedNetwork?.name}</span>
            </DialogDescription>
          </DialogHeader>
          {selectedNetwork && (
            <div className="min-w-0 space-y-4">
              <div className="min-w-0 divide-y divide-border overflow-hidden border border-border bg-card">
                {[
                  ["Name", selectedNetwork.name],
                  ["Network ID", selectedNetwork.id],
                  ["Driver", selectedNetwork.driver],
                  ["Scope", selectedNetwork.scope],
                  ["Subnet", getIPAM(selectedNetwork).subnet],
                  ["Gateway", getIPAM(selectedNetwork).gateway],
                  ["Internal", (selectedNetwork as any).internal ? "Yes" : "No"],
                  ["Attachable", (selectedNetwork as any).attachable ? "Yes" : "No"],
                  ["Ingress", (selectedNetwork as any).ingress ? "Yes" : "No"],
                  ["Containers", String(containerCount(selectedNetwork))],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="grid min-w-0 grid-cols-[minmax(96px,max-content)_minmax(0,1fr)] items-center gap-4 px-4 py-3"
                  >
                    <span className="text-sm text-muted-foreground">{label}</span>
                    <span className="min-w-0 truncate text-right font-mono text-sm" title={value}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>

              <PanelShell title="Connected Containers">
                {selectedNetwork.containersTruncated && (
                  <div className="border-b border-warning/30 bg-warning/10 px-3 py-2 text-sm text-warning-foreground">
                    Showing a preview of connected containers.
                  </div>
                )}
                <SimpleTable
                  columns={detailContainerColumns}
                  rows={detailContainers}
                  getRowKey={(container) => container.id}
                  loading={detailContainersLoading}
                  emptyMessage="No containers found on this network."
                  onRowClick={(container) => {
                    closeNetworkDetails();
                    const nodeSlug =
                      storeDockerNodes.find((node) => node.id === container.nodeId)?.slug ||
                      container.nodeSlug;
                    navigate(dockerContainerRoute(nodeSlug, container.name), {
                      state: createReturnNavigationState(location),
                    });
                  }}
                />
              </PanelShell>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );

  if (embedded) return <div className="flex flex-col flex-1 min-h-0 space-y-4">{content}</div>;

  return (
    <PageTransition>
      <div className="h-full overflow-y-auto p-6 space-y-4">{content}</div>
    </PageTransition>
  );
}
