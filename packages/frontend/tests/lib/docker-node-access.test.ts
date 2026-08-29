import { describe, expect, it } from "vitest";

describe("docker node access helpers", () => {
  it("loads server-provided node context for resource-scoped Docker access", async () => {
    const { loadVisibleDockerNodes } = await import("../../src/lib/docker-node-access");
    const { api } = await import("@/services/api");
    const originalListNodes = api.listNodes;
    api.listNodes = async () =>
      ({
        data: [
          {
            id: "node-a",
            slug: "node-a",
            type: "docker",
            hostname: "node-a",
            displayName: "Node A",
            appearanceColor: null,
            status: "online",
            serviceCreationLocked: false,
            daemonVersion: null,
            osInfo: null,
            configVersionHash: null,
            capabilities: {},
            lastSeenAt: null,
            metadata: {},
            isConnected: true,
            createdAt: "",
            updatedAt: "",
          },
        ],
      }) as never;

    try {
      const nodes = await loadVisibleDockerNodes(
        ["docker:containers:view:node-a"],
        ["docker:containers:view"],
        false
      );

      expect(nodes.map((node) => node.slug)).toEqual(["node-a"]);
    } finally {
      api.listNodes = originalListNodes;
    }
  });

  it("loads node list for broad Docker view grants even without node details", async () => {
    const { loadVisibleDockerNodes } = await import("../../src/lib/docker-node-access");
    const { api } = await import("@/services/api");
    const originalListNodes = api.listNodes;
    api.listNodes = async () =>
      ({
        data: [
          {
            id: "node-a",
            slug: "node-a",
            type: "docker",
            hostname: "node-a",
            displayName: "Node A",
            appearanceColor: null,
            status: "online",
            serviceCreationLocked: false,
            daemonVersion: null,
            osInfo: null,
            configVersionHash: null,
            capabilities: {},
            lastSeenAt: null,
            metadata: {},
            isConnected: true,
            createdAt: "",
            updatedAt: "",
          },
        ],
      }) as never;

    try {
      const nodes = await loadVisibleDockerNodes(
        ["docker:containers:view"],
        ["docker:containers:view"],
        false
      );

      expect(nodes.map((node) => node.id)).toEqual(["node-a"]);
    } finally {
      api.listNodes = originalListNodes;
    }
  });

  it("loads node list for broad Docker scopes that imply view", async () => {
    const { loadVisibleDockerNodes } = await import("../../src/lib/docker-node-access");
    const { api } = await import("@/services/api");
    const originalListNodes = api.listNodes;
    api.listNodes = async () =>
      ({
        data: [
          {
            id: "node-a",
            slug: "node-a",
            type: "docker",
            hostname: "node-a",
            displayName: "Node A",
            appearanceColor: null,
            status: "online",
            serviceCreationLocked: false,
            daemonVersion: null,
            osInfo: null,
            configVersionHash: null,
            capabilities: {},
            lastSeenAt: null,
            metadata: {},
            isConnected: true,
            createdAt: "",
            updatedAt: "",
          },
        ],
      }) as never;

    try {
      const nodes = await loadVisibleDockerNodes(
        ["docker:containers:manage"],
        ["docker:containers:view"],
        false
      );

      expect(nodes.map((node) => node.id)).toEqual(["node-a"]);
    } finally {
      api.listNodes = originalListNodes;
    }
  });

  it("filters mixed node visibility to the requested Docker scopes", async () => {
    const { loadVisibleDockerNodes } = await import("../../src/lib/docker-node-access");
    const { api } = await import("@/services/api");
    const originalListNodes = api.listNodes;
    const node = (id: string) => ({
      id,
      slug: id,
      type: "docker" as const,
      hostname: id,
      displayName: id,
      appearanceColor: null,
      status: "online" as const,
      serviceCreationLocked: false,
      daemonVersion: null,
      osInfo: null,
      configVersionHash: null,
      capabilities: {},
      lastSeenAt: null,
      metadata: {},
      isConnected: true,
      createdAt: "",
      updatedAt: "",
    });
    api.listNodes = async () => ({ data: [node("node-a"), node("node-b")] }) as never;

    try {
      const scopedNodeUser = await loadVisibleDockerNodes(
        ["nodes:details:node-a", "docker:containers:view:node-b"],
        ["docker:containers:view"],
        true
      );
      const broadNodeUser = await loadVisibleDockerNodes(
        ["nodes:details", "docker:containers:view:node-b"],
        ["docker:containers:view"],
        true
      );

      expect(scopedNodeUser.map((candidate) => candidate.id)).toEqual(["node-b"]);
      expect(broadNodeUser.map((candidate) => candidate.id)).toEqual(["node-b"]);
    } finally {
      api.listNodes = originalListNodes;
    }
  });
});
