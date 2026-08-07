import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { makeUser } from "@/test/fixtures";
import { SettingsTab, WebhookSection } from "./SettingsTab";

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

vi.mock("@/lib/docker-runtime-capacity", () => ({
  loadDockerRuntimeCapacity: vi.fn().mockResolvedValue({
    maxCpuCount: null,
    maxMemoryBytes: null,
    maxSwapBytes: null,
  }),
  UNKNOWN_DOCKER_RUNTIME_CAPACITY: {
    maxCpuCount: null,
    maxMemoryBytes: null,
    maxSwapBytes: null,
  },
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
  PortMappingsSection: () => null,
}));

vi.mock("./VolumeMountsSection", () => ({
  VolumeMountsSection: () => null,
}));

vi.mock("./LabelsSection", () => ({
  LabelsSection: () => null,
}));

vi.mock("@/components/docker/DockerHealthCheckSection", () => ({
  DockerHealthCheckSection: () => null,
}));

describe("docker detail SettingsTab", () => {
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

    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("combobox"));
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
