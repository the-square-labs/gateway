import { usePinnedNodesStore } from "@/stores/pinned-nodes";
import { exportScreen } from "../harness";
import { appsNode, edgeNode } from "../fixtures/nodes";

it("dashboard", async () => {
  await exportScreen({
    id: "dashboard",
    title: "Dashboard",
    group: "Screens",
    route: "/",
    // Pinned node cards sit in a four-column grid; the bars share the first column with a badge.
    healthBarsWidth: 180,
    before: () => {
      usePinnedNodesStore.setState({ dashboardNodeIds: [edgeNode.id, appsNode.id] });
    },
  });
});
