import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { renderWithRouter } from "@/test/render";
import type { Node } from "@/types";
import { DockerDeployDialog } from "./DockerDeployDialog";

const baseNode = {
  id: "node-1",
  slug: "docker-node",
  type: "docker",
  hostname: "docker.local",
  displayName: "Docker Node",
  appearanceColor: null,
  status: "online",
  serviceCreationLocked: false,
  daemonVersion: "1.0.0",
  osInfo: "linux",
  configVersionHash: null,
  capabilities: {},
  lastSeenAt: new Date().toISOString(),
  metadata: {},
  isConnected: true,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
} satisfies Node;

describe("DockerDeployDialog runtime section", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "listDockerImages").mockResolvedValue([]);
    useAuthStore.setState({
      user: { id: "user-1", scopes: ["docker:containers:create"] } as never,
      isAuthenticated: true,
      isLoading: false,
    });
    useDockerStore.setState({ dockerNodes: [] });
  });

  it("hides the GPU section until a node is selected", () => {
    renderWithRouter(<DockerDeployDialog open onOpenChange={vi.fn()} dockerNodes={[baseNode]} />);

    expect(screen.queryByText("GPU")).not.toBeInTheDocument();
    expect(screen.queryByText("Select a node to see its GPUs.")).not.toBeInTheDocument();
  });

  it("hides the GPU section when the selected node has no GPUs", async () => {
    renderWithRouter(
      <DockerDeployDialog
        open
        onOpenChange={vi.fn()}
        nodeId={baseNode.id}
        dockerNodes={[baseNode]}
      />
    );

    await waitFor(() => expect(api.listDockerImages).toHaveBeenCalledWith(baseNode.id));
    expect(screen.queryByText("GPU")).not.toBeInTheDocument();
    expect(
      screen.queryByText("No GPUs are currently reported by this node.")
    ).not.toBeInTheDocument();
  });

  it("keeps GPU configuration out of deploy and shows the runtime selector", async () => {
    const gpuNode = {
      ...baseNode,
      lastHealthReport: {
        gpuDevices: [
          {
            id: "nvidia:gpu-1",
            vendor: "nvidia",
            model: "RTX 3050",
            pciAddress: "0000:01:00.0",
            renderNode: "/dev/dri/renderD128",
            deviceIndex: 0,
            attachable: true,
            unavailableReason: "",
            partitioned: false,
            availableMetrics: ["utilization_percent"],
          },
        ],
      } as Node["lastHealthReport"],
    } satisfies Node;

    renderWithRouter(
      <DockerDeployDialog open onOpenChange={vi.fn()} nodeId={gpuNode.id} dockerNodes={[gpuNode]} />
    );

    expect(await screen.findByText("Runtime")).toBeInTheDocument();
    expect(screen.queryByText("GPU")).not.toBeInTheDocument();
    expect(screen.queryByText("NVIDIA · RTX 3050")).not.toBeInTheDocument();
  });

  it("submits the selected Secure runtime through the real container create path", async () => {
    const user = userEvent.setup();
    const secureNode = {
      ...baseNode,
      capabilities: { dockerRuntimeStatus: { state: "healthy" } },
    } satisfies Node;
    vi.spyOn(api, "pullImageSync").mockResolvedValue({ imageRef: "nginx:alpine" } as never);
    const createContainer = vi
      .spyOn(api, "createContainer")
      .mockResolvedValue({ id: "container-1" } as never);
    vi.spyOn(api, "inspectContainer").mockResolvedValue({ Name: "/secure-app" } as never);

    renderWithRouter(
      <DockerDeployDialog
        open
        onOpenChange={vi.fn()}
        nodeId={secureNode.id}
        dockerNodes={[secureNode]}
      />
    );

    const runtimeSelect = screen.getAllByRole("combobox")[1]!;
    fireEvent.keyDown(runtimeSelect, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: /Secure/ }));
    const imageInput = screen.getByPlaceholderText("Select or enter an image");
    await user.click(imageInput);
    await user.type(imageInput, "nginx:alpine");
    await user.click(screen.getByRole("button", { name: "Deploy" }));

    await waitFor(() =>
      expect(createContainer).toHaveBeenCalledWith("node-1", {
        image: "nginx:alpine",
        registryId: undefined,
        restartPolicy: "no",
        runtimeProfile: "secure",
      })
    );
  });
});
