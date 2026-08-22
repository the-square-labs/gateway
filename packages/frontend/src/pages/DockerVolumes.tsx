import { Database, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { confirm } from "@/components/common/ConfirmDialog";
import { EmptyState } from "@/components/common/EmptyState";
import { PageTransition } from "@/components/common/PageTransition";
import type { ResourceListColumn } from "@/components/common/ResourceListLayout";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
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
import { useRealtime } from "@/hooks/use-realtime";
import { loadVisibleDockerNodes } from "@/lib/docker-node-access";
import { nodeBadgeClassName } from "@/lib/node-appearance";
import { dockerVolumeRoute } from "@/lib/resource-routes";
import { createReturnNavigationState } from "@/lib/return-navigation";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { handleLicenseApiError, requireMinimumLicensePlan } from "@/stores/license-paywall";
import type { DockerVolume, Node, NodeAppearanceColor } from "@/types";

interface DockerVolumeListItem extends DockerVolume {
  _nodeId: string;
  _nodeSlug: string;
  _nodeName?: string;
  _nodeColor?: NodeAppearanceColor | null;
}

export function DockerVolumes({
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
  const { volumes, selectedNodeId, setSelectedNode, fetchVolumes } = useDockerStore();
  const requestSnapshotRefresh = useDockerStore((s) => s.requestSnapshotRefresh);
  const isLoading = useDockerStore((s) => s.loading.volumes);
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
    setCreateNodeId(fixedNodeId || selectedNodeId || "");
    setCreateOpen(true);
  }, [fixedNodeId, selectedNodeId]);
  useEffect(() => {
    onCreateRef?.(() => openCreate());
  }, [onCreateRef, openCreate]);
  useEffect(() => {
    onRefreshRef?.(() => void requestSnapshotRefresh("volumes", visibleNodeId));
  }, [onRefreshRef, requestSnapshotRefresh, visibleNodeId]);
  const [createName, setCreateName] = useState("");
  const [createStorageKind, setCreateStorageKind] = useState<"regular" | "disk-image">("regular");
  const [createCapacityGb, setCreateCapacityGb] = useState("10");
  const [creating, setCreating] = useState(false);

  const loadVolumeNodes = useCallback(async () => {
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
        ["docker:volumes:view"],
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
    void loadVolumeNodes();
  }, [loadVolumeNodes]);

  useEffect(() => {
    if (!canFetchData) return;
    fetchVolumes(fixedNodeId, search);
    const interval = setInterval(() => fetchVolumes(fixedNodeId, search), 30_000);
    return () => clearInterval(interval);
  }, [canFetchData, fetchVolumes, fixedNodeId, search]);

  useRealtime("docker.volume.changed", (payload) => {
    const ev = payload as { nodeId?: string };
    if (visibleNodeId && ev?.nodeId && ev.nodeId !== visibleNodeId) return;
    fetchVolumes(fixedNodeId, search);
  });
  useRealtime("docker.snapshot.changed", (payload) => {
    const ev = payload as { nodeId?: string; kind?: string };
    if (ev.kind !== "volumes" || (visibleNodeId && ev.nodeId && ev.nodeId !== visibleNodeId))
      return;
    void fetchVolumes(fixedNodeId, search);
  });

  const filteredVolumes = useMemo(() => {
    const sorted = [...volumes].sort((a, b) => a.name.localeCompare(b.name));
    if (!search) return sorted;
    const q = search.toLowerCase();
    return sorted.filter(
      (v) => v.name.toLowerCase().includes(q) || v.driver.toLowerCase().includes(q)
    );
  }, [volumes, search]);
  const truncatedListMeta = volumes.find((volume) => volume._listTruncated);
  const canManageFolders = !fixedNodeId && hasScope("docker:containers:folders:manage");

  const handleRemove = useCallback(
    async (name: string, nodeId?: string) => {
      const nid = nodeId || selectedNodeId;
      if (!nid) return;
      const ok = await confirm({
        title: "Remove Volume",
        description: `Remove volume "${name}"? Any data stored in this volume will be permanently lost.`,
        confirmLabel: "Remove",
      });
      if (!ok) return;
      try {
        await api.removeVolume(nid, name);
        toast.success("Volume removed");
        fetchVolumes(undefined, search);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to remove volume");
      }
    },
    [fetchVolumes, selectedNodeId, search]
  );

  const handleCreate = async () => {
    if (!createNodeId || !createName.trim()) return;
    if (
      createStorageKind === "disk-image" &&
      !requireMinimumLicensePlan("personal", "Disk image volumes")
    ) {
      return;
    }
    setCreating(true);
    try {
      await api.createVolume(createNodeId, {
        name: createName.trim(),
        storageKind: createStorageKind,
        ...(createStorageKind === "disk-image"
          ? { capacityBytes: Number(createCapacityGb) * 1024 ** 3 }
          : {}),
      });
      toast.success("Volume created");
      closeCreate();
      fetchVolumes(undefined, search);
    } catch (err) {
      if (!handleLicenseApiError(err, "Disk image volumes")) {
        toast.error(err instanceof Error ? err.message : "Failed to create volume");
      }
    } finally {
      setCreating(false);
    }
  };

  const closeCreate = () => {
    setCreateOpen(false);
    setCreateName("");
    setCreateStorageKind("regular");
    setCreateCapacityGb("10");
  };

  const handleAdopt = useCallback(
    async (name: string, nodeId: string) => {
      try {
        await api.adoptVolume(nodeId, name);
        toast.success("Volume migrated to Gateway management");
        await fetchVolumes(undefined, search);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to migrate volume");
      }
    },
    [fetchVolumes, search]
  );

  const createNodes =
    useDockerStore.getState().dockerNodes.length > 0
      ? useDockerStore.getState().dockerNodes
      : dockerNodes;
  const selectedNode = createNodes.find((n) => n.id === createNodeId);
  const selectedNodeCapabilities = selectedNode?.capabilities as
    | Record<string, unknown>
    | undefined;
  const advertisedNodeCapabilities = Array.isArray(selectedNodeCapabilities?.capabilities)
    ? selectedNodeCapabilities.capabilities
    : [];
  const supportsDiskImages = Boolean(
    selectedNodeCapabilities?.dockerVolumeStorageImagesV1 === true ||
      selectedNodeCapabilities?.docker_volume_storage_images_v1 === true ||
      advertisedNodeCapabilities.includes("docker_volume_storage_images_v1")
  );
  const parsedCreateCapacityGb = Number(createCapacityGb);
  const createCapacityValid =
    Number.isInteger(parsedCreateCapacityGb) && parsedCreateCapacityGb >= 1;

  useEffect(() => {
    if (createOpen && !createNodeId && createNodes.length === 1) {
      setCreateNodeId(createNodes[0].id);
    }
  }, [createNodeId, createNodes, createOpen]);

  useEffect(() => {
    if (createStorageKind === "disk-image" && !supportsDiskImages) {
      setCreateStorageKind("regular");
    }
  }, [createStorageKind, supportsDiskImages]);

  const allVolumeColumns: ResourceListColumn<DockerVolumeListItem>[] = useMemo(
    () => [
      {
        id: "name",
        label: "Name",
        width: "minmax(0, 1.35fr)",
        renderCell: (v) => (
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex items-center justify-center h-8 w-8 rounded-lg bg-muted shrink-0">
              <Database className="h-4 w-4 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex min-w-0 items-center gap-2">
                <TruncateStart text={v.name} className="text-sm font-medium" />
                {v.managementState === "legacy" && (
                  <Badge variant="warning" size="inline">
                    Legacy
                  </Badge>
                )}
              </div>
            </div>
          </div>
        ),
      },
      {
        id: "driver",
        label: "Driver",
        width: "7rem",
        renderCell: (v) => <Badge variant="secondary">{v.driver}</Badge>,
      },
      {
        id: "node",
        label: "Node",
        width: "minmax(0, 1.15fr)",
        renderCell: (v) => (
          <div className="min-w-0">
            <Badge variant="secondary" className={nodeBadgeClassName((v as any)._nodeColor)}>
              <span className="truncate">{(v as any)._nodeName || "-"}</span>
            </Badge>
          </div>
        ),
      },
      {
        id: "usage",
        label: "Usage",
        width: "6.5rem",
        renderCell: (v) => {
          if (v.availability === "unavailable") {
            return (
              <Badge variant="secondary" className="w-fit">
                Unavailable
              </Badge>
            );
          }
          const usedBy: string[] = (v as any).usedBy ?? (v as any).UsedBy ?? [];
          const usedByCount = (v as any).usedByCount ?? usedBy.length;
          const isUsed = usedByCount > 0;
          return isUsed ? (
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
        id: "created",
        label: "Created",
        width: "8rem",
        align: "right" as const,
        renderCell: (v) => (
          <span className="text-sm text-muted-foreground">
            {v.createdAt ? new Date(v.createdAt).toLocaleDateString() : "-"}
          </span>
        ),
      },
      {
        id: "actions",
        label: "Actions",
        width: "9rem",
        align: "right" as const,
        renderCell: (v) => {
          const usedBy: string[] = (v as any).usedBy ?? (v as any).UsedBy ?? [];
          const usedByCount = (v as any).usedByCount ?? usedBy.length;
          const isUsed = usedByCount > 0;
          return (
            <div
              className="flex items-center justify-end pr-1"
              onClick={(e) => e.stopPropagation()}
            >
              {(hasScope("docker:volumes:delete") ||
                hasScope(`docker:volumes:delete:${(v as any)._nodeId}`)) &&
                !isUsed &&
                v.availability !== "unavailable" && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => handleRemove(v.name, (v as any)._nodeId)}
                    title="Remove"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              {v.managementState === "legacy" &&
                v.adoptable &&
                (hasScope("docker:volumes:create") ||
                  hasScope(`docker:volumes:create:${(v as any)._nodeId}`)) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7"
                    onClick={() => handleAdopt(v.name, (v as any)._nodeId)}
                    title="Migrate to Gateway management"
                  >
                    Migrate
                  </Button>
                )}
            </div>
          );
        },
      },
    ],
    [handleAdopt, hasScope, handleRemove]
  );
  const volumeColumns = allVolumeColumns.filter((c) => {
    if (fixedNodeId && c.id === "node") return false;
    if (
      !hasScopedAccess("docker:volumes:delete") &&
      !hasScopedAccess("docker:volumes:create") &&
      c.id === "actions"
    )
      return false;
    return true;
  });

  const content = (
    <>
      {/* Header — hidden in embedded mode */}
      {!embedded && (
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold">Docker Volumes</h1>
              {!isLoading && visibleNodeId && (
                <Badge variant="secondary" size="inline">
                  {volumes.length}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">Manage Docker volumes across your nodes</p>
          </div>
          <ResponsiveHeaderActions
            actions={
              selectedNodeId
                ? [
                    {
                      label: "Refresh",
                      icon: <RefreshCw className="h-4 w-4" />,
                      onClick: () => requestSnapshotRefresh("volumes", visibleNodeId),
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
                    ...(hasScope("docker:volumes:create") ||
                    hasScope(`docker:volumes:create:${selectedNodeId}`)
                      ? [
                          {
                            label: "Create Volume",
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
                  onClick={() => requestSnapshotRefresh("volumes", visibleNodeId)}
                  disabled={isLoading}
                />
                {canManageFolders && (
                  <Button variant="outline" onClick={() => createFolderRef.current?.()}>
                    New Folder
                  </Button>
                )}
                {(hasScope("docker:volumes:create") ||
                  hasScope(`docker:volumes:create:${selectedNodeId}`)) && (
                  <Button onClick={() => openCreate()}>
                    <Plus className="h-4 w-4 mr-1" />
                    Create Volume
                  </Button>
                )}
              </>
            )}
          </ResponsiveHeaderActions>
        </div>
      )}

      <DockerFolderedResourceList<DockerVolumeListItem>
        resourceType="volume"
        resources={filteredVolumes as DockerVolumeListItem[]}
        columns={volumeColumns}
        search={{
          search,
          onSearchChange: setSearch,
          placeholder: "Search volumes by name...",
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
              Showing first {truncatedListMeta._listLimit ?? volumes.length} of{" "}
              {truncatedListMeta._listTotal ?? "many"} volumes. Narrow the node or search filters
              for more specific data.
            </div>
          ) : null
        }
        loading={isLoading || (!visibleNodeId && !nodesLoaded)}
        loadingLabel="Loading volumes..."
        emptyState={
          <EmptyState
            message="No volumes found."
            hasActiveFilters={search !== ""}
            onReset={() => setSearch("")}
            actionLabel={
              hasScope("docker:volumes:create") ||
              (!!selectedNodeId && hasScope(`docker:volumes:create:${selectedNodeId}`))
                ? "Create a volume"
                : undefined
            }
            onAction={
              hasScope("docker:volumes:create") ||
              (!!selectedNodeId && hasScope(`docker:volumes:create:${selectedNodeId}`))
                ? () => openCreate()
                : undefined
            }
          />
        }
        minWidth={fixedNodeId ? "720px" : "860px"}
        fixedNodeId={fixedNodeId}
        canManageFolders={canManageFolders}
        getResourceKey={(volume) => volume.name}
        getResourceLabel={(volume) => volume.name}
        onItemClick={(volume) =>
          navigate(dockerVolumeRoute(volume._nodeSlug, volume.name), {
            state: createReturnNavigationState(location),
          })
        }
        onRefresh={() => fetchVolumes(undefined, search)}
        onCreateFolderRef={(fn) => {
          createFolderRef.current = fn;
          onCreateFolderRef?.(fn);
        }}
      />

      {/* Create Volume Dialog */}
      <Dialog open={createOpen} onOpenChange={closeCreate}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Create Volume</DialogTitle>
            <DialogDescription>
              Create a new volume on{" "}
              {selectedNode?.displayName || selectedNode?.hostname || "the selected node"}.
            </DialogDescription>
          </DialogHeader>
          <AnimatedHeight>
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
                    {createNodes.map((n) => (
                      <SelectItem key={n.id} value={n.id}>
                        {n.displayName || n.hostname}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Volume type</label>
                <Select
                  value={createStorageKind}
                  onValueChange={(value) => setCreateStorageKind(value as "regular" | "disk-image")}
                >
                  <SelectTrigger>
                    <SelectValue>
                      {createStorageKind === "disk-image" ? "Disk image" : "Regular volume"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem
                      value="regular"
                      description="Standard Docker storage using shared node capacity."
                    >
                      Regular volume
                    </SelectItem>
                    <SelectItem
                      value="disk-image"
                      disabled={!supportsDiskImages}
                      description={
                        !selectedNode
                          ? "Select a node to check support."
                          : supportsDiskImages
                            ? "Fixed-capacity ext4 storage that can be expanded later."
                            : "The selected node did not advertise disk-image support."
                      }
                    >
                      Disk image
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {createStorageKind === "disk-image" && (
                <div className="space-y-1.5">
                  <label className="text-sm font-medium" htmlFor="volume-capacity-gb">
                    Capacity, GB <span className="text-destructive">*</span>
                  </label>
                  <Input
                    id="volume-capacity-gb"
                    type="number"
                    min={1}
                    step={1}
                    value={createCapacityGb}
                    onChange={(event) => setCreateCapacityGb(event.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Allocated as a fixed-size ext4 disk image.
                  </p>
                </div>
              )}
              <div className="space-y-1.5">
                <label className="text-sm font-medium">
                  Name <span className="text-destructive">*</span>
                </label>
                <Input
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                  placeholder="my-volume"
                />
              </div>
            </div>
          </AnimatedHeight>
          <DialogFooter>
            <Button variant="outline" onClick={closeCreate}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={
                creating ||
                !createName.trim() ||
                !createNodeId ||
                (createStorageKind === "disk-image" &&
                  (!supportsDiskImages || !createCapacityValid))
              }
            >
              {creating ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
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
