import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useDockerStore } from "./docker";

function dockerNode(id: string) {
  return {
    id,
    slug: id,
    type: "docker" as const,
    hostname: id,
    displayName: null,
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
  };
}

describe("docker store", () => {
  beforeEach(() => {
    useDockerStore.setState({
      containers: [],
      containersByScope: {},
      selectedNodeId: null,
      dockerNodes: [],
      dockerNodesLoaded: false,
      networks: [],
      filters: { search: "", status: "all" },
    });
  });

  it("filters Gateway-managed networks returned by snapshots", async () => {
    vi.spyOn(api, "listDockerNetworkSnapshots").mockResolvedValue([
      { id: "managed", name: "gateway-db-79c029a3cedc4af1", driver: "bridge" },
      { id: "application", name: "application", driver: "bridge" },
    ] as never);

    await useDockerStore.getState().fetchNetworks(null, "managed-network-filter-test");

    expect(useDockerStore.getState().networks.map((network) => network.name)).toEqual([
      "application",
    ]);
  });

  it("clears a selected Docker node when the visible node list no longer contains it", () => {
    useDockerStore.getState().setDockerNodes([dockerNode("node-a"), dockerNode("node-b")]);
    useDockerStore.getState().setSelectedNode("node-a");

    useDockerStore.getState().setDockerNodes([dockerNode("node-b")]);

    expect(useDockerStore.getState().selectedNodeId).toBeNull();
  });

  it("updates cached node-tagged Docker rows when node appearance changes", () => {
    useDockerStore.setState({
      dockerNodes: [dockerNode("node-a")],
      containers: [
        { id: "container-a", name: "app", image: "busybox", state: "running", _nodeId: "node-a" },
      ] as never,
      containersByScope: {
        node_a: [
          {
            id: "container-a",
            name: "app",
            image: "busybox",
            state: "running",
            _nodeId: "node-a",
          },
        ] as never,
      },
    });

    useDockerStore.getState().syncNodeAppearance({
      id: "node-a",
      slug: "node-a-renamed",
      hostname: "node-a",
      displayName: "Blue Node",
      appearanceColor: "blue",
    });

    expect(useDockerStore.getState().dockerNodes[0]).toMatchObject({
      slug: "node-a-renamed",
      displayName: "Blue Node",
      appearanceColor: "blue",
    });
    expect(useDockerStore.getState().containers[0]).toMatchObject({
      _nodeSlug: "node-a-renamed",
      _nodeName: "Blue Node",
      _nodeColor: "blue",
    });
    expect(useDockerStore.getState().containersByScope.node_a?.[0]).toMatchObject({
      _nodeSlug: "node-a-renamed",
      _nodeName: "Blue Node",
      _nodeColor: "blue",
    });

    useDockerStore.getState().syncNodeAppearance({ id: "node-a", slug: "node-a-final" });

    expect(useDockerStore.getState().containers[0]).toMatchObject({
      _nodeSlug: "node-a-final",
      _nodeName: "Blue Node",
      _nodeColor: "blue",
    });
  });

  it("uses one aggregate snapshot request and preserves unavailable rows", async () => {
    const snapshotRequest = vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([
      {
        id: "container-a",
        name: "app",
        image: "busybox",
        state: "running",
        status: "Up",
        created: 0,
        ports: [],
        nodeId: "offline-node",
        _nodeId: "offline-node",
        availability: "unavailable",
      },
    ]);
    const perNodeRequest = vi.spyOn(api, "listDockerContainers");

    await useDockerStore.getState().fetchContainers();

    expect(snapshotRequest).toHaveBeenCalledTimes(1);
    expect(snapshotRequest).toHaveBeenCalledWith({ nodeId: undefined, search: "" });
    expect(perNodeRequest).not.toHaveBeenCalled();
    expect(useDockerStore.getState().containers).toMatchObject([
      { id: "container-a", availability: "unavailable" },
    ]);
  });

  it("shares an in-flight container snapshot refresh for the same scope", async () => {
    let resolveRequest!: (items: never[]) => void;
    const snapshotRequest = vi
      .spyOn(api, "listDockerContainerSnapshots")
      .mockImplementation(() => new Promise((resolve) => (resolveRequest = resolve)));

    const first = useDockerStore.getState().fetchContainers(null, "");
    const second = useDockerStore.getState().fetchContainers(null, "");

    expect(snapshotRequest).toHaveBeenCalledTimes(1);
    resolveRequest([]);
    await Promise.all([first, second]);
  });

  it("shows a selected node immediately from the aggregate snapshot while refreshing", async () => {
    const aggregate = [
      {
        id: "container-a",
        name: "api",
        image: "busybox",
        state: "running",
        _nodeId: "node-a",
      },
      {
        id: "container-b",
        name: "worker",
        image: "busybox",
        state: "running",
        _nodeId: "node-b",
      },
    ] as never;
    useDockerStore.setState({
      containers: aggregate,
      containersByScope: { __global__: aggregate },
    });

    let resolveRequest!: (items: typeof aggregate) => void;
    vi.spyOn(api, "listDockerContainerSnapshots").mockImplementation(
      () => new Promise((resolve) => (resolveRequest = resolve as typeof resolveRequest))
    );

    useDockerStore.getState().setSelectedNode("node-a");
    const refresh = useDockerStore.getState().fetchContainers("node-a");

    expect(useDockerStore.getState().containers).toMatchObject([
      { id: "container-a", _nodeId: "node-a" },
    ]);
    expect(useDockerStore.getState().loading.containers).toBe(false);

    resolveRequest([
      {
        id: "container-a-fresh",
        name: "api",
        image: "busybox:latest",
        state: "running",
        _nodeId: "node-a",
      },
    ] as never);
    await refresh;

    expect(useDockerStore.getState().containers).toMatchObject([
      { id: "container-a-fresh", _nodeId: "node-a" },
    ]);
  });

  it("does not show rows from a different node when no aggregate snapshot exists", () => {
    useDockerStore.setState({
      selectedNodeId: "node-a",
      containers: [
        {
          id: "container-a",
          name: "api",
          image: "busybox",
          state: "running",
          _nodeId: "node-a",
        },
      ] as never,
      containersByScope: {},
    });

    useDockerStore.getState().setSelectedNode("node-b");

    expect(useDockerStore.getState().containers).toEqual([]);
  });

  it("sends refresh hints without a follow-up list request", async () => {
    const hint = vi.spyOn(api, "refreshDockerSnapshots").mockResolvedValue();
    const list = vi.spyOn(api, "listDockerVolumeSnapshots");

    await useDockerStore.getState().requestSnapshotRefresh("volumes", "node-a");

    expect(hint).toHaveBeenCalledWith({ resource: "volumes", nodeId: "node-a" });
    expect(list).not.toHaveBeenCalled();
  });
});
