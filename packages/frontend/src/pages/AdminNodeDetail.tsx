import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpCircle, Minus, Pin, Plus, Settings, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { toast } from "sonner";
import { AnimatedHeight } from "@/components/common/AnimatedHeight";
import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
import { confirm } from "@/components/common/ConfirmDialog";
import { DetailPageSkeleton } from "@/components/common/DetailPageSkeleton";
import { PageBackButton } from "@/components/common/PageBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { HealthBars } from "@/components/ui/health-bars";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRealtime } from "@/hooks/use-realtime";
import { useStableNavigate } from "@/hooks/use-stable-navigate";
import { useUrlTab } from "@/hooks/use-url-tab";
import { getForcedDaemonUpdateForNode } from "@/lib/dev-force-updates";
import {
  daemonTypeForNode,
  getNodeAppearanceColor,
  NODE_APPEARANCE_COLOR_OPTIONS,
  nodeTypeLabel,
} from "@/lib/node-appearance";
import { confirmAndDeleteNode } from "@/lib/remove-node";
import { nodeRoute } from "@/lib/resource-routes";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import { ApiRequestError } from "@/services/api-base";
import { useAuthStore } from "@/stores/auth";
import { useDaemonUpdatesStore } from "@/stores/daemon-updates";
import { useDockerStore } from "@/stores/docker";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import type { DockerRuntimeStatus, Node, NodeAppearanceColor, NodeDetail } from "@/types";
import {
  effectiveNodeStatus,
  getNodeUpdateTargetVersion,
  isNodeIncompatible,
  isNodeUpdating,
} from "@/types";
import { Databases } from "./Databases";
import { DockerComposeProjects } from "./DockerComposeProjects";
import { DockerContainers } from "./DockerContainers";
import { DockerImages } from "./DockerImages";
import { DockerNetworks } from "./DockerNetworks";
import { DockerVolumes } from "./DockerVolumes";
import { type FileManagerOperations, FilesTab } from "./docker-detail/FilesTab";
import { BuilderJobsTab } from "./node-detail/BuilderJobsTab";
import { NodeConfigTab } from "./node-detail/NodeConfigTab";
import { NodeConsoleTab } from "./node-detail/NodeConsoleTab";
import { NodeDetailsTab } from "./node-detail/NodeDetailsTab";
import { NodeLogsTab } from "./node-detail/NodeLogsTab";
import { NodeMonitoringTab } from "./node-detail/NodeMonitoringTab";
import { NodeNginxLogsTab } from "./node-detail/NodeNginxLogsTab";

const STATUS_BADGE: Record<
  string,
  "default" | "secondary" | "destructive" | "success" | "warning"
> = {
  online: "success",
  offline: "destructive",
  degraded: "warning",
  pending: "secondary",
  error: "destructive",
  updating: "warning",
};

const OFFLINE_DISABLED_TABS = new Set([
  "monitoring",
  "files",
  "console",
  "nginx-logs",
  "daemon-logs",
]);

const MAX_SERVICE_ADDRESSES = 10;
const SERVICE_ADDRESS_HOSTNAME_RE =
  /^(?=.{1,253}\.?$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.?$/;

function isValidServiceAddress(value: string): boolean {
  if (value.length > 255) return false;
  if (SERVICE_ADDRESS_HOSTNAME_RE.test(value)) return true;
  if (!value.includes(":")) return false;
  try {
    new URL(`http://[${value}]/`);
    return true;
  } catch {
    return false;
  }
}

type ServiceAddressRow = {
  id: number;
  value: string;
};

export function AdminNodeDetail({
  resolvedNodeId,
  resolvedNodeSlug,
}: {
  resolvedNodeId?: string;
  resolvedNodeSlug?: string;
} = {}) {
  const params = useParams<{ id?: string; nodeSlug?: string; tab?: string }>();
  const id = resolvedNodeId ?? params.id;
  const routeSlug = resolvedNodeSlug ?? params.nodeSlug ?? params.id ?? "";
  const navigate = useStableNavigate();
  const { hasScope } = useAuthStore();

  const [node, setNode] = useState<NodeDetail | null>(null);
  const [healthHistory, setHealthHistory] = useState<Array<{ ts: string; status: string }>>([]);
  const [isLoading, setIsLoading] = useState(true);

  const [activeTab, setActiveTab] = useUrlTab(
    [
      "details",
      "monitoring",
      "databases",
      "files",
      "console",
      "configuration",
      "nginx-logs",
      "containers",
      "images",
      "volumes",
      "networks",
      "compose",
      "jobs",
      "daemon-logs",
    ],
    "details",
    (tab) => nodeRoute(routeSlug, tab)
  );

  // Appearance dialog
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [appearanceName, setAppearanceName] = useState("");
  const [appearanceColor, setAppearanceColor] = useState<NodeAppearanceColor | null>(null);
  const [serviceAddressRows, setServiceAddressRows] = useState<ServiceAddressRow[]>([
    { id: 0, value: "" },
  ]);
  const [appearanceSaving, setAppearanceSaving] = useState(false);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [lockSaving, setLockSaving] = useState(false);
  const daemonUpdates = useDaemonUpdatesStore((s) => s.statuses);
  const fetchDaemonUpdates = useDaemonUpdatesStore((s) => s.fetchDaemonUpdates);
  const setDaemonUpdates = useDaemonUpdatesStore((s) => s.setDaemonUpdates);

  // Pin dialog
  const [pinOpen, setPinOpen] = useState(false);
  const { isPinnedDashboard, isPinnedSidebar, toggleDashboard, toggleSidebar } =
    usePinnedNodesStore();
  const nodeUpdating = node ? isNodeUpdating(node) : false;
  const nodeOffline = node?.status === "offline";
  const localIpAddresses = useMemo(
    () =>
      Array.from(
        new Set(
          node?.liveHealthReport?.localIpAddresses ?? node?.lastHealthReport?.localIpAddresses ?? []
        )
      ).sort(),
    [node?.lastHealthReport?.localIpAddresses, node?.liveHealthReport?.localIpAddresses]
  );
  const publicIpAddresses = useMemo(
    () =>
      Array.from(
        new Set(
          node?.liveHealthReport?.publicIpAddresses ??
            node?.lastHealthReport?.publicIpAddresses ??
            []
        )
      ).sort(),
    [node?.lastHealthReport?.publicIpAddresses, node?.liveHealthReport?.publicIpAddresses]
  );
  const nginxPublicAddresses = node?.publicServiceAddresses ?? [];
  const automaticServiceAddress =
    node?.type === "nginx" ? nginxPublicAddresses[0] : localIpAddresses[0] || publicIpAddresses[0];
  const serviceAddressOptions = useMemo<ComboboxOption[]>(() => {
    const options: ComboboxOption[] = [
      {
        value: "",
        label: automaticServiceAddress
          ? `Automatic (${automaticServiceAddress})`
          : "Automatic (no IP reported)",
        group: "Address mode",
        keywords: "automatic detected",
      },
    ];
    const seen = new Set([""]);
    const addAddresses = (addresses: string[], group: string) => {
      for (const address of addresses) {
        if (seen.has(address)) continue;
        seen.add(address);
        options.push({ value: address, label: address, group });
      }
    };
    if (node?.type !== "nginx") addAddresses(localIpAddresses, "Local addresses");
    addAddresses(
      node?.type === "nginx" ? nginxPublicAddresses : publicIpAddresses,
      "Detected public addresses"
    );
    return options;
  }, [
    automaticServiceAddress,
    localIpAddresses,
    nginxPublicAddresses,
    node?.type,
    publicIpAddresses,
  ]);
  const trimmedServiceAddresses = serviceAddressRows.map((row) => row.value.trim());
  const configuredServiceAddresses = trimmedServiceAddresses.filter(Boolean);
  const serviceAddressesDuplicate =
    new Set(configuredServiceAddresses).size !== configuredServiceAddresses.length;
  const serviceAddressesIncomplete = trimmedServiceAddresses.slice(1).some((address) => !address);
  const serviceAddressesInvalid = configuredServiceAddresses.some(
    (address) => !isValidServiceAddress(address)
  );
  const nonInteractiveWhileUpdating =
    nodeUpdating && activeTab !== "details" && activeTab !== "jobs" && activeTab !== "daemon-logs";
  const canUseNodeConsole = !!(id && hasScope(`nodes:console:${id}`)) || hasScope("nodes:console");
  const canViewNodeLogs = !!(id && hasScope(`nodes:logs:${id}`)) || hasScope("nodes:logs");
  const canViewNodeConfig =
    !!(id && (hasScope(`nodes:config:view:${id}`) || hasScope(`nodes:config:edit:${id}`))) ||
    hasScope("nodes:config:view") ||
    hasScope("nodes:config:edit");
  const canEditNodeServiceAddress =
    !!id &&
    (node?.type === "databases"
      ? hasScope("nodes:rename") || hasScope(`nodes:rename:${id}`)
      : node?.type === "nginx"
        ? hasScope("nodes:config:edit") || hasScope(`nodes:config:edit:${id}`)
        : hasScope("docker:containers:config") || hasScope(`docker:containers:config:${id}`));
  const canReadNodeFiles =
    !!id && (hasScope("nodes:files:read") || hasScope(`nodes:files:read:${id}`));
  const canWriteNodeFiles =
    !!id && (hasScope("nodes:files:write") || hasScope(`nodes:files:write:${id}`));
  const isCompatibleNode = !!node && !isNodeIncompatible(node);
  const canShowNodeConsole =
    isCompatibleNode &&
    !nodeUpdating &&
    (node.status === "online" || node.status === "offline") &&
    canUseNodeConsole;
  const canManageServiceCreationLock =
    !!node &&
    (node.type === "nginx" || node.type === "docker") &&
    (hasScope("nodes:lock") || hasScope(`nodes:lock:${node.id}`));
  const canRenameNode = !!id && hasScope(`nodes:rename:${id}`);
  const daemonUpdate = useMemo(() => {
    if (!id || !node) return { available: false, latestVersion: null };
    const forced = getForcedDaemonUpdateForNode(node);
    if (forced) return forced;
    const daemonType = daemonTypeForNode(node.type);
    const typeStatus = daemonUpdates.find((status) => status.daemonType === daemonType);
    const nodeStatus = typeStatus?.nodes.find((status) => status.nodeId === id);
    return {
      available: !!(nodeStatus?.updateAvailable && typeStatus?.latestVersion),
      latestVersion:
        nodeStatus?.updateAvailable && typeStatus?.latestVersion ? typeStatus.latestVersion : null,
    };
  }, [daemonUpdates, id, node]);
  const visibleTabs = useMemo(
    () => [
      "details",
      ...(isCompatibleNode ? ["monitoring"] : []),
      ...(isCompatibleNode && node?.type === "databases" ? ["databases"] : []),
      ...(isCompatibleNode && node.type === "nginx" && canViewNodeConfig ? ["configuration"] : []),
      ...(isCompatibleNode && node.type === "nginx" && canViewNodeLogs ? ["nginx-logs"] : []),
      ...(isCompatibleNode && canReadNodeFiles ? ["files"] : []),
      ...(isCompatibleNode && node.type === "docker"
        ? ["containers", "images", "volumes", "networks"]
        : []),
      ...(node?.type === "builder" ? ["jobs"] : []),
      ...(canShowNodeConsole ? ["console"] : []),
      ...(canViewNodeLogs ? ["daemon-logs"] : []),
    ],
    [
      canReadNodeFiles,
      canShowNodeConsole,
      canViewNodeConfig,
      canViewNodeLogs,
      isCompatibleNode,
      node,
    ]
  );

  const nodeFileOperations = useMemo<FileManagerOperations | undefined>(() => {
    if (!id || !canReadNodeFiles) return undefined;
    const readOperations = {
      listDirectory: (path: string) => api.listNodeDir(id, path),
      readFile: (path: string) => api.readNodeFile(id, path),
      openFile: (filePath: string, writable = false) => {
        const params = new URLSearchParams({ path: filePath });
        if (writable && canWriteNodeFiles) params.set("writable", "1");
        const fileName = filePath.split("/").pop() || "file";
        window.open(
          `/nodes/file/${id}?${params}`,
          `node-file-${id}-${fileName}`,
          "width=900,height=600,menubar=no,toolbar=no"
        );
      },
    };
    if (!canWriteNodeFiles) return readOperations;
    return {
      ...readOperations,
      createFile: (path, content, onProgress) => api.createNodeFile(id, path, content, onProgress),
      createDirectory: (path) => api.createNodeDirectory(id, path),
      deletePath: (path) => api.deleteNodeFile(id, path),
      movePath: (fromPath, toPath) => api.moveNodeFile(id, fromPath, toPath),
      initUpload: (path, totalBytes) => api.initNodeFileUpload(id, path, totalBytes),
      uploadChunk: (uploadId, offset, content, onProgress) =>
        api.uploadNodeFileChunk(id, uploadId, offset, content, onProgress),
      completeUpload: (uploadId, path, totalBytes) =>
        api.completeNodeFileUpload(id, uploadId, path, totalBytes),
      abortUpload: (uploadId) => api.abortNodeFileUpload(id, uploadId),
    };
  }, [canReadNodeFiles, canWriteNodeFiles, id]);

  const loadNode = useCallback(
    async (silent = false) => {
      if (!id) return;
      if (!silent) setIsLoading(true);
      try {
        const [data, history] = await Promise.all([api.getNode(id), api.getNodeHealthHistory(id)]);
        setNode(data);
        setHealthHistory(history);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) {
          usePinnedNodesStore.getState().removePin(id);
        }
        if (!silent) {
          toast.error("Failed to load node");
          navigate("/nodes");
        }
      } finally {
        if (!silent) setIsLoading(false);
      }
    },
    [id, navigate]
  );

  const refreshNodeDetails = useCallback(async () => {
    if (!id) return;
    setNode(await api.getNode(id));
  }, [id]);

  const loadDaemonUpdateStatus = useCallback(
    async (options?: { force?: boolean }) => {
      if (!id || !hasScope("admin:update")) return;
      try {
        await fetchDaemonUpdates(options);
      } catch {
        // ignore
      }
    },
    [fetchDaemonUpdates, hasScope, id]
  );

  useEffect(() => {
    if (!node) return;
    if (!visibleTabs.includes(activeTab) || (nodeOffline && OFFLINE_DISABLED_TABS.has(activeTab))) {
      setActiveTab("details");
    }
  }, [activeTab, node, nodeOffline, setActiveTab, visibleTabs]);

  useEffect(() => {
    loadNode();
    const interval = setInterval(() => loadNode(true), 30000);
    return () => clearInterval(interval);
  }, [loadNode]);

  useEffect(() => {
    void loadDaemonUpdateStatus();
  }, [loadDaemonUpdateStatus]);

  useRealtime(id ? "node.changed" : null, (payload) => {
    const event = payload as { id?: string; action?: string };
    if (!id || event.id !== id) return;
    if (event.action === "deleted") {
      navigate("/nodes");
      return;
    }
    loadNode(true);
    void loadDaemonUpdateStatus({ force: true });
  });

  useRealtime(id ? "docker.runtime.changed" : null, (payload) => {
    const event = payload as { nodeId?: string; status?: DockerRuntimeStatus };
    if (!id || event.nodeId !== id || !event.status) return;
    setNode((current) =>
      current
        ? {
            ...current,
            capabilities: {
              ...(current.capabilities ?? {}),
              dockerRuntimeStatus: event.status,
            },
          }
        : current
    );
  });

  useRealtime(id ? "node.slug.changed" : null, (payload) => {
    const event = payload as { id?: string; oldSlug?: string; slug?: string };
    if (event.id !== id || event.oldSlug !== routeSlug || !event.slug) return;
    navigate(nodeRoute(event.slug, activeTab), { replace: true });
  });

  useEffect(() => {
    if (
      nodeUpdating &&
      activeTab !== "details" &&
      activeTab !== "jobs" &&
      activeTab !== "daemon-logs"
    ) {
      setActiveTab("details");
    }
  }, [activeTab, nodeUpdating, setActiveTab]);

  const openAppearanceDialog = () => {
    if (!node) return;
    setAppearanceName(node.displayName ?? "");
    setAppearanceColor(node.appearanceColor ?? null);
    const configuredAddresses =
      node.serviceAddresses ??
      [node.serviceAddress, node.secondaryServiceAddress].filter(
        (address): address is string => !!address
      );
    setServiceAddressRows(
      (configuredAddresses.length > 0 ? configuredAddresses : [""]).map((value, index) => ({
        id: index,
        value,
      }))
    );
    setAppearanceOpen(true);
  };

  const handleAppearanceSave = async () => {
    if (!id) return;
    setAppearanceSaving(true);
    try {
      const update = {
        displayName: appearanceName.trim() || null,
        appearanceColor,
        ...((node?.type === "docker" || node?.type === "databases" || node?.type === "nginx") &&
        canEditNodeServiceAddress
          ? { serviceAddresses: configuredServiceAddresses }
          : {}),
      };
      let updated: Node;
      try {
        updated = await api.updateNode(id, update);
      } catch (error) {
        if (
          !(error instanceof ApiRequestError) ||
          error.code !== "NODE_SERVICE_ADDRESS_DOMAINS_AFFECTED" ||
          node?.type !== "nginx"
        ) {
          throw error;
        }
        const details = error.details as
          | {
              domainCount?: number;
              domains?: string[];
              previousAddress?: string;
              nextAddress?: string;
              previousAddresses?: string[];
              nextAddresses?: string[];
            }
          | undefined;
        const approved = await confirm({
          title: "Update domain DNS targets",
          description: `This Ingress node is used by ${details?.domainCount ?? "one or more"} domain${details?.domainCount === 1 ? "" : "s"}. Their tracked DNS target must be updated to one of: ${details?.nextAddresses?.join(", ") || details?.nextAddress || "unavailable"}.${details?.domains?.length ? ` Affected: ${details.domains.join(", ")}.` : ""}`,
          confirmLabel: "Update DNS targets",
        });
        if (!approved) return;
        updated = await api.updateNode(id, { ...update, confirmDomainDnsUpdate: true });
      }
      setNode((prev) => (prev ? { ...prev, ...updated } : prev));
      if (updated.slug && updated.slug !== routeSlug) {
        navigate(nodeRoute(updated.slug, activeTab), { replace: true });
      }
      useDockerStore.getState().syncNodeAppearance(updated);
      setAppearanceOpen(false);
      usePinnedNodesStore.getState().invalidate();
      toast.success("Node updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update");
    } finally {
      setAppearanceSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!node) return;
    try {
      if (!(await confirmAndDeleteNode(node.id, node.hostname))) return;
      usePinnedNodesStore.getState().removePin(node.id);
      toast.success("Node removed");
      navigate("/nodes");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove");
    }
  };

  const handleCheckUpdates = async () => {
    if (!node) return;
    setCheckingUpdates(true);
    try {
      const statuses = await api.checkDaemonUpdates();
      setDaemonUpdates(statuses);
      const daemonType = daemonTypeForNode(node.type);
      const typeStatus = statuses.find((status) => status.daemonType === daemonType);
      const nodeStatus = typeStatus?.nodes.find((status) => status.nodeId === node.id);

      if (nodeStatus?.updateAvailable && typeStatus?.latestVersion) {
        toast.info(`Update available: ${typeStatus.latestVersion}`);
      } else {
        toast.success("Node daemon is already up to date");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to check daemon updates");
    } finally {
      setCheckingUpdates(false);
    }
  };

  const handleServiceCreationLock = async (serviceCreationLocked: boolean) => {
    if (!node) return;
    setLockSaving(true);
    try {
      const updated = await api.setNodeServiceCreationLock(node.id, serviceCreationLocked);
      setNode(updated);
      toast.success(
        serviceCreationLocked ? "Service creation locked" : "Service creation unlocked"
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update lock");
    } finally {
      setLockSaving(false);
    }
  };

  if (isLoading) return <DetailPageSkeleton label="Loading node" tabs={6} />;
  if (!node)
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Node not found
      </div>
    );

  const updateTargetVersion = getNodeUpdateTargetVersion(node);
  const nodeState = nodeUpdating ? "updating" : effectiveNodeStatus(node);
  const detailsTabRefreshKey = [
    "details",
    node.id,
    node.daemonVersion ?? "unknown",
    nodeUpdating ? "updating" : "stable",
  ].join(":");
  const usesFillLayout =
    activeTab === "configuration" ||
    activeTab === "daemon-logs" ||
    activeTab === "nginx-logs" ||
    activeTab === "jobs" ||
    activeTab === "console";

  return (
    <PageTransition>
      <div
        className={
          usesFillLayout
            ? "h-full p-6 flex flex-col gap-4 overflow-hidden"
            : activeTab === "containers"
              ? "h-full overflow-y-auto px-6 pt-6 pb-3 space-y-4"
              : "h-full overflow-y-auto p-6 space-y-4"
        }
      >
        {/* Header — matches ProxyHostDetail pattern */}
        <div className="flex items-start justify-between gap-3 shrink-0">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <PageBackButton onClick={() => navigate("/nodes")} />
            <div className="min-w-0">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="min-w-0 truncate text-2xl font-bold">
                  {node.displayName || node.hostname}
                </h1>
                <Badge variant={STATUS_BADGE[nodeState] || "secondary"} size="inline">
                  {nodeState}
                </Badge>
                {(node.type === "nginx" || node.type === "docker") &&
                  node.serviceCreationLocked && (
                    <Badge variant="warning" size="inline">
                      Locked
                    </Badge>
                  )}
              </div>
              <p className="text-sm text-muted-foreground">
                {node.hostname} &middot; {nodeTypeLabel(node.type)} &middot;{" "}
                {node.daemonVersion ?? "unknown version"}
                {nodeUpdating && updateTargetVersion ? (
                  <> &middot; updating to {updateTargetVersion}</>
                ) : null}
                {node.osInfo ? <> &middot; {node.osInfo}</> : null}
              </p>
            </div>
          </div>

          <ResponsiveHeaderActions
            actions={[
              {
                label: "Pin",
                icon: <Pin className="h-4 w-4" />,
                onClick: () => setPinOpen(true),
                disabled: nodeUpdating,
              },
              ...(canRenameNode
                ? [
                    {
                      label: "Settings",
                      icon: <Settings className="h-4 w-4" />,
                      onClick: openAppearanceDialog,
                      disabled: nodeUpdating,
                    },
                  ]
                : []),
              ...(canManageServiceCreationLock
                ? [
                    {
                      label: node.serviceCreationLocked
                        ? "Unlock new services"
                        : "Lock new services",
                      onClick: () => handleServiceCreationLock(!node.serviceCreationLocked),
                      disabled: lockSaving || nodeUpdating,
                    },
                  ]
                : []),
              ...(hasScope("admin:update")
                ? [
                    {
                      label: "Check for updates",
                      icon: <ArrowUpCircle className="h-4 w-4" />,
                      onClick: handleCheckUpdates,
                      disabled: nodeUpdating || checkingUpdates,
                      separatorBefore: canManageServiceCreationLock,
                    },
                  ]
                : []),
              ...(hasScope("nodes:delete") || hasScope(`nodes:delete:${node.id}`)
                ? [
                    {
                      label: "Remove",
                      icon: <Trash2 className="h-4 w-4" />,
                      onClick: handleDelete,
                      destructive: true,
                      separatorBefore: hasScope("admin:update") || canManageServiceCreationLock,
                    },
                  ]
                : []),
            ]}
          >
            <Button
              variant="outline"
              size="icon"
              onClick={() => setPinOpen(true)}
              disabled={nodeUpdating}
            >
              <Pin className="h-4 w-4" />
            </Button>
            {canRenameNode && (
              <Button variant="outline" disabled={nodeUpdating} onClick={openAppearanceDialog}>
                <Settings className="h-4 w-4" />
                Settings
              </Button>
            )}
            {canManageServiceCreationLock && (
              <Button
                variant="outline"
                onClick={() => handleServiceCreationLock(!node.serviceCreationLocked)}
                disabled={lockSaving || nodeUpdating}
              >
                {node.serviceCreationLocked ? "Unlock new services" : "Lock new services"}
              </Button>
            )}
            {hasScope("admin:update") && (
              <Button
                variant="outline"
                onClick={handleCheckUpdates}
                disabled={nodeUpdating || checkingUpdates}
              >
                <ArrowUpCircle className="h-4 w-4" />
                Check for updates
              </Button>
            )}
            {(hasScope("nodes:delete") || hasScope(`nodes:delete:${node.id}`)) && (
              <Button variant="destructive" onClick={handleDelete} disabled={nodeUpdating}>
                <Trash2 className="h-4 w-4" />
                Remove
              </Button>
            )}
          </ResponsiveHeaderActions>
        </div>

        {/* Health bars */}
        <HealthBars history={healthHistory} currentStatus={node.status} />

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={setActiveTab}
          className={`flex flex-col ${usesFillLayout ? "flex-1 min-h-0" : ""}`}
        >
          <TabsList className="shrink-0">
            <TabsTrigger value="details">Details</TabsTrigger>
            {!isNodeIncompatible(node) && (
              <TabsTrigger value="monitoring" disabled={nodeUpdating || nodeOffline}>
                Monitoring
              </TabsTrigger>
            )}
            {!isNodeIncompatible(node) && node.type === "databases" && (
              <TabsTrigger value="databases" disabled={nodeUpdating}>
                Databases
              </TabsTrigger>
            )}
            {!isNodeIncompatible(node) && canReadNodeFiles && (
              <TabsTrigger value="files" disabled={nodeUpdating || nodeOffline}>
                Files
              </TabsTrigger>
            )}
            {!isNodeIncompatible(node) && node.type === "nginx" && canViewNodeConfig && (
              <TabsTrigger value="configuration" disabled={nodeUpdating}>
                Configuration
              </TabsTrigger>
            )}
            {!isNodeIncompatible(node) && node.type === "nginx" && canViewNodeLogs && (
              <TabsTrigger value="nginx-logs" disabled={nodeUpdating || nodeOffline}>
                Nginx Logs
              </TabsTrigger>
            )}
            {!isNodeIncompatible(node) && node.type === "docker" && (
              <>
                <TabsTrigger value="containers" disabled={nodeUpdating}>
                  Containers
                </TabsTrigger>
                <TabsTrigger value="images" disabled={nodeUpdating}>
                  Images
                </TabsTrigger>
                <TabsTrigger value="volumes" disabled={nodeUpdating}>
                  Volumes
                </TabsTrigger>
                <TabsTrigger value="networks" disabled={nodeUpdating}>
                  Networks
                </TabsTrigger>
                <TabsTrigger value="compose" disabled={nodeUpdating}>
                  Compose
                </TabsTrigger>
              </>
            )}
            {node.type === "builder" && <TabsTrigger value="jobs">Jobs</TabsTrigger>}
            {canShowNodeConsole && (
              <TabsTrigger value="console" disabled={nodeOffline}>
                Console
              </TabsTrigger>
            )}
            {canViewNodeLogs && (
              <TabsTrigger value="daemon-logs" disabled={nodeOffline}>
                Logs
              </TabsTrigger>
            )}
          </TabsList>

          {isNodeIncompatible(node) && (
            <div className="bg-destructive/10 border border-destructive/20 p-3 mt-2 rounded-md">
              <p className="text-sm text-destructive font-medium">
                This node's daemon version is incompatible with the gateway. Update the daemon to
                restore full functionality.
              </p>
            </div>
          )}

          <div className={usesFillLayout ? "relative flex flex-col flex-1 min-h-0" : "relative"}>
            {nonInteractiveWhileUpdating && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-background/85 backdrop-blur-sm">
                <div className="border border-border bg-card px-6 py-4 text-center">
                  <p className="text-sm font-medium">Node daemon update in progress</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Interactive node actions are locked until the update completes.
                  </p>
                </div>
              </div>
            )}
            <TabsContent key={detailsTabRefreshKey} value="details">
              <NodeDetailsTab
                node={node}
                canManageSecureRuntime={hasScope("admin:update")}
                daemonUpdate={daemonUpdate}
                refreshNode={refreshNodeDetails}
                refreshDaemonUpdateStatus={loadDaemonUpdateStatus}
              />
            </TabsContent>
            {!isNodeIncompatible(node) && (
              <TabsContent value="monitoring">
                {activeTab === "monitoring" && !nodeOffline && (
                  <NodeMonitoringTab
                    nodeId={node.id}
                    nodeStatus={node.status}
                    nodeType={node.type}
                    initialHealthReport={node.liveHealthReport ?? node.lastHealthReport}
                    initialStatsReport={node.liveStatsReport ?? node.lastStatsReport}
                  />
                )}
              </TabsContent>
            )}
            {!isNodeIncompatible(node) && node.type === "databases" && (
              <TabsContent value="databases" className="pb-0">
                {activeTab === "databases" && <Databases embedded managedNodeId={node.id} />}
              </TabsContent>
            )}
            {!isNodeIncompatible(node) && node.type === "nginx" && canViewNodeConfig && (
              <TabsContent value="configuration" className="flex flex-col flex-1 min-h-0">
                {activeTab === "configuration" && (
                  <NodeConfigTab
                    nodeId={node.id}
                    nodeStatus={node.status}
                    actionLocked={nodeUpdating}
                  />
                )}
              </TabsContent>
            )}
            {!isNodeIncompatible(node) && node.type === "nginx" && canViewNodeLogs && (
              <TabsContent value="nginx-logs" className="flex flex-col flex-1 min-h-0">
                {activeTab === "nginx-logs" && !nodeOffline && (
                  <NodeNginxLogsTab nodeId={node.id} nodeStatus={node.status} />
                )}
              </TabsContent>
            )}
            {!isNodeIncompatible(node) && canReadNodeFiles && nodeFileOperations && (
              <TabsContent value="files">
                {activeTab === "files" && !nodeOffline && (
                  <FilesTab
                    nodeId={node.id}
                    canBrowse={canReadNodeFiles}
                    operations={nodeFileOperations}
                    realtimeEvent="node.file.changed"
                    realtimeMatches={(payload) =>
                      (payload as { nodeId?: string } | undefined)?.nodeId === node.id
                    }
                  />
                )}
              </TabsContent>
            )}
            {!isNodeIncompatible(node) && node.type === "docker" && (
              <>
                <TabsContent value="containers">
                  {activeTab === "containers" && (
                    <DockerContainers embedded fixedNodeId={node.id} />
                  )}
                </TabsContent>
                <TabsContent value="images">
                  {activeTab === "images" && <DockerImages embedded fixedNodeId={node.id} />}
                </TabsContent>
                <TabsContent value="volumes">
                  {activeTab === "volumes" && <DockerVolumes embedded fixedNodeId={node.id} />}
                </TabsContent>
                <TabsContent value="networks">
                  {activeTab === "networks" && <DockerNetworks embedded fixedNodeId={node.id} />}
                </TabsContent>
                <TabsContent value="compose">
                  {activeTab === "compose" && (
                    <DockerComposeProjects embedded fixedNodeId={node.id} />
                  )}
                </TabsContent>
              </>
            )}
            {node.type === "builder" && (
              <TabsContent value="jobs" className="flex min-h-0 flex-1 flex-col pb-0">
                {activeTab === "jobs" && <BuilderJobsTab nodeId={node.id} />}
              </TabsContent>
            )}
            {canShowNodeConsole && !nodeOffline && (
              <TabsContent value="console" className="flex flex-col flex-1 min-h-0">
                {activeTab === "console" && <NodeConsoleTab nodeId={node.id} />}
              </TabsContent>
            )}
            {canViewNodeLogs && (
              <TabsContent value="daemon-logs" className="flex flex-col flex-1 min-h-0">
                {activeTab === "daemon-logs" && !nodeOffline && (
                  <NodeLogsTab nodeId={node.id} nodeStatus={node.status} />
                )}
              </TabsContent>
            )}
          </div>
        </Tabs>
      </div>

      {/* Settings Dialog */}
      <Dialog open={appearanceOpen} onOpenChange={setAppearanceOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Node Settings</DialogTitle>
          </DialogHeader>
          <AnimatedHeight>
            <div className="space-y-5">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Display Name</label>
                <Input
                  aria-label="Display Name"
                  value={appearanceName}
                  onChange={(e) => setAppearanceName(e.target.value)}
                  placeholder={node.hostname}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleAppearanceSave();
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  Leave empty to use the hostname ({node.hostname})
                </p>
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Color</label>
                <div className="grid grid-cols-8 gap-2">
                  <button
                    type="button"
                    aria-label="Default color"
                    className={cn(
                      "aspect-square w-full border border-input bg-muted",
                      appearanceColor === null && "border-white"
                    )}
                    style={appearanceColor === null ? { borderColor: "#fff" } : undefined}
                    onClick={() => setAppearanceColor(null)}
                  />
                  {NODE_APPEARANCE_COLOR_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      aria-label={`${option.label} color`}
                      className={cn(
                        "aspect-square w-full border border-input",
                        option.swatchClassName,
                        appearanceColor === option.value && "border-white"
                      )}
                      style={appearanceColor === option.value ? { borderColor: "#fff" } : undefined}
                      onClick={() => setAppearanceColor(option.value)}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span>Preview:</span>
                  <Badge
                    variant="secondary"
                    size="inline"
                    className={getNodeAppearanceColor(appearanceColor)?.badgeClassName}
                  >
                    {appearanceName.trim() || node.hostname}
                  </Badge>
                </div>
              </div>
              {(node.type === "docker" || node.type === "databases" || node.type === "nginx") && (
                <div className="space-y-1.5">
                  <label className="text-sm font-medium">Service Addresses</label>
                  <div className="w-full border border-input bg-background">
                    <AnimatePresence initial={false} mode="popLayout">
                      {serviceAddressRows.map((row, index) => (
                        <motion.div
                          layout
                          key={row.id}
                          initial={{ opacity: 0, y: 4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: 4 }}
                          transition={{
                            opacity: { duration: 0.12 },
                            y: { duration: 0.12, ease: [0.25, 0.1, 0.25, 1] },
                          }}
                          className="flex min-w-0 border-b border-input last:border-b-0"
                        >
                          <Combobox
                            freeText
                            showAllOptionsOnFocus
                            ariaLabel={`Service Address ${index + 1}`}
                            value={row.value}
                            options={
                              index === 0
                                ? serviceAddressOptions
                                : serviceAddressOptions.filter((option) => option.value)
                            }
                            placeholder={
                              index === 0
                                ? automaticServiceAddress
                                  ? `Automatic (${automaticServiceAddress})`
                                  : "Automatic (no IP reported)"
                                : node.type === "nginx"
                                  ? "Public IPv4 or IPv6 address"
                                  : "IPv4, IPv6, or hostname"
                            }
                            searchPlaceholder="Enter or select an address"
                            emptyMessage="Enter a valid IP address or hostname."
                            disabled={!canEditNodeServiceAddress}
                            className="min-w-0 flex-1"
                            inputClassName="h-9 rounded-none border-0 font-mono text-xs shadow-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                            renderOption={(option) =>
                              option.value ? (
                                <span className="font-mono text-xs">{option.label}</span>
                              ) : (
                                option.label
                              )
                            }
                            onValueChange={(value) =>
                              setServiceAddressRows((rows) =>
                                rows.map((candidate) =>
                                  candidate.id === row.id ? { ...candidate, value } : candidate
                                )
                              )
                            }
                          />
                          {serviceAddressRows.length > 1 ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`Remove service address ${index + 1}`}
                              className="h-9 w-9 shrink-0 rounded-none border-l border-input bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                              disabled={!canEditNodeServiceAddress}
                              onClick={() =>
                                setServiceAddressRows((rows) =>
                                  rows.filter((candidate) => candidate.id !== row.id)
                                )
                              }
                            >
                              <Minus className="h-4 w-4" />
                            </Button>
                          ) : null}
                          {index === serviceAddressRows.length - 1 &&
                          serviceAddressRows.length < MAX_SERVICE_ADDRESSES ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label="Add service address"
                              className="h-9 w-9 shrink-0 rounded-none border-l border-input bg-muted text-muted-foreground hover:bg-muted hover:text-foreground"
                              disabled={!canEditNodeServiceAddress}
                              onClick={() =>
                                setServiceAddressRows((rows) => [
                                  ...rows,
                                  {
                                    id: Math.max(...rows.map((candidate) => candidate.id)) + 1,
                                    value: "",
                                  },
                                ])
                              }
                            >
                              <Plus className="h-4 w-4" />
                            </Button>
                          ) : null}
                        </motion.div>
                      ))}
                    </AnimatePresence>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {node.type === "databases"
                      ? "Used as the hosts shown for published managed database ports."
                      : node.type === "nginx"
                        ? "Used as the public ingress addresses for domains assigned to this node."
                        : "Used by routes to reach published Docker ports. The first address is preferred."}
                  </p>
                  {serviceAddressesInvalid ? (
                    <p className="text-xs text-destructive">
                      Enter a valid IPv4, IPv6, or hostname for every address.
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          </AnimatedHeight>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAppearanceOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleAppearanceSave}
              disabled={
                appearanceSaving ||
                serviceAddressesIncomplete ||
                serviceAddressesDuplicate ||
                serviceAddressesInvalid
              }
            >
              {appearanceSaving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pin Dialog */}
      <Dialog open={pinOpen} onOpenChange={setPinOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Pin Node</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Add to dashboard</p>
                <p className="text-xs text-muted-foreground">Show overview card on the dashboard</p>
              </div>
              <Switch
                checked={isPinnedDashboard(node.id)}
                onChange={() => toggleDashboard(node.id)}
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Add to sidebar</p>
                <p className="text-xs text-muted-foreground">Quick access link in the sidebar</p>
              </div>
              <Switch checked={isPinnedSidebar(node.id)} onChange={() => toggleSidebar(node.id)} />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </PageTransition>
  );
}
