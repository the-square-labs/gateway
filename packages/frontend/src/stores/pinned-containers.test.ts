import { dropPinnedBuilds, usePinnedContainersStore } from "@/stores/pinned-containers";

const META = {
  nodeId: "node-1",
  nodeSlug: "node-one",
  name: "api",
  kind: "container" as const,
};

describe("pinned container placement", () => {
  beforeEach(() => {
    usePinnedContainersStore.setState({
      dashboardContainerIds: ["container-1"],
      sidebarContainerIds: ["container-1"],
      containerMeta: { "container-1": META },
    });
  });

  it("keeps Dashboard metadata when removing only the Sidebar placement", () => {
    usePinnedContainersStore.getState().toggleSidebar("container-1");

    expect(usePinnedContainersStore.getState()).toMatchObject({
      dashboardContainerIds: ["container-1"],
      sidebarContainerIds: [],
      containerMeta: { "container-1": META },
    });
  });
});

describe("pinned builds from before v1", () => {
  it("are dropped from both placements with their metadata", () => {
    const migrated = dropPinnedBuilds({
      dashboardContainerIds: ["container-1", "build-1"],
      sidebarContainerIds: ["build-1"],
      containerMeta: {
        "container-1": META,
        "build-1": { ...META, name: "api · 1a2b3c4d", kind: "build" } as unknown as typeof META,
      },
    });
    expect(migrated).toEqual({
      dashboardContainerIds: ["container-1"],
      sidebarContainerIds: [],
      containerMeta: { "container-1": META },
    });
  });
});
