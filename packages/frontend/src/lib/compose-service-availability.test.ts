import { describe, expect, it } from "vitest";
import type { DockerAvailabilityPolicy, DockerComposeProject } from "@/types";
import { composeServiceRows, projectComposeServicePolicy } from "./compose-service-availability";

const policy = {
  resourceKind: "compose",
  mode: "replicated",
  shouldRun: true,
  desiredReplicaCount: 2,
  placements: ["a", "b"].map((id) => ({
    id,
    nodeId: `node-${id}`,
    serving: true,
    actualState: "serving",
    applicationHealth: "healthy",
    runtimeIdentity: {
      containers: [
        { serviceName: "web", containerId: `web-${id}`, containerName: `stack-web-${id}` },
        { serviceName: "worker", containerId: `worker-${id}` },
      ],
    },
  })),
} as unknown as DockerAvailabilityPolicy;
const project = {
  services: [],
  activeRevision: { normalizedModel: { services: { web: { image: "nginx:alpine" } } } },
} as unknown as DockerComposeProject;

describe("logical Compose service projection", () => {
  it("groups both replicas while retaining each runtime's own node and ID", () => {
    const projected = projectComposeServicePolicy(policy, "web", "nginx:alpine")!;
    expect(projected.sourceImageReference).toBe("nginx:alpine");
    expect(projected.desiredReplicaCount).toBe(2);
    expect(projected.placements.map((p) => [p.nodeId, p.runtimeIdentity.containerId])).toEqual([
      ["node-a", "web-a"],
      ["node-b", "web-b"],
    ]);
    expect(policy.placements[0].runtimeIdentity.containerId).toBeUndefined();
  });
  it("does not pretend a missing service has a serving container", () => {
    expect(
      projectComposeServicePolicy(policy, "missing")!.placements.every((p) => !p.serving)
    ).toBe(true);
  });
  it("keeps services visible across stop/start even when the source-node service list is empty", () => {
    const running = composeServiceRows(project, policy);
    expect(running).toEqual([
      {
        name: "web",
        image: "nginx:alpine",
        state: "running",
        health: "healthy",
        containerIds: ["web-a", "web-b"],
      },
    ]);
    const stopped = composeServiceRows(project, { ...policy, shouldRun: false });
    expect(stopped[0]).toMatchObject({
      name: "web",
      state: "stopped",
      containerIds: ["web-a", "web-b"],
    });
    expect(composeServiceRows(project, policy)).toEqual(running);
  });
});
