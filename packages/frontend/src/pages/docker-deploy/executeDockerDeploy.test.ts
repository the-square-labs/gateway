import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { deployCredentialRegistryId, executeDockerDeploy } from "./executeDockerDeploy";

describe("deployCredentialRegistryId", () => {
  it("omits the synthetic internal registry id from Docker API payloads", () => {
    expect(deployCredentialRegistryId("gateway-internal-registry")).toBeUndefined();
  });

  it("keeps persisted credential registry ids", () => {
    expect(deployCredentialRegistryId(" 78ad633c-bd67-4276-bcd4-16829a7d121c ")).toBe(
      "78ad633c-bd67-4276-bcd4-16829a7d121c"
    );
  });
});

describe("persisted Git resources", () => {
  it.each([
    "container",
    "deployment",
  ] as const)("opens %s Source even when the initial build cannot queue", async (kind) => {
    const create = vi.spyOn(api, "createDockerSourceResource").mockResolvedValue({
      target:
        kind === "container"
          ? { kind, nodeId: "node", containerName: "app" }
          : { kind, deploymentId: "deployment" },
      source: {} as never,
      build: null,
      initialBuildError: { code: "BUILD_CAPACITY_UNAVAILABLE", message: "No worker available" },
    });
    vi.spyOn(toast, "success").mockImplementation(() => 1);
    const warning = vi.spyOn(toast, "warning").mockImplementation(() => 1);
    const navigate = vi.fn();
    const closeDeploy = vi.fn();
    await executeDockerDeploy({
      availableNodes: [{ id: "node", slug: "docker-node" }] as never,
      deployNodeId: "node",
      deployName: "app",
      deployMode: kind,
      sourceMode: "repository",
      deployRegistryId: "",
      sourceBranch: "main",
      sourceContextPath: ".",
      sourceDockerfilePath: "Dockerfile",
      sourceConnectorId: "git",
      sourceProjectId: "repo",
      deployRestart: "no",
      deployRuntimeProfile: "default",
      routeHostPort: "8080",
      routeContainerPort: "80",
      healthPath: "/",
      drainSeconds: "0",
      closeDeploy,
      navigate,
    } as never);
    expect(create).toHaveBeenCalledOnce();
    expect(closeDeploy).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledWith(
      `/docker/${kind === "container" ? "containers" : "deployments"}/docker-node/app/source`
    );
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Source settings"));
    vi.restoreAllMocks();
  });
});

function options(overrides: Partial<Parameters<typeof executeDockerDeploy>[0]> = {}) {
  return {
    availableNodes: [],
    closeDeploy: vi.fn(),
    deployImage: "nginx:alpine",
    deployLocalImages: [],
    deployMode: "container",
    deployName: "web",
    deployNodeId: "node-1",
    deployFolderId: "folder-1",
    deployRegistryId: "",
    deployRestart: "unless-stopped",
    deployRuntimeProfile: "default",
    drainSeconds: "30",
    healthPath: "/",
    navigate: vi.fn(),
    routeContainerPort: "80",
    routeHostPort: "8080",
    sourceAutoBuild: true,
    sourceAutoDeploy: true,
    sourceBranch: "",
    sourceConnectorId: "",
    sourceContextPath: ".",
    sourceDockerfilePath: "Dockerfile",
    sourceMode: "image",
    sourceProjectId: "",
    ...overrides,
  } as Parameters<typeof executeDockerDeploy>[0];
}

describe("executeDockerDeploy image pull", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(toast, "info").mockImplementation(() => 1);
    vi.spyOn(toast, "success").mockImplementation(() => 1);
    vi.spyOn(api, "pullImageSync").mockResolvedValue({ success: true, imageRef: "nginx:alpine" });
    vi.spyOn(api, "createContainer").mockResolvedValue({ id: "container-1" } as never);
    vi.spyOn(api, "inspectContainer").mockResolvedValue({ Name: "/web" } as never);
    vi.spyOn(api, "createDockerDeployment").mockResolvedValue({
      id: "deployment-1",
      name: "web",
    } as never);
  });

  it("pulls a missing image for the container destination, so a folder create grant authorizes it", async () => {
    await executeDockerDeploy(options());

    expect(api.pullImageSync).toHaveBeenCalledWith("node-1", "nginx:alpine", undefined, {
      folderId: "folder-1",
    });
    expect(api.createContainer).toHaveBeenCalledWith(
      "node-1",
      expect.objectContaining({ folderId: "folder-1", image: "nginx:alpine" })
    );
  });

  it("pulls for a deployment at the node root with the root destination", async () => {
    await executeDockerDeploy(options({ deployMode: "deployment", deployFolderId: null }));

    expect(api.pullImageSync).toHaveBeenCalledWith("node-1", "nginx:alpine", undefined, {
      folderId: null,
    });
    expect(api.createDockerDeployment).toHaveBeenCalledWith(
      "node-1",
      expect.objectContaining({ folderId: null, image: "nginx:alpine" })
    );
  });

  it("does not pull an image that is already on the node", async () => {
    await executeDockerDeploy(options({ deployLocalImages: ["nginx:alpine"] }));

    expect(api.pullImageSync).not.toHaveBeenCalled();
  });
});
