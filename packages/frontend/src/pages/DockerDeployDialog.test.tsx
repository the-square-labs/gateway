import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router-dom";
import { vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { useLicensePaywallStore } from "@/stores/license-paywall";
import { useUIBootstrapStore } from "@/stores/ui-bootstrap";
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
    vi.spyOn(api, "listGitLabConnectors").mockResolvedValue([]);
    vi.spyOn(api, "listGitConnectors").mockResolvedValue([]);
    vi.spyOn(api, "getDockerBuildAdmission").mockResolvedValue({
      ready: true,
      code: null,
      message: null,
    });
    useAuthStore.setState({
      user: { id: "user-1", scopes: ["docker:containers:create"] } as never,
      isAuthenticated: true,
      isLoading: false,
    });
    useDockerStore.setState({ dockerNodes: [] });
    useUIBootstrapStore.setState({
      snapshot: {
        license: {
          plan: "enterprise",
          entitlements: { features: ["secure-runtime", "blue-green"] },
        },
      } as never,
    });
    useLicensePaywallStore.setState({ request: null });
  });

  it("hides the GPU section until a node is selected", () => {
    renderWithRouter(<DockerDeployDialog open onOpenChange={vi.fn()} dockerNodes={[baseNode]} />);

    expect(screen.queryByText("GPU")).not.toBeInTheDocument();
    expect(screen.queryByText("Select a node to see its GPUs.")).not.toBeInTheDocument();
  });

  it("keeps entered values mounted until the close animation finishes", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    renderWithRouter(
      <DockerDeployDialog
        open
        onOpenChange={onOpenChange}
        nodeId={baseNode.id}
        dockerNodes={[baseNode]}
      />
    );

    const imageInput = screen.getByPlaceholderText("Select or enter an image");
    await user.type(imageInput, "nginx:alpine");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(imageInput).toHaveValue("nginx:alpine");
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

    const runtimeSelect = screen.getByRole("combobox", { name: "Runtime" });
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

  it("intercepts unavailable runtime and blue-green choices with the shared paywall", async () => {
    const secureNode = {
      ...baseNode,
      capabilities: { dockerRuntimeStatus: { state: "healthy" } },
    } satisfies Node;
    useUIBootstrapStore.setState({
      snapshot: {
        license: { plan: "community", entitlements: { features: [] } },
      } as never,
    });

    renderWithRouter(
      <DockerDeployDialog
        open
        onOpenChange={vi.fn()}
        nodeId={secureNode.id}
        dockerNodes={[secureNode]}
      />
    );

    const runtimeSelect = screen.getByRole("combobox", { name: "Runtime" });
    fireEvent.keyDown(runtimeSelect, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: /Secure/ }));
    expect(useLicensePaywallStore.getState().request).toMatchObject({
      capability: "Secure Runtime",
      requiredPlan: "business",
    });

    useLicensePaywallStore.setState({ request: null });
    const resourceTypeSelect = screen.getByRole("combobox", { name: "Resource type" });
    fireEvent.keyDown(resourceTypeSelect, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: /Blue\/green/ }));
    expect(useLicensePaywallStore.getState().request).toMatchObject({
      capability: "Blue/green deployments",
      requiredPlan: "personal",
    });
  });

  it("opens node setup before enforcing the plan when Secure Runtime is installable", async () => {
    const user = userEvent.setup();
    const installableNode = {
      ...baseNode,
      capabilities: {
        dockerRuntimeStatus: {
          state: "installable",
          remoteInstallable: true,
          checkedAt: new Date().toISOString(),
        },
      },
    } satisfies Node;
    useUIBootstrapStore.setState({
      snapshot: {
        license: { plan: "community", entitlements: { features: [] } },
      } as never,
    });

    renderWithRouter(
      <DockerDeployDialog
        open
        onOpenChange={vi.fn()}
        nodeId={installableNode.id}
        dockerNodes={[installableNode]}
      />,
      {
        extraRoutes: (
          <Route path="/nodes/:slug/details" element={<div>Node settings destination</div>} />
        ),
      }
    );

    const runtimeSelect = screen.getByRole("combobox", { name: "Runtime" });
    fireEvent.keyDown(runtimeSelect, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: /Secure/ }));

    expect(await screen.findByText("Secure Runtime setup required")).toBeInTheDocument();
    expect(useLicensePaywallStore.getState().request).toBeNull();

    await user.click(screen.getByRole("button", { name: "Open node settings" }));
    expect(await screen.findByText("Node settings destination")).toBeInTheDocument();
  });

  it("allows repository configuration and enforces Business only on Create and build", async () => {
    const user = userEvent.setup();
    useUIBootstrapStore.setState({
      snapshot: {
        license: { plan: "community", entitlements: { features: [] } },
      } as never,
    });
    vi.mocked(api.listGitConnectors).mockImplementation(async (provider) =>
      provider === "github"
        ? ([
            {
              id: "github-1",
              provider: "github",
              name: "GitHub production",
              baseUrl: "https://github.com",
              enabled: true,
            },
          ] as never)
        : []
    );
    vi.spyOn(api, "listDockerBuildRepositories").mockResolvedValue([
      {
        connectorId: "github-1",
        connectorName: "GitHub production",
        projectId: "repo-1",
        provider: "github",
        remoteId: "repo-1",
        fullPath: "acme/api",
        name: "api",
        webUrl: "https://github.com/acme/api",
        defaultBranch: "main",
        archived: false,
      },
    ]);
    const create = vi.spyOn(api, "createDockerSourceResource");

    renderWithRouter(
      <DockerDeployDialog
        open
        onOpenChange={vi.fn()}
        nodeId={baseNode.id}
        dockerNodes={[baseNode]}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Repository" }));
    await user.click(await screen.findByPlaceholderText("Select Git integration"));
    await user.click(await screen.findByRole("button", { name: "GitHub production" }));
    await user.click(await screen.findByPlaceholderText("Select allowlisted repository"));
    await user.click(await screen.findByRole("button", { name: "acme/api" }));
    await user.type(screen.getAllByPlaceholderText("my-container").at(-1)!, "payments-api");
    await user.click(screen.getByRole("button", { name: "Create and build" }));

    expect(useLicensePaywallStore.getState().request).toMatchObject({
      capability: "Git push-to-deploy",
      requiredPlan: "business",
    });
    expect(create).not.toHaveBeenCalled();
  });
});
