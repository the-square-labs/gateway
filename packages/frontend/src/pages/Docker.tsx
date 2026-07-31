import {
  ArchiveRestore,
  Box,
  FolderPlus,
  HardDrive,
  Layers,
  ListTodo,
  Network,
  Plus,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { LiteModeBackButton } from "@/components/common/LiteModeBackButton";
import { PageTransition } from "@/components/common/PageTransition";
import { ResponsiveHeaderActions } from "@/components/common/ResponsiveHeaderActions";
import { Button } from "@/components/ui/button";
import { RefreshButton } from "@/components/ui/refresh-button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { type DockerViewNodeScope, loadVisibleDockerNodes } from "@/lib/docker-node-access";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import type { Node as GatewayNode } from "@/types";
import { DockerContainers } from "./DockerContainers";
import { DockerImages } from "./DockerImages";
import { DockerNetworks } from "./DockerNetworks";
import { DockerTasks } from "./DockerTasks";
import { DockerVolumes } from "./DockerVolumes";
import { GwcaImportDialog } from "./docker/GwcaImportDialog";

const TABS = [
  { value: "containers", label: "Containers", icon: Box, scope: "docker:containers:view" },
  { value: "images", label: "Images", icon: Layers, scope: "docker:images:view" },
  { value: "volumes", label: "Volumes", icon: HardDrive, scope: "docker:volumes:view" },
  { value: "networks", label: "Networks", icon: Network, scope: "docker:networks:view" },
  { value: "tasks", label: "Tasks", icon: ListTodo, scope: "docker:tasks" },
] as const;

const DOCKER_NODE_SCOPES_BY_TAB: Partial<
  Record<(typeof TABS)[number]["value"], DockerViewNodeScope[]>
> = {
  containers: ["docker:containers:view"],
  images: ["docker:images:view"],
  volumes: ["docker:volumes:view"],
  networks: ["docker:networks:view"],
};

export function Docker() {
  const { tab: tabParam } = useParams<{ tab?: string }>();
  const navigate = useNavigate();
  const { hasScope, hasScopedAccess, user } = useAuthStore();
  const setSelectedNode = useDockerStore((s) => s.setSelectedNode);
  const setDockerNodes = useDockerStore((s) => s.setDockerNodes);
  const fetchContainers = useDockerStore((s) => s.fetchContainers);
  const fetchImages = useDockerStore((s) => s.fetchImages);
  const fetchVolumes = useDockerStore((s) => s.fetchVolumes);
  const fetchNetworks = useDockerStore((s) => s.fetchNetworks);
  const fetchTasks = useDockerStore((s) => s.fetchTasks);
  const loading = useDockerStore((s) => s.loading);
  const dockerNodes = useDockerStore((s) => s.dockerNodes);
  const [importOpen, setImportOpen] = useState(false);
  const [importDevPreview, setImportDevPreview] = useState(false);
  const archiveImportNodes = dockerNodes.filter(
    (node) =>
      hasScope("docker:containers:create") || hasScope(`docker:containers:create:${node.id}`)
  );

  const deployContainerRef = useRef<(() => void) | null>(null);
  const createFolderRef = useRef<(() => void) | null>(null);
  const createImageFolderRef = useRef<(() => void) | null>(null);
  const createVolumeFolderRef = useRef<(() => void) | null>(null);
  const createNetworkFolderRef = useRef<(() => void) | null>(null);
  const pullImageRef = useRef<(() => void) | null>(null);
  const createVolumeRef = useRef<(() => void) | null>(null);
  const createNetworkRef = useRef<(() => void) | null>(null);
  const refreshContainersRef = useRef<(() => void) | null>(null);
  const refreshImagesRef = useRef<(() => void) | null>(null);
  const refreshVolumesRef = useRef<(() => void) | null>(null);
  const refreshNetworksRef = useRef<(() => void) | null>(null);

  const canManageContainerFolders = hasScope("docker:containers:folders:manage");
  const visibleTabs = TABS.filter(
    (t) => hasScopedAccess(t.scope) || (t.value === "containers" && canManageContainerFolders)
  );
  const visibleTabKey = visibleTabs.map((tab) => tab.value).join("|");
  const activeTab =
    tabParam && visibleTabs.some((t) => t.value === tabParam)
      ? tabParam
      : visibleTabs[0]?.value || "containers";
  const usesFillLayout = activeTab === "tasks";
  const activeTabLoading =
    activeTab === "containers"
      ? loading.containers
      : activeTab === "images"
        ? loading.images
        : activeTab === "volumes"
          ? loading.volumes
          : activeTab === "networks"
            ? loading.networks
            : activeTab === "tasks"
              ? loading.tasks
              : false;

  useEffect(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  // Fetch docker nodes on mount, store in zustand for multi-node fetching
  useEffect(() => {
    const scopeBases =
      DOCKER_NODE_SCOPES_BY_TAB[activeTab as keyof typeof DOCKER_NODE_SCOPES_BY_TAB];
    if (!scopeBases) return;
    loadVisibleDockerNodes(user?.scopes ?? [], scopeBases, hasScopedAccess("nodes:details"))
      .then(setDockerNodes)
      .catch(() => toast.error("Failed to load Docker nodes"));
  }, [activeTab, hasScopedAccess, setDockerNodes, user?.scopes]);

  useEffect(() => {
    let cancelled = false;

    const preload = async () => {
      for (const tab of visibleTabKey.split("|").filter(Boolean)) {
        if (tab === activeTab) continue;
        if (cancelled) return;
        const scopeBases = DOCKER_NODE_SCOPES_BY_TAB[tab as keyof typeof DOCKER_NODE_SCOPES_BY_TAB];
        let nodeIdOverride: string | null | undefined;
        let nodesOverride: GatewayNode[] | undefined;
        if (scopeBases) {
          try {
            const nodes = await loadVisibleDockerNodes(
              user?.scopes ?? [],
              scopeBases,
              hasScopedAccess("nodes:details")
            );
            if (cancelled) return;
            const selectedNodeId = useDockerStore.getState().selectedNodeId;
            nodeIdOverride = nodes.some((node) => node.id === selectedNodeId)
              ? selectedNodeId
              : null;
            nodesOverride = nodes;
          } catch {
            continue;
          }
        }

        if (tab === "containers") await fetchContainers(nodeIdOverride, "", nodesOverride);
        if (tab === "images") await fetchImages(nodeIdOverride, "", nodesOverride);
        if (tab === "volumes") await fetchVolumes(nodeIdOverride, "", nodesOverride);
        if (tab === "networks") await fetchNetworks(nodeIdOverride, "", nodesOverride);
        if (tab === "tasks") await fetchTasks(null);
      }
    };

    void preload();
    return () => {
      cancelled = true;
    };
  }, [
    activeTab,
    fetchContainers,
    fetchImages,
    fetchNetworks,
    fetchTasks,
    fetchVolumes,
    hasScopedAccess,
    user?.scopes,
    visibleTabKey,
  ]);

  const handleTabChange = (value: string) => {
    navigate(`/docker/${value}`, { replace: true });
  };

  const handleRefresh = async () => {
    switch (activeTab) {
      case "containers":
        return refreshContainersRef.current?.();
      case "images":
        return refreshImagesRef.current?.();
      case "volumes":
        return refreshVolumesRef.current?.();
      case "networks":
        return refreshNetworksRef.current?.();
      case "tasks":
        return fetchTasks();
    }
  };

  const openImport = () => {
    setImportDevPreview(false);
    setImportOpen(true);
  };

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === "undefined") return;
    const gatewayDev = (window.gatewayDev ??= {});
    const openGwcaImportModal = () => {
      setImportDevPreview(true);
      setImportOpen(true);
    };
    gatewayDev.openGwcaImportModal = openGwcaImportModal;
    return () => {
      if (gatewayDev.openGwcaImportModal === openGwcaImportModal) {
        delete gatewayDev.openGwcaImportModal;
      }
    };
  }, []);

  const renderActions = () => {
    switch (activeTab) {
      case "containers":
        return (
          <>
            {canManageContainerFolders && (
              <Button variant="outline" onClick={() => createFolderRef.current?.()}>
                <FolderPlus className="h-4 w-4 mr-1" />
                New Folder
              </Button>
            )}
            {hasScopedAccess("docker:containers:create") && (
              <Button variant="outline" onClick={openImport}>
                <ArchiveRestore className="h-4 w-4 mr-1" />
                Import .gwca
              </Button>
            )}
            {hasScopedAccess("docker:containers:create") && (
              <Button onClick={() => deployContainerRef.current?.()}>
                <Plus className="h-4 w-4 mr-1" />
                Deploy
              </Button>
            )}
          </>
        );
      case "images":
        return (
          <>
            {canManageContainerFolders && (
              <Button variant="outline" onClick={() => createImageFolderRef.current?.()}>
                <FolderPlus className="h-4 w-4 mr-1" />
                New Folder
              </Button>
            )}
            {hasScope("docker:images:pull") && (
              <Button onClick={() => pullImageRef.current?.()}>
                <Plus className="h-4 w-4 mr-1" />
                Pull Image
              </Button>
            )}
          </>
        );
      case "volumes":
        return (
          <>
            {canManageContainerFolders && (
              <Button variant="outline" onClick={() => createVolumeFolderRef.current?.()}>
                <FolderPlus className="h-4 w-4 mr-1" />
                New Folder
              </Button>
            )}
            {hasScope("docker:volumes:create") && (
              <Button onClick={() => createVolumeRef.current?.()}>
                <Plus className="h-4 w-4 mr-1" />
                Create Volume
              </Button>
            )}
          </>
        );
      case "networks":
        return (
          <>
            {canManageContainerFolders && (
              <Button variant="outline" onClick={() => createNetworkFolderRef.current?.()}>
                <FolderPlus className="h-4 w-4 mr-1" />
                New Folder
              </Button>
            )}
            {hasScope("docker:networks:create") && (
              <Button onClick={() => createNetworkRef.current?.()}>
                <Plus className="h-4 w-4 mr-1" />
                Create Network
              </Button>
            )}
          </>
        );
      default:
        return null;
    }
  };
  const headerActions = [
    { label: "Refresh", onClick: handleRefresh, disabled: activeTabLoading },
    ...(activeTab === "containers" && canManageContainerFolders
      ? [
          {
            label: "New Folder",
            icon: <FolderPlus className="h-4 w-4" />,
            onClick: () => createFolderRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "containers" && hasScopedAccess("docker:containers:create")
      ? [
          {
            label: "Import .gwca",
            icon: <ArchiveRestore className="h-4 w-4" />,
            onClick: openImport,
          },
          {
            label: "Deploy",
            icon: <Plus className="h-4 w-4" />,
            onClick: () => deployContainerRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "images" && canManageContainerFolders
      ? [
          {
            label: "New Folder",
            icon: <FolderPlus className="h-4 w-4" />,
            onClick: () => createImageFolderRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "images" && hasScope("docker:images:pull")
      ? [
          {
            label: "Pull Image",
            icon: <Plus className="h-4 w-4" />,
            onClick: () => pullImageRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "volumes" && canManageContainerFolders
      ? [
          {
            label: "New Folder",
            icon: <FolderPlus className="h-4 w-4" />,
            onClick: () => createVolumeFolderRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "volumes" && hasScope("docker:volumes:create")
      ? [
          {
            label: "Create Volume",
            icon: <Plus className="h-4 w-4" />,
            onClick: () => createVolumeRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "networks" && canManageContainerFolders
      ? [
          {
            label: "New Folder",
            icon: <FolderPlus className="h-4 w-4" />,
            onClick: () => createNetworkFolderRef.current?.(),
          },
        ]
      : []),
    ...(activeTab === "networks" && hasScope("docker:networks:create")
      ? [
          {
            label: "Create Network",
            icon: <Plus className="h-4 w-4" />,
            onClick: () => createNetworkRef.current?.(),
          },
        ]
      : []),
  ];

  return (
    <PageTransition>
      <div
        className={
          usesFillLayout
            ? "h-full overflow-hidden flex flex-col p-6 gap-4"
            : activeTab === "containers"
              ? "h-full overflow-y-auto px-6 pt-6 pb-3 space-y-4"
              : "h-full overflow-y-auto p-6 space-y-4"
        }
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <LiteModeBackButton />
            <div className="min-w-0">
              <h1 className="text-2xl font-bold">Docker</h1>
              <p className="text-sm text-muted-foreground">
                Manage containers, images, volumes, and networks
              </p>
            </div>
          </div>
          <ResponsiveHeaderActions actions={headerActions}>
            <RefreshButton onClick={handleRefresh} disabled={activeTabLoading} />
            {renderActions()}
          </ResponsiveHeaderActions>
        </div>

        {/* Tabs */}
        <Tabs
          value={activeTab}
          onValueChange={handleTabChange}
          className={`flex flex-col ${usesFillLayout ? "flex-1 min-h-0" : ""}`}
        >
          <TabsList className="shrink-0">
            {visibleTabs.map((tab) => (
              <TabsTrigger key={tab.value} value={tab.value} className="gap-1.5">
                <tab.icon className="h-3.5 w-3.5" />
                {tab.label}
              </TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="containers">
            <DockerContainers
              embedded
              onDeployRef={(fn) => {
                deployContainerRef.current = fn;
              }}
              onCreateFolderRef={(fn) => {
                createFolderRef.current = fn;
              }}
              onRefreshRef={(fn) => {
                refreshContainersRef.current = fn;
              }}
            />
          </TabsContent>
          <TabsContent value="images">
            <DockerImages
              embedded
              onPullRef={(fn) => {
                pullImageRef.current = fn;
              }}
              onCreateFolderRef={(fn) => {
                createImageFolderRef.current = fn;
              }}
              onRefreshRef={(fn) => {
                refreshImagesRef.current = fn;
              }}
            />
          </TabsContent>
          <TabsContent value="volumes">
            <DockerVolumes
              embedded
              onCreateRef={(fn) => {
                createVolumeRef.current = fn;
              }}
              onCreateFolderRef={(fn) => {
                createVolumeFolderRef.current = fn;
              }}
              onRefreshRef={(fn) => {
                refreshVolumesRef.current = fn;
              }}
            />
          </TabsContent>
          <TabsContent value="networks">
            <DockerNetworks
              embedded
              onCreateRef={(fn) => {
                createNetworkRef.current = fn;
              }}
              onCreateFolderRef={(fn) => {
                createNetworkFolderRef.current = fn;
              }}
              onRefreshRef={(fn) => {
                refreshNetworksRef.current = fn;
              }}
            />
          </TabsContent>
          <TabsContent value="tasks" className="flex flex-col flex-1 min-h-0">
            <DockerTasks embedded />
          </TabsContent>
        </Tabs>
        <GwcaImportDialog
          open={importOpen}
          onOpenChange={(nextOpen) => {
            setImportOpen(nextOpen);
            if (!nextOpen) setImportDevPreview(false);
          }}
          nodes={archiveImportNodes}
          onImported={() => refreshContainersRef.current?.()}
          devPreview={importDevPreview}
        />
      </div>
    </PageTransition>
  );
}
