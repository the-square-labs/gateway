import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { loadVisibleDockerNodes } from "@/lib/docker-node-access";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { makeNode, makeUser } from "@/test/fixtures";
import { Docker } from "./Docker";

vi.mock("@/lib/docker-node-access", () => ({ loadVisibleDockerNodes: vi.fn() }));
function ListProbe({ tab }: { tab: string }) {
  const node = useDockerStore((s) => s.selectedNodeId);
  const location = useLocation();
  return (
    <div>
      {tab} list for {node ?? "all"}
      <output aria-label="List URL">
        {location.pathname}
        {location.search}
      </output>
    </div>
  );
}
vi.mock("./DockerContainers", () => ({ DockerContainers: () => <ListProbe tab="containers" /> }));
vi.mock("./DockerImages", () => ({ DockerImages: () => <ListProbe tab="images" /> }));
vi.mock("./DockerVolumes", () => ({ DockerVolumes: () => <ListProbe tab="volumes" /> }));
vi.mock("./DockerNetworks", () => ({ DockerNetworks: () => <ListProbe tab="networks" /> }));
vi.mock("./DockerComposeProjects", () => ({
  DockerComposeProjects: () => <ListProbe tab="compose" />,
}));
vi.mock("./DockerBuilds", () => ({ DockerBuilds: () => null }));
vi.mock("./DockerTasks", () => ({ DockerTasks: () => null }));
vi.mock("./docker/GwcaImportDialog", () => ({ GwcaImportDialog: () => null }));

const node = makeNode({ id: "node-1", type: "docker", status: "online", isConnected: true });
beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    user: makeUser({
      scopes: [
        "nodes:details",
        ...["containers", "images", "volumes", "networks", "compose"].map(
          (tab) => `docker:${tab}:view`
        ),
      ],
    }),
    isAuthenticated: true,
    isLoading: false,
  });
  useDockerStore.setState({
    selectedNodeId: "old-node",
    dockerNodes: [],
    dockerNodesLoaded: false,
    filters: { search: "old query", status: "exited" },
    fetchContainers: vi.fn().mockResolvedValue(undefined),
    fetchImages: vi.fn().mockResolvedValue(undefined),
    fetchVolumes: vi.fn().mockResolvedValue(undefined),
    fetchNetworks: vi.fn().mockResolvedValue(undefined),
    fetchComposeProjects: vi.fn().mockResolvedValue(undefined),
    fetchTasks: vi.fn().mockResolvedValue(undefined),
  });
  vi.mocked(loadVisibleDockerNodes).mockResolvedValue([node]);
});

it.each([
  "containers",
  "images",
  "volumes",
  "networks",
  "compose",
])("opens %s with the URL node selected before mounting the list", async (tab) => {
  let resolveNodes!: (nodes: (typeof node)[]) => void;
  vi.mocked(loadVisibleDockerNodes).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveNodes = resolve;
      })
  );
  render(
    <MemoryRouter initialEntries={[`/docker/${tab}?nodeId=node-1&filters=1`]}>
      <Routes>
        <Route path="/docker/:tab" element={<Docker />} />
      </Routes>
    </MemoryRouter>
  );
  expect(screen.queryByText(/list for/)).not.toBeInTheDocument();
  await act(async () => resolveNodes([node]));
  expect(await screen.findByText(`${tab} list for node-1`)).toBeInTheDocument();
  expect(useDockerStore.getState().filters).toEqual({ search: "", status: "all" });
  expect(screen.getByLabelText("List URL")).toHaveTextContent(`nodeId=node-1&filters=1`);
});

it("preserves the selected node and expanded-filter intent when switching tabs", async () => {
  render(
    <MemoryRouter initialEntries={["/docker/containers?nodeId=node-1&filters=1"]}>
      <Routes>
        <Route path="/docker/:tab" element={<Docker />} />
      </Routes>
    </MemoryRouter>
  );
  await screen.findByText("containers list for node-1");
  await userEvent.click(screen.getByRole("tab", { name: "Images" }));
  await screen.findByText("images list for node-1");
  expect(screen.getByLabelText("List URL")).toHaveTextContent(
    "/docker/images?nodeId=node-1&filters=1"
  );
});

it("never mounts an unscoped list for an unavailable deep-link node", async () => {
  render(
    <MemoryRouter initialEntries={["/docker/containers?nodeId=other-node&filters=1"]}>
      <Routes>
        <Route path="/docker/:tab" element={<Docker />} />
      </Routes>
    </MemoryRouter>
  );
  await screen.findByText(
    "The selected Docker node is unavailable or you do not have access to it."
  );
  expect(screen.queryByText(/list for/)).not.toBeInTheDocument();
  expect(useDockerStore.getState().fetchContainers).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole("button", { name: "View all nodes" }));
  await waitFor(() => expect(screen.getByText("containers list for all")).toBeInTheDocument());
});
