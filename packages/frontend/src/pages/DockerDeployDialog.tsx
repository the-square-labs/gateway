import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import type { ComboboxOption } from "@/components/common/Combobox";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { nodeRoute } from "@/lib/resource-routes";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import {
  handleLicenseApiError,
  requireLicenseFeature,
  requireMinimumLicensePlan,
} from "@/stores/license-paywall";
import {
  type DockerRuntimeProfile,
  type DockerRuntimeStatus,
  isNodeIncompatible,
  type Node,
} from "@/types";
import { DockerDeployFormFields } from "./docker-deploy/DockerDeployFormFields";
import { executeDockerDeploy } from "./docker-deploy/executeDockerDeploy";
import { SecureRuntimeSetupDialog } from "./docker-deploy/SecureRuntimeSetupDialog";
import type {
  DockerDeployMode,
  DockerDeploySourceMode,
  DockerRestartPolicy,
} from "./docker-deploy/types";
import { useDockerDeployData } from "./docker-deploy/useDockerDeployData";

const EMPTY_DOCKER_NODES: Node[] = [];

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
  const [deployName, setDeployName] = useState("");
  const [deployRestart, setDeployRestart] = useState<DockerRestartPolicy>("no");
  const [deploying, setDeploying] = useState(false);
  const [deployMode, setDeployMode] = useState<DockerDeployMode>("container");
  const [sourceMode, setSourceMode] = useState<DockerDeploySourceMode>("image");
  const [sourceConnectorId, setSourceConnectorId] = useState("");
  const [sourceProjectId, setSourceProjectId] = useState("");
  const [sourceBranch, setSourceBranch] = useState("main");
  const [sourceDockerfilePath, setSourceDockerfilePath] = useState("Dockerfile");
  const [sourceContextPath, setSourceContextPath] = useState(".");
  const [sourceAutoBuild, setSourceAutoBuild] = useState(true);
  const [sourceAutoDeploy, setSourceAutoDeploy] = useState(true);
  const [routeHostPort, setRouteHostPort] = useState("8080");
  const [routeContainerPort, setRouteContainerPort] = useState("80");
  const [healthPath, setHealthPath] = useState("/");
  const [drainSeconds, setDrainSeconds] = useState("30");
  const [deployRuntimeProfile, setDeployRuntimeProfile] = useState<DockerRuntimeProfile>("default");
  const [secureRuntimeSetupOpen, setSecureRuntimeSetupOpen] = useState(false);
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
  const {
    checkingSourceAdmission,
    deployLocalImages,
    deployPullableImages,
    registries,
    sourceAdmission,
    sourceConnectorOptions,
    sourceRepositories,
  } = useDockerDeployData({
    allNodes,
    deployNodeId,
    hasScope,
    open,
    sourceConnectorId,
    sourceMode,
  });
  const selectedDeployNode = useMemo(
    () => allNodes.find((node) => node.id === deployNodeId),
    [allNodes, deployNodeId]
  );
  const secureRuntimeStatus = selectedDeployNode?.capabilities?.dockerRuntimeStatus as
    | DockerRuntimeStatus
    | undefined;
  const secureRuntimeAvailable = secureRuntimeStatus?.state === "healthy";
  const secureRuntimeCanBeConfigured = Boolean(
    selectedDeployNode &&
      !secureRuntimeAvailable &&
      (secureRuntimeStatus?.remoteInstallable ||
        secureRuntimeStatus?.state === "installable" ||
        secureRuntimeStatus?.state === "installing" ||
        secureRuntimeStatus?.state === "failed")
  );
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
  const sourceRepositoryOptions = useMemo<ComboboxOption[]>(
    () =>
      sourceRepositories.map((repository) => ({
        value: repository.projectId,
        label: repository.fullPath,
        keywords: [repository.name, repository.webUrl].filter(Boolean).join(" "),
      })),
    [sourceRepositories]
  );

  const resetDeployForm = useCallback(() => {
    setDeployNodeId(initialNodeLocked ? "" : nodeId || "");
    setDeployImage("");
    setDeployRegistryId("");
    setDeployName("");
    setDeployRestart("no");
    setDeployMode("container");
    setSourceMode("image");
    setSourceConnectorId("");
    setSourceProjectId("");
    setSourceBranch("main");
    setSourceDockerfilePath("Dockerfile");
    setSourceContextPath(".");
    setSourceAutoBuild(true);
    setSourceAutoDeploy(true);
    setRouteHostPort("8080");
    setRouteContainerPort("80");
    setHealthPath("/");
    setDrainSeconds("30");
    setDeployRuntimeProfile("default");
  }, [initialNodeLocked, nodeId]);

  useEffect(() => {
    if (open) resetDeployForm();
  }, [open, resetDeployForm]);

  useEffect(() => {
    if (!open || !deployNodeId) return;
    const selectedNode = availableNodes.find((node) => node.id === deployNodeId);
    if (!selectedNode || selectedNode.serviceCreationLocked) setDeployNodeId("");
  }, [availableNodes, deployNodeId, open]);

  const closeDeploy = () => {
    onOpenChange(false);
    setSecureRuntimeSetupOpen(false);
  };

  const handleDeploy = async () => {
    if (!deployNodeId) return;
    if (sourceMode === "image" && !deployImage.trim()) return;
    if (
      sourceMode === "repository" &&
      (!sourceConnectorId ||
        !sourceProjectId ||
        !sourceBranch.trim() ||
        !sourceDockerfilePath.trim() ||
        !sourceContextPath.trim() ||
        !deployName.trim())
    )
      return;
    if (allNodes.find((n) => n.id === deployNodeId)?.serviceCreationLocked) {
      toast.error("Node is locked for new service creation");
      return;
    }
    if (deployMode === "deployment" && !deployName.trim()) return;
    if (sourceMode === "repository" && !requireMinimumLicensePlan("business", "Git push-to-deploy"))
      return;
    if (
      deployMode === "deployment" &&
      !requireLicenseFeature("blue-green", "Blue/green deployments")
    )
      return;
    if (
      deployRuntimeProfile === "secure" &&
      !requireLicenseFeature("secure-runtime", "Secure Runtime")
    )
      return;
    setDeploying(true);
    try {
      await executeDockerDeploy({
        availableNodes,
        closeDeploy,
        deployImage,
        deployLocalImages,
        deployMode,
        deployName,
        deployNodeId,
        deployRegistryId,
        deployRestart,
        deployRuntimeProfile,
        drainSeconds,
        healthPath,
        navigate,
        onDeployed,
        routeContainerPort,
        routeHostPort,
        sourceAutoBuild,
        sourceAutoDeploy,
        sourceBranch,
        sourceConnectorId,
        sourceContextPath,
        sourceDockerfilePath,
        sourceMode,
        sourceProjectId,
      });
    } catch (err) {
      if (
        !handleLicenseApiError(
          err,
          sourceMode === "repository" ? "Git push-to-deploy" : "Container deployment"
        )
      ) {
        toast.error(err instanceof Error ? err.message : "Failed to deploy");
      }
    } finally {
      setDeploying(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={closeDeploy}>
      <DialogContent
        className="sm:max-w-lg"
        onAnimationEnd={(event) => {
          if (
            event.target === event.currentTarget &&
            event.currentTarget.dataset.state === "closed"
          ) {
            resetDeployForm();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Deploy</DialogTitle>
          <DialogDescription>Create a container or a blue/green deployment.</DialogDescription>
        </DialogHeader>

        <DockerDeployFormFields
          availableRegistries={availableRegistries}
          checkingSourceAdmission={checkingSourceAdmission}
          deployImage={deployImage}
          deployLocalImages={deployLocalImages}
          deployMode={deployMode}
          deployName={deployName}
          deployNodeId={deployNodeId}
          deployRegistryId={deployRegistryId}
          deployRestart={deployRestart}
          deployRuntimeProfile={deployRuntimeProfile}
          drainSeconds={drainSeconds}
          healthPath={healthPath}
          imageOptions={imageOptions}
          nodeOptions={nodeOptions}
          registryOptions={registryOptions}
          routeContainerPort={routeContainerPort}
          routeHostPort={routeHostPort}
          secureRuntimeAvailable={secureRuntimeAvailable}
          secureRuntimeCanBeConfigured={secureRuntimeCanBeConfigured}
          sourceAdmission={sourceAdmission}
          sourceAutoBuild={sourceAutoBuild}
          sourceAutoDeploy={sourceAutoDeploy}
          sourceBranch={sourceBranch}
          sourceConnectorId={sourceConnectorId}
          sourceConnectorOptions={sourceConnectorOptions}
          sourceContextPath={sourceContextPath}
          sourceDockerfilePath={sourceDockerfilePath}
          sourceMode={sourceMode}
          sourceProjectId={sourceProjectId}
          sourceRepositories={sourceRepositories}
          sourceRepositoryOptions={sourceRepositoryOptions}
          onDeployImageChange={setDeployImage}
          onDeployModeChange={setDeployMode}
          onDeployNameChange={setDeployName}
          onDeployNodeIdChange={(value) => {
            setDeployNodeId(value);
            setDeployImage("");
            setDeployRegistryId("");
            setDeployRuntimeProfile("default");
          }}
          onDeployRegistryIdChange={setDeployRegistryId}
          onDeployRestartChange={setDeployRestart}
          onDeployRuntimeProfileChange={setDeployRuntimeProfile}
          onDrainSecondsChange={setDrainSeconds}
          onHealthPathChange={setHealthPath}
          onRouteContainerPortChange={setRouteContainerPort}
          onRouteHostPortChange={setRouteHostPort}
          onSecureRuntimeSetupOpen={() => setSecureRuntimeSetupOpen(true)}
          onSourceAutoBuildChange={setSourceAutoBuild}
          onSourceAutoDeployChange={setSourceAutoDeploy}
          onSourceBranchChange={setSourceBranch}
          onSourceConnectorIdChange={(value) => {
            setSourceConnectorId(value);
            setSourceProjectId("");
          }}
          onSourceContextPathChange={setSourceContextPath}
          onSourceDockerfilePathChange={setSourceDockerfilePath}
          onSourceModeChange={setSourceMode}
          onSourceProjectIdChange={setSourceProjectId}
        />

        <DialogFooter>
          <Button variant="outline" onClick={closeDeploy}>
            Cancel
          </Button>
          <Button
            onClick={handleDeploy}
            disabled={
              deploying ||
              !deployNodeId ||
              (sourceMode === "repository" &&
                (checkingSourceAdmission || sourceAdmission?.ready !== true)) ||
              (sourceMode === "image"
                ? !deployImage.trim()
                : !sourceConnectorId ||
                  !sourceProjectId ||
                  !sourceBranch.trim() ||
                  !sourceDockerfilePath.trim() ||
                  !sourceContextPath.trim() ||
                  !deployName.trim()) ||
              (deployMode === "deployment" &&
                (!deployName.trim() || !Number(routeHostPort) || !Number(routeContainerPort)))
            }
          >
            {deploying
              ? sourceMode === "repository"
                ? "Creating…"
                : "Deploying..."
              : sourceMode === "repository"
                ? "Create and build"
                : "Deploy"}
          </Button>
        </DialogFooter>
      </DialogContent>
      <SecureRuntimeSetupDialog
        open={secureRuntimeSetupOpen}
        onOpenChange={setSecureRuntimeSetupOpen}
        onOpenNodeSettings={() => {
          const nodeSlug = selectedDeployNode?.slug;
          if (!nodeSlug) return;
          closeDeploy();
          navigate(nodeRoute(nodeSlug, "details"));
        }}
      />
    </Dialog>
  );
}
