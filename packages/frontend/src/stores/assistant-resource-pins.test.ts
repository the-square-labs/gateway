import { applyAssistantResourcePinAction } from "@/stores/assistant-resource-pins";
import { usePinnedContainersStore } from "@/stores/pinned-containers";
import { usePinnedNodesStore } from "@/stores/pinned-nodes";

describe("Assistant resource pin actions", () => {
  beforeEach(() => {
    usePinnedNodesStore.setState({ dashboardNodeIds: [], sidebarNodeIds: [] });
    usePinnedContainersStore.setState({
      dashboardContainerIds: [],
      sidebarContainerIds: [],
      containerMeta: {},
    });
  });

  it("sets Dashboard and Sidebar placements independently", () => {
    expect(
      applyAssistantResourcePinAction({
        clientAction: {
          type: "set_resource_pin",
          resourceType: "node",
          resourceId: "node-1",
          target: "dashboard",
          pinned: true,
        },
      })
    ).toBe(true);
    expect(usePinnedNodesStore.getState()).toMatchObject({
      dashboardNodeIds: ["node-1"],
      sidebarNodeIds: [],
    });
  });

  it("requires Docker metadata before pinning a Docker resource", () => {
    expect(
      applyAssistantResourcePinAction({
        clientAction: {
          type: "set_resource_pin",
          resourceType: "docker_container",
          resourceId: "container-1",
          target: "dashboard",
          pinned: true,
        },
      })
    ).toBe(false);
    expect(usePinnedContainersStore.getState().dashboardContainerIds).toEqual([]);
  });
});
