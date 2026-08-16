import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { makeUser } from "@/test/fixtures";
import { SettingsTab, WebhookSection } from "./SettingsTab";

const portMappingsSectionSpy = vi.hoisted(() => vi.fn());

vi.mock("@/components/common/ConfirmDialog", () => ({ confirm: vi.fn().mockResolvedValue(true) }));

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

vi.mock("./RuntimeSection", () => ({
  RuntimeSection: ({
    restartPolicy,
    setRestartPolicy,
    hasRuntimeChanges,
    liveLoading,
    onApply,
  }: {
    restartPolicy: string;
    setRestartPolicy: (value: string) => void;
    hasRuntimeChanges: boolean;
    liveLoading: boolean;
    onApply: () => void;
  }) => (
    <div>
      <div data-testid="restart-policy">{restartPolicy}</div>
      <button type="button" onClick={() => setRestartPolicy("always")}>
        Change runtime
      </button>
      <button type="button" disabled={!hasRuntimeChanges || liveLoading} onClick={onApply}>
        Apply runtime
      </button>
    </div>
  ),
}));

vi.mock("./PortMappingsSection", () => ({
  PortMappingsSection: (props: unknown) => {
    portMappingsSectionSpy(props);
    return null;
  },
}));

vi.mock("./VolumeMountsSection", () => ({
  VolumeMountsSection: () => null,
}));

vi.mock("./LabelsSection", () => ({
  LabelsSection: ({ labels }: { labels: Array<{ key: string }> }) => (
    <div data-testid="labels-section">
      {labels.map((label) => (
        <span key={label.key}>{label.key}</span>
      ))}
    </div>
  ),
}));

vi.mock("@/components/docker/DockerHealthCheckSection", () => ({
  DockerHealthCheckSection: () => null,
}));

describe("docker detail SettingsTab", () => {
  beforeEach(() => {
    portMappingsSectionSpy.mockClear();
    vi.spyOn(api, "getNode").mockResolvedValue({
      id: "node-1",
      liveHealthReport: { gpuDevices: [] },
      lastHealthReport: null,
    } as never);
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 0,
    });
    vi.spyOn(api, "listDockerGpuUsage").mockResolvedValue([]);
    vi.spyOn(api, "getContainerWebhook").mockResolvedValue(null);
    vi.spyOn(api, "getContainerImageCleanup").mockResolvedValue({
      id: null,
      targetType: "container",
      nodeId: "node-1",
      containerName: "app",
      deploymentId: null,
      enabled: false,
      retentionCount: 2,
      createdAt: null,
      updatedAt: null,
    });
  });

  it("loads publish addresses through Docker-scoped node discovery when node details are forbidden", async () => {
    vi.mocked(api.getNode).mockRejectedValue(new Error("Forbidden"));
    vi.mocked(api.listNodes).mockResolvedValueOnce({
      data: [
        {
          id: "node-1",
          capabilities: { dockerPortBindIpV1: true },
          lastHealthReport: {
            networkInterfaces: [{ name: "eth0", ipAddresses: ["192.168.1.20"] }],
          },
        } as never,
      ],
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });
    useAuthStore.setState({
      user: makeUser({ scopes: ["docker:containers:edit"] }),
      isAuthenticated: true,
      isLoading: false,
    });

    render(
      <SettingsTab
        nodeId="node-1"
        containerId="container-1"
        data={{
          Id: "container-1",
          Name: "/app",
          State: { Status: "exited", Running: false },
          Config: { Image: "nginx:latest", Entrypoint: [], Cmd: [] },
          HostConfig: { PortBindings: {} },
          Mounts: [],
        }}
      />
    );

    const executionPanel = screen.getByRole("heading", { name: "Execution" }).closest(".border");
    expect(executionPanel?.parentElement).toHaveClass("min-[1044px]:grid-cols-2");

    await waitFor(() => {
      expect(portMappingsSectionSpy).toHaveBeenLastCalledWith(
        expect.objectContaining({
          bindAddressOptions: [
            { value: "0.0.0.0", label: "All interfaces (0.0.0.0)" },
            { value: "127.0.0.1", label: "Loopback (127.0.0.1)" },
            { value: "192.168.1.20", label: "eth0 (192.168.1.20)" },
          ],
        })
      );
    });
  });

  it("clears the local mutation lock through refresh callbacks when saving runtime settings for a stopped container", async () => {
    vi.spyOn(api, "liveUpdateContainer").mockResolvedValue({});
    const invalidate = vi.fn().mockResolvedValue(undefined);
    useDockerStore.setState({ invalidate });
    useAuthStore.setState({
      user: makeUser({ scopes: ["docker:containers:edit"] }),
      isAuthenticated: true,
      isLoading: false,
    });

    const onMutationStart = vi.fn();
    const onMutationEnd = vi.fn();
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const onRecreating = vi.fn().mockResolvedValue(undefined);

    render(
      <SettingsTab
        nodeId="node-1"
        containerId="container-1"
        data={{
          Id: "container-1",
          Name: "/app",
          State: { Status: "exited", Running: false },
          Config: { Image: "registry.example.com/team/app:latest", Entrypoint: [], Cmd: [] },
          HostConfig: {
            RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
            Memory: 0,
            MemorySwap: 0,
            NanoCPUs: 0,
            CpuShares: 0,
            PidsLimit: 0,
            PortBindings: {},
          },
          Mounts: [],
        }}
        onMutationStart={onMutationStart}
        onMutationEnd={onMutationEnd}
        onRefresh={onRefresh}
        onRecreating={onRecreating}
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Change runtime" }));
    fireEvent.click(screen.getByRole("button", { name: "Apply runtime" }));

    await waitFor(() => {
      expect(api.liveUpdateContainer).toHaveBeenCalledWith("node-1", "container-1", {
        restartPolicy: "always",
      });
    });
    expect(onMutationStart).toHaveBeenCalledWith("updating");
    expect(onRefresh).toHaveBeenCalled();
    expect(onMutationEnd).toHaveBeenCalled();
    expect(onRecreating).not.toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith("containers", "tasks");
  });

  it("loads container webhook and image cleanup settings", async () => {
    vi.spyOn(api, "getContainerWebhook").mockResolvedValue({
      id: "webhook-1",
      nodeId: "node-1",
      containerName: "app",
      token: "token-1",
      enabled: true,
      createdAt: "2026-06-21T00:00:00.000Z",
      updatedAt: "2026-06-21T00:00:00.000Z",
    });
    vi.spyOn(api, "getContainerImageCleanup").mockResolvedValue({
      id: "cleanup-1",
      targetType: "container",
      nodeId: "node-1",
      containerName: "app",
      deploymentId: null,
      enabled: true,
      retentionCount: 3,
      createdAt: "2026-06-21T00:00:00.000Z",
      updatedAt: "2026-06-21T00:00:00.000Z",
    });

    render(<WebhookSection nodeId="node-1" containerName="app" />);

    expect(
      await screen.findByText(`${window.location.origin}/api/webhooks/docker/token-1`)
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue("3")).toBeInTheDocument();
  });

  it("keeps permitted webhook and cleanup panels stable while their settings load", () => {
    vi.spyOn(api, "getContainerWebhook").mockReturnValue(new Promise(() => {}));
    vi.spyOn(api, "getContainerImageCleanup").mockReturnValue(new Promise(() => {}));

    render(<WebhookSection nodeId="node-1" containerName="app" />);

    expect(screen.getByText("Webhook")).toBeInTheDocument();
    expect(screen.getByText("Image Cleanup")).toBeInTheDocument();
    expect(screen.getByLabelText("Loading webhook")).toBeInTheDocument();
  });

  it("does not expose daemon-owned GPU group provenance labels", () => {
    render(
      <SettingsTab
        nodeId="node-1"
        containerId="container-1"
        data={{
          Id: "container-1",
          Name: "/app",
          State: { Status: "exited", Running: false },
          Config: {
            Image: "registry.example.com/team/app:latest",
            Entrypoint: [],
            Cmd: [],
            Labels: {
              "example.com/visible": "yes",
              "wiolett.gateway.gpu.group-ids": "105",
              "wiolett.gateway.gpu.group-ids-version": "1",
            },
          },
          HostConfig: {
            RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
            Memory: 0,
            MemorySwap: 0,
            NanoCPUs: 0,
            CpuShares: 0,
            PidsLimit: 0,
            PortBindings: {},
          },
          Mounts: [],
        }}
      />
    );

    const labels = screen.getByTestId("labels-section");
    expect(within(labels).getByText("example.com/visible")).toBeInTheDocument();
    expect(within(labels).queryByText("wiolett.gateway.gpu.group-ids")).not.toBeInTheDocument();
    expect(
      within(labels).queryByText("wiolett.gateway.gpu.group-ids-version")
    ).not.toBeInTheDocument();
  });

  it("renders attached Docker networks in settings", async () => {
    vi.spyOn(api, "listDockerNetworks").mockResolvedValue([
      {
        id: "network-2",
        name: "other-net",
        driver: "bridge",
        scope: "local",
        ipam: {},
        containers: {},
      },
    ]);
    useAuthStore.setState({
      user: makeUser({
        scopes: ["docker:containers:edit", "docker:networks:view", "docker:networks:edit"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });

    render(
      <SettingsTab
        nodeId="node-1"
        containerId="container-1"
        data={{
          Id: "container-1",
          Name: "/app",
          State: { Status: "running", Running: true },
          Config: { Image: "registry.example.com/team/app:latest", Entrypoint: [], Cmd: [] },
          HostConfig: {
            RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
            Memory: 0,
            MemorySwap: 0,
            NanoCPUs: 0,
            CpuShares: 0,
            PidsLimit: 0,
            PortBindings: {},
          },
          NetworkSettings: {
            Networks: {
              "app-net": {
                NetworkID: "network-1",
                IPAddress: "172.20.0.5",
                Gateway: "172.20.0.1",
                Aliases: ["app", "backend"],
              },
            },
          },
          Mounts: [],
        }}
      />
    );

    expect(await screen.findByText("app-net")).toBeInTheDocument();
    expect(screen.getByText("172.20.0.5")).toBeInTheDocument();
    expect(screen.getByText("app, backend")).toBeInTheDocument();
    expect(api.listDockerNetworks).toHaveBeenCalledWith("node-1");
  });

  it("adds a shared physical GPU through the standard table and dialog", async () => {
    vi.mocked(api.listDockerGpuUsage).mockResolvedValue([
      {
        deviceId: "nvidia:gpu-1",
        containerCount: 1,
        containers: [{ name: "gateway-gpu-ui-e2e" }],
      },
    ]);
    vi.mocked(api.getNode).mockResolvedValue({
      id: "node-1",
      liveHealthReport: {
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
      },
      lastHealthReport: null,
    } as never);
    useAuthStore.setState({
      user: makeUser({ scopes: ["docker:containers:edit"] }),
      isAuthenticated: true,
      isLoading: false,
    });

    render(
      <SettingsTab
        nodeId="node-1"
        containerId="container-1"
        data={{
          Id: "container-1",
          Name: "/app",
          State: { Status: "running", Running: true },
          Config: { Image: "registry.example.com/team/app:latest", Entrypoint: [], Cmd: [] },
          HostConfig: {
            RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
            Memory: 0,
            MemorySwap: 0,
            NanoCPUs: 0,
            CpuShares: 0,
            PidsLimit: 0,
            PortBindings: {},
          },
          Mounts: [],
        }}
      />
    );

    expect(screen.getByRole("heading", { name: "GPU" })).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    expect(screen.getByRole("dialog", { name: "Add GPU" })).toBeInTheDocument();
    expect(
      screen.getByText(/Physical GPUs are shared with other containers on this node/i)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("combobox", { name: "GPU" }));
    fireEvent.click(await screen.findByRole("option", { name: /NVIDIA · RTX 3050/i }));
    fireEvent.click(screen.getByRole("button", { name: "Add GPU" }));

    expect(await screen.findByText("NVIDIA · RTX 3050")).toBeInTheDocument();
    expect(screen.getByText("VRAM", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Containers", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("1 container")).toBeInTheDocument();
    expect(screen.queryByText("gateway-gpu-ui-e2e")).not.toBeInTheDocument();
    expect(screen.getByText("nvidia:gpu-1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Remove NVIDIA · RTX 3050/i })).toHaveClass(
      "h-9",
      "w-9",
      "rounded-none",
      "border-l"
    );
    expect(screen.getAllByText("Requires container recreation")).toHaveLength(2);
  });

  it("keeps an explicit GPU removal through transient container snapshots", async () => {
    vi.spyOn(api, "recreateWithConfig").mockResolvedValue({});
    vi.mocked(api.getNode).mockResolvedValue({
      id: "node-1",
      liveHealthReport: {
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
      },
      lastHealthReport: null,
    } as never);
    useAuthStore.setState({
      user: makeUser({ scopes: ["docker:containers:edit"] }),
      isAuthenticated: true,
      isLoading: false,
    });

    const data = {
      Id: "container-1",
      Name: "/app",
      State: { Status: "running", Running: true },
      Config: { Image: "registry.example.com/team/app:latest", Entrypoint: [], Cmd: [] },
      HostConfig: {
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        Memory: 0,
        MemorySwap: 0,
        NanoCPUs: 0,
        CpuShares: 0,
        PidsLimit: 0,
        PortBindings: {},
      },
      Mounts: [],
      gpuAttachment: { mode: "managed" as const, deviceIds: ["nvidia:gpu-1"] },
    };
    const { rerender } = render(
      <SettingsTab nodeId="node-1" containerId="container-1" data={data} />
    );

    fireEvent.click(await screen.findByRole("button", { name: /Remove NVIDIA · RTX 3050/i }));
    expect(screen.getByRole("button", { name: "Save & Recreate" })).toBeEnabled();

    rerender(
      <SettingsTab
        nodeId="node-1"
        containerId="container-1"
        data={{ ...data, gpuAttachment: { mode: "none", deviceIds: [] } }}
      />
    );
    rerender(<SettingsTab nodeId="node-1" containerId="container-1" data={data} />);

    const save = screen.getByRole("button", { name: "Save & Recreate" });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);

    await waitFor(() => {
      expect(api.recreateWithConfig).toHaveBeenCalledWith("node-1", "container-1", {
        gpu: { deviceIds: [] },
      });
    });
  });

  it("saves network-only changes without recreating the container", async () => {
    vi.spyOn(api, "listDockerNetworks").mockResolvedValue([
      {
        id: "network-1",
        name: "app-net",
        driver: "bridge",
        scope: "local",
        ipam: {},
        containers: {},
      },
      {
        id: "network-2",
        name: "other-net",
        driver: "bridge",
        scope: "local",
        ipam: {},
        containers: {},
      },
    ]);
    vi.spyOn(api, "connectContainerToNetwork").mockResolvedValue(undefined);
    vi.spyOn(api, "disconnectContainerFromNetwork").mockResolvedValue(undefined);
    vi.spyOn(api, "recreateWithConfig").mockResolvedValue({});
    const invalidate = vi.fn().mockResolvedValue(undefined);
    useDockerStore.setState({ invalidate });
    useAuthStore.setState({
      user: makeUser({
        scopes: ["docker:containers:edit", "docker:networks:view", "docker:networks:edit"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
    const onMutationStart = vi.fn();
    const onMutationEnd = vi.fn();
    const onRefresh = vi.fn().mockResolvedValue(undefined);

    render(
      <SettingsTab
        nodeId="node-1"
        containerId="container-1"
        data={{
          Id: "container-1",
          Name: "/app",
          State: { Status: "running", Running: true },
          Config: { Image: "registry.example.com/team/app:latest", Entrypoint: [], Cmd: [] },
          HostConfig: {
            RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
            Memory: 0,
            MemorySwap: 0,
            NanoCPUs: 0,
            CpuShares: 0,
            PidsLimit: 0,
            PortBindings: {},
          },
          NetworkSettings: {
            Networks: {
              "app-net": {
                NetworkID: "network-1",
                IPAddress: "172.20.0.5",
                Gateway: "172.20.0.1",
                Aliases: [],
              },
            },
          },
          Mounts: [],
        }}
        onMutationStart={onMutationStart}
        onMutationEnd={onMutationEnd}
        onRefresh={onRefresh}
      />
    );

    const networksPanel = screen.getByRole("heading", { name: "Networks" }).closest(".border");
    expect(networksPanel).not.toBeNull();
    const addNetwork = within(networksPanel as HTMLElement).getByRole("button", { name: "Add" });
    await waitFor(() => expect(addNetwork).toBeEnabled());
    fireEvent.click(addNetwork);
    fireEvent.click(within(networksPanel as HTMLElement).getByRole("combobox"));
    fireEvent.click(await screen.findByText("other-net"));

    const saveButton = screen.getByRole("button", { name: "Save" });
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(api.connectContainerToNetwork).toHaveBeenCalledWith(
        "node-1",
        "network-2",
        "container-1"
      );
    });
    expect(api.recreateWithConfig).not.toHaveBeenCalled();
    expect(onMutationStart).not.toHaveBeenCalled();
    expect(onMutationEnd).not.toHaveBeenCalled();
    expect(onRefresh).toHaveBeenCalled();
    expect(invalidate).toHaveBeenCalledWith("containers", "networks");
  });
});
