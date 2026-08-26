import type { NavigateFunction } from "react-router-dom";
import { toast } from "sonner";
import { dockerContainerRoute, dockerDeploymentRoute } from "@/lib/resource-routes";
import { api } from "@/services/api";
import { useDockerStore } from "@/stores/docker";
import type { ContainerCreateConfig, DockerRuntimeProfile, Node } from "@/types";
import type { DockerDeployMode, DockerDeploySourceMode, DockerRestartPolicy } from "./types";

interface ExecuteDockerDeployOptions {
  availableNodes: Node[];
  closeDeploy: () => void;
  deployImage: string;
  deployLocalImages: string[];
  deployMode: DockerDeployMode;
  deployName: string;
  deployNodeId: string;
  deployRegistryId: string;
  deployRestart: DockerRestartPolicy;
  deployRuntimeProfile: DockerRuntimeProfile;
  drainSeconds: string;
  healthPath: string;
  navigate: NavigateFunction;
  onDeployed?: (containerId?: string) => void;
  routeContainerPort: string;
  routeHostPort: string;
  sourceAutoBuild: boolean;
  sourceAutoDeploy: boolean;
  sourceBranch: string;
  sourceConnectorId: string;
  sourceContextPath: string;
  sourceDockerfilePath: string;
  sourceMode: DockerDeploySourceMode;
  sourceProjectId: string;
}

function getNodeSlug(nodeId: string, availableNodes: Node[]) {
  return (
    useDockerStore.getState().dockerNodes.find((node) => node.id === nodeId)?.slug ||
    availableNodes.find((node) => node.id === nodeId)?.slug
  );
}

export async function executeDockerDeploy({
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
}: ExecuteDockerDeployOptions) {
  if (sourceMode === "repository") {
    const result = await api.createDockerSourceResource(deployNodeId, {
      source: {
        connectorId: sourceConnectorId,
        projectId: sourceProjectId,
        branch: sourceBranch.trim(),
        dockerfilePath: sourceDockerfilePath.trim(),
        contextPath: sourceContextPath.trim(),
        autoBuild: sourceAutoBuild,
        autoDeploy: sourceAutoDeploy,
        buildArgs: {},
        buildSecretNames: [],
        policy: {},
      },
      resource:
        deployMode === "deployment"
          ? {
              kind: "deployment",
              name: deployName.trim(),
              restartPolicy: deployRestart === "no" ? "unless-stopped" : deployRestart,
              runtimeProfile: deployRuntimeProfile,
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
            }
          : {
              kind: "container",
              name: deployName.trim(),
              restartPolicy: deployRestart,
              runtimeProfile: deployRuntimeProfile,
            },
    });
    toast.success("Resource created and build queued");
    closeDeploy();
    onDeployed?.(result.target.kind === "deployment" ? result.target.deploymentId : undefined);
    if (result.target.kind === "deployment") {
      const nodeSlug = getNodeSlug(deployNodeId, availableNodes);
      if (nodeSlug) navigate(dockerDeploymentRoute(nodeSlug, deployName.trim()));
    }
    return;
  }

  let imageRef = deployImage.trim();
  if (!deployLocalImages.includes(imageRef)) {
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
      runtimeProfile: deployRuntimeProfile,
    });
    toast.success("Deployment created");
    closeDeploy();
    onDeployed?.(deployment.id);
    const nodeSlug = getNodeSlug(deployNodeId, availableNodes);
    if (nodeSlug) navigate(dockerDeploymentRoute(nodeSlug, deployment.name));
    return;
  }

  const config: ContainerCreateConfig = {
    image: imageRef,
    registryId: deployRegistryId || undefined,
    restartPolicy: deployRestart,
    runtimeProfile: deployRuntimeProfile,
  };
  if (deployName.trim()) config.name = deployName.trim();
  const result = await api.createContainer(deployNodeId, config);
  toast.success("Container deployed");
  closeDeploy();
  const newId = (result as any)?.id ?? (result as any)?.Id;
  onDeployed?.(newId);
  if (!newId) return;

  const inspect = await api.inspectContainer(deployNodeId, newId).catch(() => null);
  const canonicalName = String(
    (inspect as any)?.Name ??
      (inspect as any)?.name ??
      (result as any)?.Name ??
      (result as any)?.name ??
      ""
  ).replace(/^\/+/, "");
  const nodeSlug = getNodeSlug(deployNodeId, availableNodes);
  if (canonicalName && nodeSlug) navigate(dockerContainerRoute(nodeSlug, canonicalName));
}
