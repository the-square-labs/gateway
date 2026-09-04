import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
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
