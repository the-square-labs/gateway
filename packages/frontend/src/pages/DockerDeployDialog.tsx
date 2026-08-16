import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Combobox, type ComboboxOption } from "@/components/common/Combobox";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { dockerContainerRoute, dockerDeploymentRoute } from "@/lib/resource-routes";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import {
  type ContainerCreateConfig,
  type DockerRegistry,
  gpuDeviceLabel,
  isNodeIncompatible,
  type Node,
} from "@/types";

const tabContentTransition = { duration: 0.2, ease: [0.25, 0.1, 0.25, 1] as const };
const EMPTY_DOCKER_NODES: Node[] = [];

function normalizeGpuDeviceIds(ids: readonly string[]) {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

interface DockerDeployDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-selected node ID (e.g. from the current node filter) */
  nodeId?: string;
  /** Extra list of docker nodes to show in the node selector */
  dockerNodes?: Node[];
  /** Called after a successful deploy; receives the new container ID if available */
  onDeployed?: (containerId?: string) => void;
}

export function DockerDeployDialog({
  open,
  onOpenChange,
  nodeId,
  dockerNodes = EMPTY_DOCKER_NODES,
  onDeployed,
}: DockerDeployDialogProps) {
  const navigate = useNavigate();
  const { hasScope } = useAuthStore();

  const [deployNodeId, setDeployNodeId] = useState<string>("");
  const [deployImage, setDeployImage] = useState("");
  const [deployRegistryId, setDeployRegistryId] = useState("");
  const [registries, setRegistries] = useState<DockerRegistry[]>([]);
  const [deployLocalImages, setDeployLocalImages] = useState<string[]>([]);
  const [deployPullableImages, setDeployPullableImages] = useState<string[]>([]);
  const [deployName, setDeployName] = useState("");
  const [deployRestart, setDeployRestart] = useState("no");
  const [deploying, setDeploying] = useState(false);
  const [deployMode, setDeployMode] = useState<"container" | "deployment">("container");
  const [routeHostPort, setRouteHostPort] = useState("8080");
  const [routeContainerPort, setRouteContainerPort] = useState("80");
  const [healthPath, setHealthPath] = useState("/");
  const [drainSeconds, setDrainSeconds] = useState("30");
  const [deployGpuDeviceIds, setDeployGpuDeviceIds] = useState<string[]>([]);
  const storeDockerNodes = useDockerStore((state) => state.dockerNodes);
  const allNodes = useMemo(() => {
    return storeDockerNodes.length > 0 ? storeDockerNodes : dockerNodes;
  }, [dockerNodes, storeDockerNodes]);
  const availableNodes = useMemo(
    () =>
      allNodes.filter(
        (node) =>
          !isNodeIncompatible(node) &&
          (hasScope("docker:containers:create") || hasScope(`docker:containers:create:${node.id}`))
      ),
    [allNodes, hasScope]
  );
  const selectedDeployNode = useMemo(
    () => allNodes.find((node) => node.id === deployNodeId),
    [allNodes, deployNodeId]
  );
  const deployGpuDevices = selectedDeployNode?.lastHealthReport?.gpuDevices ?? [];
  const initialNodeLocked = !!(
    nodeId && allNodes.find((candidate) => candidate.id === nodeId)?.serviceCreationLocked
  );
  const availableRegistries = useMemo(
    () =>
      registries.filter(
        (registry) => registry.scope === "global" || registry.nodeId === deployNodeId
      ),
    [deployNodeId, registries]
  );
  const nodeOptions = useMemo<ComboboxOption[]>(
    () =>
      availableNodes.map((node) => ({
        value: node.id,
        label: node.displayName || node.hostname,
        keywords: [node.hostname, node.slug].filter(Boolean).join(" "),
        disabled: node.serviceCreationLocked,
      })),
    [availableNodes]
  );
  const registryOptions = useMemo<ComboboxOption[]>(
    () => [
      { value: "__default__", label: "Docker Hub" },
      ...availableRegistries.map((registry) => ({
        value: registry.id,
        label: registry.name,
        keywords: [registry.url, registry.scope === "node" ? "this node" : "global"]
          .filter(Boolean)
          .join(" "),
      })),
    ],
    [availableRegistries]
  );
  const imageOptions = useMemo<ComboboxOption[]>(
    () => [
      ...deployLocalImages.map((image) => ({
        value: image,
        label: image,
        keywords: "local on this node",
      })),
      ...deployPullableImages.map((image) => ({
        value: image,
        label: image,
        keywords: "remote available to pull",
      })),
    ],
    [deployLocalImages, deployPullableImages]
  );

  // Reset form state when dialog opens
  useEffect(() => {
    if (open) {
      setDeployNodeId(initialNodeLocked ? "" : nodeId || "");
      setDeployImage("");
      setDeployRegistryId("");
      setDeployName("");
      setDeployRestart("no");
      setDeployMode("container");
      setRouteHostPort("8080");
      setRouteContainerPort("80");
      setHealthPath("/");
      setDrainSeconds("30");
      setDeployGpuDeviceIds([]);
    }
  }, [initialNodeLocked, open, nodeId]);

  useEffect(() => {
    if (!open || !hasScope("docker:registries:view")) {
      setRegistries([]);
      return;
    }
    api
      .listDockerRegistries()
      .then(setRegistries)
      .catch(() => setRegistries([]));
  }, [hasScope, open]);

  useEffect(() => {
    if (!open || !deployNodeId) return;
    const selectedNode = availableNodes.find((node) => node.id === deployNodeId);
    if (!selectedNode || selectedNode.serviceCreationLocked) setDeployNodeId("");
  }, [availableNodes, deployNodeId, open]);

  // Fetch local images + pullable images from other nodes when deploy node changes
  useEffect(() => {
    if (!deployNodeId) {
      setDeployLocalImages([]);
      setDeployPullableImages([]);
      return;
    }

    const extractTags = (data: unknown): string[] => {
      const tags: string[] = [];
      for (const img of Array.isArray(data) ? data : []) {
        for (const t of (img as any).repoTags ?? (img as any).RepoTags ?? []) {
          if (t && t !== "<none>:<none>") tags.push(t);
        }
      }
      return tags;
    };

    // Fetch local images
    api
      .listDockerImages(deployNodeId)
      .then((data) => setDeployLocalImages(extractTags(data).sort()))
      .catch(() => setDeployLocalImages([]));

    // Fetch images from other nodes (pullable) — only if user can pull
    if (!hasScope("docker:images:pull") && !hasScope(`docker:images:pull:${deployNodeId}`)) {
      setDeployPullableImages([]);
      return;
    }
    const otherNodes = allNodes.filter((n) => n.id !== deployNodeId);
    if (otherNodes.length > 0) {
      Promise.all(
        otherNodes.map((n) =>
          api
            .listDockerImages(n.id)
            .then(extractTags)
            .catch(() => [] as string[])
        )
      ).then((results) => {
        const localSet = new Set<string>();
        api
          .listDockerImages(deployNodeId)
          .then((d) => {
            for (const t of extractTags(d)) localSet.add(t);
            const pullable = new Set<string>();
            for (const tags of results) {
              for (const t of tags) {
                if (!localSet.has(t)) pullable.add(t);
              }
            }
            setDeployPullableImages(Array.from(pullable).sort());
          })
          .catch(() => {});
      });
    } else {
      setDeployPullableImages([]);
    }
  }, [allNodes, deployNodeId, hasScope]);

  const closeDeploy = () => {
    onOpenChange(false);
    setDeployImage("");
    setDeployName("");
    setDeployRestart("no");
    setDeployMode("container");
    setDeployGpuDeviceIds([]);
  };

  const handleDeploy = async () => {
    if (!deployNodeId || !deployImage.trim()) return;
    if (allNodes.find((n) => n.id === deployNodeId)?.serviceCreationLocked) {
      toast.error("Node is locked for new service creation");
      return;
    }
    if (deployMode === "deployment" && !deployName.trim()) return;
    setDeploying(true);
    try {
      let imageRef = deployImage.trim();
      // Auto-pull if image not available locally
      const isLocal = deployLocalImages.includes(imageRef);
      if (!isLocal) {
        toast.info(`Pulling "${imageRef}"...`);
        const pullResult = await api.pullImageSync(
          deployNodeId,
          imageRef,
          deployRegistryId || undefined
        );
        imageRef = pullResult.imageRef;
      }
      if (deployMode === "deployment") {
        const deployment = await api.createDockerDeployment(deployNodeId, {
          name: deployName.trim(),
          image: imageRef,
          registryId: deployRegistryId || undefined,
          restartPolicy: deployRestart === "no" ? "unless-stopped" : deployRestart,
          routes: [
            {
              hostPort: Number(routeHostPort),
              containerPort: Number(routeContainerPort),
              isPrimary: true,
            },
          ],
          health: {
            path: healthPath || "/",
            statusMin: 200,
            statusMax: 399,
            timeoutSeconds: 5,
            intervalSeconds: 5,
            successThreshold: 2,
            startupGraceSeconds: 5,
            deployTimeoutSeconds: 300,
          },
          drainSeconds: Number(drainSeconds) || 0,
          ...(deployGpuDeviceIds.length > 0 ? { gpu: { deviceIds: deployGpuDeviceIds } } : {}),
        });
        toast.success("Deployment created");
        closeDeploy();
        onDeployed?.(deployment.id);
        const nodeSlug =
          useDockerStore.getState().dockerNodes.find((node) => node.id === deployNodeId)?.slug ||
          availableNodes.find((node) => node.id === deployNodeId)?.slug;
        if (nodeSlug) navigate(dockerDeploymentRoute(nodeSlug, deployment.name));
      } else {
        const config: ContainerCreateConfig = {
          image: imageRef,
          registryId: deployRegistryId || undefined,
          restartPolicy: deployRestart,
          ...(deployGpuDeviceIds.length > 0 ? { gpu: { deviceIds: deployGpuDeviceIds } } : {}),
        };
        if (deployName.trim()) config.name = deployName.trim();
        const result = await api.createContainer(deployNodeId, config);
        toast.success("Container deployed");
        closeDeploy();
        const newId = (result as any)?.id ?? (result as any)?.Id;
        onDeployed?.(newId);
        if (newId) {
          const inspect = await api.inspectContainer(deployNodeId, newId).catch(() => null);
          const canonicalName = String(
            (inspect as any)?.Name ??
              (inspect as any)?.name ??
              (result as any)?.Name ??
              (result as any)?.name ??
              ""
          ).replace(/^\/+/, "");
          const nodeSlug =
            useDockerStore.getState().dockerNodes.find((node) => node.id === deployNodeId)?.slug ||
            availableNodes.find((node) => node.id === deployNodeId)?.slug;
          if (canonicalName && nodeSlug) navigate(dockerContainerRoute(nodeSlug, canonicalName));
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to deploy");
    } finally {
      setDeploying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={closeDeploy}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Deploy</DialogTitle>
          <DialogDescription>Create a container or a blue/green deployment.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Tabs
            value={deployMode}
            onValueChange={(value) => setDeployMode(value as "container" | "deployment")}
          >
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="container">Container</TabsTrigger>
              <TabsTrigger value="deployment">Blue/green</TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Node */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              Node <span className="text-destructive">*</span>
            </label>
            <Combobox
              value={deployNodeId}
              options={nodeOptions}
              onValueChange={(value) => {
                setDeployNodeId(value);
                setDeployImage("");
                setDeployRegistryId("");
                setDeployGpuDeviceIds([]);
              }}
              placeholder="Select a node"
              searchPlaceholder="Search nodes..."
              emptyMessage="No nodes found."
            />
          </div>

          {deployNodeId && deployGpuDevices.length > 0 && (
            <div className="space-y-1.5">
              <label className="text-sm font-medium">GPU</label>
              <p className="text-xs text-muted-foreground">
                Selected physical GPUs are shared with other containers. No capacity is reserved.
              </p>
              <div className="border border-border">
                {deployGpuDevices.map((gpu) => {
                  const checked = deployGpuDeviceIds.includes(gpu.id);
                  const disabled = !gpu.attachable && !checked;
                  return (
                    <label
                      key={gpu.id}
                      className={`flex min-w-0 items-center gap-2 border-b border-border px-3 py-2 text-sm last:border-b-0 ${disabled ? "opacity-60" : "cursor-pointer"}`}
                    >
                      <input
                        type="checkbox"
                        className="form-checkbox shrink-0"
                        checked={checked}
                        disabled={disabled}
                        onChange={() =>
                          setDeployGpuDeviceIds((current) =>
                            normalizeGpuDeviceIds(
                              checked
                                ? current.filter((deviceId) => deviceId !== gpu.id)
                                : [...current, gpu.id]
                            )
                          )
                        }
                      />
                      <span className="min-w-0">
                        <span className="block font-medium">{gpuDeviceLabel(gpu)}</span>
                        <span className="block break-all text-xs text-muted-foreground">
                          {gpu.attachable
                            ? `Shared physical device · ${gpu.id}`
                            : gpu.unavailableReason || "Unavailable for container attachment"}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {deployGpuDeviceIds.length > 0
                  ? `${deployGpuDeviceIds.length} physical GPU${deployGpuDeviceIds.length === 1 ? "" : "s"} selected`
                  : "No GPU selected"}
              </p>
            </div>
          )}

          {/* Registry */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Registry</label>
            <Combobox
              value={deployRegistryId || "__default__"}
              options={registryOptions}
              onValueChange={(value) => setDeployRegistryId(value === "__default__" ? "" : value)}
              placeholder={!deployNodeId ? "Select a node first" : "Docker Hub"}
              searchPlaceholder="Search registries..."
              emptyMessage="No registries found."
              disabled={!deployNodeId}
              renderOption={(option) => {
                const registry = availableRegistries.find(
                  (candidate) => candidate.id === option.value
                );
                if (!registry) return option.label;
                return (
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">{registry.name}</span>
                    <span className="text-muted-foreground">{registry.url}</span>
                    {registry.scope === "node" && (
                      <Badge variant="secondary" size="inline">
                        This node
                      </Badge>
                    )}
                  </span>
                );
              }}
            />
          </div>

          {/* Image */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              Image <span className="text-destructive">*</span>
            </label>
            <Combobox
              freeText
              value={deployImage}
              options={imageOptions}
              onValueChange={setDeployImage}
              placeholder={!deployNodeId ? "Select a node first" : "Select or enter an image"}
              searchPlaceholder="Search or enter an image..."
              disabled={!deployNodeId}
              renderOption={(option) => (
                <span className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 truncate">{option.label}</span>
                  <Badge variant="secondary" size="inline">
                    {deployLocalImages.includes(option.value) ? "On this node" : "Pull"}
                  </Badge>
                </span>
              )}
            />
            {deployImage && !deployLocalImages.includes(deployImage) && deployNodeId && (
              <p className="text-xs text-muted-foreground">Will be pulled to this node on deploy</p>
            )}
          </div>

          {/* Container name */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {deployMode === "deployment" ? "Deployment Name" : "Container Name"}{" "}
              {deployMode === "container" && (
                <span className="text-muted-foreground font-normal">(optional)</span>
              )}
            </label>
            <Input
              value={deployName}
              onChange={(e) => setDeployName(e.target.value)}
              placeholder={deployMode === "deployment" ? "my-app" : "my-container"}
            />
          </div>

          <AnimatePresence initial={false}>
            {deployMode === "deployment" && (
              <motion.div
                key="blue-green-fields"
                className="overflow-hidden"
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={tabContentTransition}
              >
                <motion.div
                  className="space-y-4"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8 }}
                  transition={tabContentTransition}
                >
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Host Port</label>
                      <Input
                        inputMode="numeric"
                        value={routeHostPort}
                        onChange={(e) => setRouteHostPort(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Container Port</label>
                      <Input
                        inputMode="numeric"
                        value={routeContainerPort}
                        onChange={(e) => setRouteContainerPort(e.target.value)}
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Health Path</label>
                      <Input value={healthPath} onChange={(e) => setHealthPath(e.target.value)} />
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-sm font-medium">Drain Seconds</label>
                      <Input
                        inputMode="numeric"
                        value={drainSeconds}
                        onChange={(e) => setDrainSeconds(e.target.value)}
                      />
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Restart policy */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Restart Policy</label>
            <Select value={deployRestart} onValueChange={setDeployRestart}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="no">No</SelectItem>
                <SelectItem value="always">Always</SelectItem>
                <SelectItem value="unless-stopped">Unless Stopped</SelectItem>
                <SelectItem value="on-failure">On Failure</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={closeDeploy}>
            Cancel
          </Button>
          <Button
            onClick={handleDeploy}
            disabled={
              deploying ||
              !deployImage.trim() ||
              !deployNodeId ||
              (deployMode === "deployment" &&
                (!deployName.trim() || !Number(routeHostPort) || !Number(routeContainerPort)))
            }
          >
            {deploying ? "Deploying..." : "Deploy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
