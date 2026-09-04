import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Route } from "react-router-dom";
import { vi } from "vitest";
import { DockerDeploymentDetail } from "@/pages/DockerDeploymentDetail";
import { DeploymentSlots } from "@/pages/docker-deployment-detail/DeploymentPanels";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";
import type { DockerDeployment } from "@/types";

const realtimeHandlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());

vi.mock("@/components/ui/code-editor", () => ({
  CodeEditor: ({ value, height }: { value: string; height?: string }) => (
    <textarea aria-label="Configuration JSON" value={value} readOnly data-editor-height={height} />
  ),
}));

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (channel: string | null, handler: (payload: unknown) => void) => {
    if (channel) realtimeHandlers.set(channel, handler);
  },
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

vi.mock("./docker-detail/RuntimeSection", () => ({
  RuntimeSection: () => <div data-testid="runtime-section" />,
}));

vi.mock("./docker-detail/PortMappingsSection", () => ({
  PortMappingsSection: () => <div data-testid="port-mappings-section" />,
}));

vi.mock("./docker-detail/VolumeMountsSection", () => ({
  VolumeMountsSection: () => <div data-testid="volume-mounts-section" />,
}));

vi.mock("./docker-detail/LabelsSection", () => ({
  LabelsSection: () => <div data-testid="labels-section" />,
}));

vi.mock("@/components/docker/DockerHealthCheckSection", () => ({
  DockerHealthCheckSection: () => <div data-testid="health-check-section" />,
}));

vi.mock("@/components/docker/availability/AvailabilitySection", () => ({
  AvailabilitySection: () => <div>Availability controls</div>,
}));

vi.mock("./docker-detail/SettingsTab", async () => {
  const actual = await vi.importActual<typeof import("./docker-detail/SettingsTab")>(
    "./docker-detail/SettingsTab"
  );
  return {
    ...actual,
    WebhookSection: () => <div data-testid="webhook-section" />,
  };
});

function makeDeployment(overrides: Partial<DockerDeployment> = {}): DockerDeployment {
  const now = "2026-06-21T00:00:00.000Z";
  return {
    id: "deployment-1",
    nodeId: "node-1",
    name: "backend",
    desiredConfig: {
      image: "registry.example.com/team/backend:c4ce71c1",
      env: { NODE_ENV: "production" },
      restartPolicy: "unless-stopped",
      entrypoint: ["node"],
      command: ["server.js"],
      workingDir: "/app",
      user: "node",
      mounts: [{ name: "data", containerPath: "/data", readOnly: false }],
      labels: { service: "backend" },
      runtime: {},
    },
    activeSlot: "blue",
    status: "ready",
    routerName: "backend-router",
    routerImage: "traefik:v3",
    networkName: "deployment-backend",
    healthConfig: {
      path: "/health",
      statusMin: 200,
      statusMax: 399,
      timeoutSeconds: 5,
      intervalSeconds: 15,
      successThreshold: 1,
      startupGraceSeconds: 10,
      deployTimeoutSeconds: 120,
    },
    drainSeconds: 30,
    routes: [
      {
        id: "route-1",
        deploymentId: "deployment-1",
        hostPort: 8080,
        containerPort: 3000,
        isPrimary: true,
      },
    ],
    slots: [
      {
        id: "slot-blue",
        deploymentId: "deployment-1",
        slot: "blue",
        containerId: "container-blue",
        containerName: "backend-blue",
        image: "registry.example.com/team/backend:c4ce71c1",
        desiredConfig: null,
        status: "running",
        health: "healthy",
        drainingUntil: null,
        updatedAt: now,
      },
      {
        id: "slot-green",
        deploymentId: "deployment-1",
        slot: "green",
        containerId: "container-green",
        containerName: "backend-green",
        image: null,
        desiredConfig: null,
        status: "standby",
        health: "unknown",
        drainingUntil: null,
        updatedAt: now,
      },
    ],
    releases: [],
    webhook: null,
    healthCheck: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("DockerDeploymentDetail", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    realtimeHandlers.clear();
    vi.spyOn(api, "getNode").mockResolvedValue({
      id: "node-1",
      liveHealthReport: { gpuDevices: [] },
      lastHealthReport: null,
    } as never);
    vi.spyOn(api, "getDockerAvailability").mockResolvedValue(null);
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      limit: 100,
      offset: 0,
    } as never);
    useAuthStore.setState({
      user: makeUser({
        scopes: [
          "docker:containers:view",
          "docker:containers:edit",
          "docker:containers:manage",
          "docker:containers:mounts",
          "docker:containers:webhooks",
        ],
      }),
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it("opens configuration from the overflow menu and keeps tab icons only on source, builds, and slots", async () => {
    vi.spyOn(api, "getDockerDeployment").mockResolvedValue(makeDeployment());
    vi.spyOn(api, "inspectContainer").mockResolvedValue({
      State: { Status: "running", Running: true },
    } as never);
    renderWithRouter(<DockerDeploymentDetail />, {
      path: "/docker/deployments/:nodeId/:deploymentId/:tab",
      route: "/docker/deployments/node-1/deployment-1/overview",
    });
    await screen.findByRole("tab", { name: "Overview" });
    expect(screen.queryByRole("tab", { name: "Config" })).not.toBeInTheDocument();
    for (const tab of screen.getAllByRole("tab")) {
      const shouldHaveIcon = ["Source", "Builds", "Slots"].includes(tab.textContent!.trim());
      expect(Boolean(tab.querySelector("svg"))).toBe(shouldHaveIcon);
    }
    fireEvent.keyDown(screen.getByRole("button", { name: "Page actions" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "View config" }));
    expect(
      await screen.findByRole("dialog", { name: "Deployment configuration" })
    ).toBeInTheDocument();
    const editor = screen.getByRole("textbox", { name: "Configuration JSON" });
    expect(editor).toHaveAttribute("data-editor-height", "min(60dvh, 640px)");
    expect(JSON.parse((editor as HTMLTextAreaElement).value).desiredConfig.image).toBe(
      makeDeployment().desiredConfig.image
    );
  });

  it("preserves final row separators and overlaps the panel edge without a double border", async () => {
    vi.spyOn(api, "getDockerDeployment").mockResolvedValue(makeDeployment());
    vi.spyOn(api, "inspectContainer").mockResolvedValue({
      State: { Status: "running", Running: true },
    } as never);
    renderWithRouter(<DockerDeploymentDetail />, {
      path: "/docker/deployments/:nodeId/:deploymentId/:tab",
      route: "/docker/deployments/node-1/deployment-1/overview",
    });
    for (const name of ["General", "Active Slot", "Port Mappings", "Health Check"]) {
      const heading = await screen.findByRole("heading", { name });
      const panel = heading.closest(".overflow-hidden")!;
      expect(heading.tagName).toBe("H3");
      const rows = panel.lastElementChild!;
      expect(panel).toHaveClass("border", "border-border", "overflow-hidden");
      expect(rows).toHaveClass("divide-y", "divide-border");
      expect(rows).toHaveClass(
        "-mb-px",
        "[&>*:last-child]:border-b",
        "[&>*:last-child]:border-border"
      );
    }
  });

  it("opens legacy config links as the modal over Overview", async () => {
    vi.spyOn(api, "getDockerDeployment").mockResolvedValue(makeDeployment());
    vi.spyOn(api, "inspectContainer").mockResolvedValue({
      State: { Status: "running", Running: true },
    } as never);
    renderWithRouter(<DockerDeploymentDetail />, {
      path: "/docker/deployments/:nodeId/:deploymentId/:tab",
      route: "/docker/deployments/node-1/deployment-1/config",
    });
    expect(
      await screen.findByRole("dialog", { name: "Deployment configuration" })
    ).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Config", hidden: true })).not.toBeInTheDocument();
  });

  it("blocks runtime tabs during a waiting HA rollout without inspecting removed container IDs", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: [
          "docker:containers:view",
          "docker:containers:console",
          "docker:containers:files:read",
        ],
      }),
    });
    vi.mocked(api.getDockerAvailability).mockResolvedValue({
      id: "policy-1",
      mode: "replicated",
      shouldRun: true,
      status: "healthy",
      desiredReplicaCount: 2,
      placements: [],
      latestOperation: {
        id: "operation-1",
        type: "rollout",
        status: "waiting",
        phase: "checking_health",
        progress: { message: "Waiting for candidate readiness" },
        createdAt: new Date().toISOString(),
        errorMessage: "Candidate is not ready",
      },
    } as never);
    vi.spyOn(api, "getDockerDeployment").mockResolvedValue(makeDeployment());
    const inspect = vi.spyOn(api, "inspectContainer");
    renderWithRouter(<DockerDeploymentDetail />, {
      path: "/docker/deployments/:nodeId/:deploymentId/:tab",
      route: "/docker/deployments/node-1/deployment-1/console",
    });
    expect(
      await screen.findByText("Waiting for candidate readiness", { exact: false })
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("data-state", "active")
    );
    for (const name of ["Console", "Files", "Logs"]) {
      expect(screen.getByRole("tab", { name })).toBeDisabled();
    }
    expect(inspect).not.toHaveBeenCalled();
  });

  it("uses ordinary deployment status for Availability even when its single-node policy still wants to run", async () => {
    vi.mocked(api.getDockerAvailability).mockResolvedValue({
      id: "policy-1",
      mode: "single",
      shouldRun: true,
      status: "single",
      desiredReplicaCount: 1,
      placements: [],
      latestOperation: null,
    } as never);
    vi.spyOn(api, "getDockerDeployment").mockResolvedValue(makeDeployment({ status: "stopped" }));
    vi.spyOn(api, "inspectContainer").mockResolvedValue({
      State: { Status: "exited", Running: false },
    } as never);
    renderWithRouter(<DockerDeploymentDetail />, {
      path: "/docker/deployments/:nodeId/:deploymentId/:tab",
      route: "/docker/deployments/node-1/deployment-1/overview",
    });
    await screen.findByRole("button", { name: "Start" });
    await waitFor(() => {
      expect(
        within(screen.getByText("Serving").parentElement!).getByText("Stopped")
      ).toBeInTheDocument();
      expect(
        within(screen.getByText("Placement health").parentElement!).getByText("Stopped")
      ).toBeInTheDocument();
    });
  });

  it("shows stopped HA state instead of a stale running slot and hides migration", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: ["docker:containers:view", "docker:containers:manage", "docker:containers:migrate"],
      }),
    });
    vi.mocked(api.getDockerAvailability).mockResolvedValue({
      id: "policy-1",
      mode: "replicated",
      shouldRun: false,
      status: "healthy",
      desiredReplicaCount: 2,
      placements: [],
      latestOperation: null,
    } as never);
    vi.spyOn(api, "getDockerDeployment").mockResolvedValue(makeDeployment());
    vi.spyOn(api, "inspectContainer").mockResolvedValue({
      State: { Status: "running", Running: true },
    } as never);
    renderWithRouter(<DockerDeploymentDetail />, {
      path: "/docker/deployments/:nodeId/:deploymentId/:tab",
      route: "/docker/deployments/node-1/deployment-1/overview",
    });
    expect(await screen.findByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("button", { name: "Page actions" }), { key: "Enter" });
    await screen.findByRole("menuitem", { name: "View config" });
    expect(screen.queryByRole("menuitem", { name: "Migrate" })).not.toBeInTheDocument();
  });

  it("saves deployment settings with the current execution, route, mount, label, and drain payload", async () => {
    const deployment = makeDeployment();
    vi.spyOn(api, "getDockerDeployment").mockResolvedValue(deployment);
    vi.spyOn(api, "inspectContainer").mockResolvedValue({
      State: { Status: "running", Running: true },
    } as never);
    vi.spyOn(api, "updateDockerDeployment").mockResolvedValue(
      makeDeployment({
        desiredConfig: {
          ...deployment.desiredConfig,
          image: "registry.example.com/team/backend:next",
          command: ["node", "worker.js"],
        },
        drainSeconds: 45,
      })
    );

    renderWithRouter(<DockerDeploymentDetail />, {
      path: "/docker/deployments/:nodeId/:deploymentId/:tab",
      route: "/docker/deployments/node-1/deployment-1/settings",
      extraRoutes: <Route path="/docker" element={<div>Docker list</div>} />,
    });

    expect(await screen.findByText("Execution")).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("c4ce71c1"), { target: { value: "next" } });
    fireEvent.change(screen.getByLabelText("Drain Seconds"), { target: { value: "45" } });
    fireEvent.change(screen.getByDisplayValue("server.js"), {
      target: { value: "node worker.js" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));

    await waitFor(() => {
      expect(api.updateDockerDeployment).toHaveBeenCalledWith("node-1", "deployment-1", {
        desiredConfig: {
          image: "registry.example.com/team/backend:next",
          entrypoint: ["node"],
          command: ["node", "worker.js"],
          workingDir: "/app",
          user: "node",
          mounts: [{ hostPath: "", name: "data", containerPath: "/data", readOnly: false }],
          labels: { service: "backend" },
        },
        routes: [{ hostPort: 8080, containerPort: 3000, isPrimary: true }],
        drainSeconds: 45,
      });
    });
  });

  it("shows the canonical Availability source image instead of the immutable runtime digest", async () => {
    const deployment = makeDeployment({
      desiredConfig: {
        ...makeDeployment().desiredConfig,
        image: `sha256:${"a".repeat(64)}`,
      },
      slots: makeDeployment().slots.map((slot) =>
        slot.slot === "blue" ? { ...slot, image: "nginx:alpine" } : slot
      ),
    });
    vi.spyOn(api, "getDockerDeployment").mockResolvedValue(deployment);
    vi.mocked(api.getDockerAvailability).mockResolvedValue({
      id: "policy-1",
      mode: "replicated",
      shouldRun: true,
      desiredReplicaCount: 2,
      status: "healthy",
      sourceImageReference: `sha256:${"a".repeat(64)}`,
      placements: [],
    } as never);

    renderWithRouter(<DockerDeploymentDetail />, {
      path: "/docker/deployments/:nodeId/:deploymentId/:tab",
      route: "/docker/deployments/node-1/deployment-1/settings",
      extraRoutes: <Route path="/docker" element={<div>Docker list</div>} />,
    });

    expect(await screen.findByDisplayValue("nginx")).toBeInTheDocument();
    expect(screen.getByDisplayValue("alpine")).toBeInTheDocument();
    expect(screen.getByText(/nginx:alpine.*active blue/i)).toBeInTheDocument();
    expect(screen.queryByDisplayValue(`sha256:${"a".repeat(64)}`)).not.toBeInTheDocument();
  });

  it("renders deployment overview and raw config for the active slot", async () => {
    const deployment = makeDeployment();
    vi.spyOn(api, "getDockerDeployment").mockResolvedValue(deployment);
    vi.spyOn(api, "inspectContainer").mockResolvedValue({
      State: { Status: "running", Running: true },
    } as never);

    renderWithRouter(<DockerDeploymentDetail />, {
      path: "/docker/deployments/:nodeId/:deploymentId/:tab",
      route: "/docker/deployments/node-1/deployment-1/overview",
      extraRoutes: <Route path="/docker" element={<div>Docker list</div>} />,
    });

    expect(await screen.findByText("General")).toBeInTheDocument();
    expect(screen.getByText("Active Slot")).toBeInTheDocument();
    expect(screen.getByText("Port Mappings")).toBeInTheDocument();
    expect(screen.getByText("8080 -> 3000")).toBeInTheDocument();
  });

  it("does not expose an opaque Availability runtime digest as the desired image", async () => {
    const deployment = makeDeployment({
      desiredConfig: {
        ...makeDeployment().desiredConfig,
        image: `sha256:${"b".repeat(64)}`,
      },
      slots: makeDeployment().slots.map((slot) =>
        slot.slot === "blue" ? { ...slot, image: "nginx:alpine" } : slot
      ),
    });
    vi.spyOn(api, "getDockerDeployment").mockResolvedValue(deployment);
    vi.spyOn(api, "inspectContainer").mockResolvedValue({
      State: { Status: "running", Running: true },
    } as never);

    renderWithRouter(<DockerDeploymentDetail />, {
      path: "/docker/deployments/:nodeId/:deploymentId/:tab",
      route: "/docker/deployments/node-1/deployment-1/overview",
      extraRoutes: <Route path="/docker" element={<div>Docker list</div>} />,
    });

    const row = (await screen.findByText("Desired Image")).parentElement;
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("nginx:alpine");
    expect(row).not.toHaveTextContent(`sha256:${"b".repeat(64)}`);
  });

  it("renders raw deployment config from the config route", async () => {
    const deployment = makeDeployment();
    vi.spyOn(api, "getDockerDeployment").mockResolvedValue(deployment);
    vi.spyOn(api, "inspectContainer").mockResolvedValue({
      State: { Status: "running", Running: true },
    } as never);

    renderWithRouter(<DockerDeploymentDetail />, {
      path: "/docker/deployments/:nodeId/:deploymentId/:tab",
      route: "/docker/deployments/node-1/deployment-1/config",
      extraRoutes: <Route path="/docker" element={<div>Docker list</div>} />,
    });

    expect(await screen.findByText("Deployment Config")).toBeInTheDocument();
    expect(screen.getByText("Service-level configuration")).toBeInTheDocument();
  });

  it("reads an already-published container snapshot from cache without creating a feedback loop", async () => {
    const deployment = makeDeployment();
    vi.spyOn(api, "getDockerDeployment").mockResolvedValue(deployment);
    const inspectContainer = vi.spyOn(api, "inspectContainer").mockResolvedValue({
      State: { Status: "running", Running: true },
    } as never);

    renderWithRouter(<DockerDeploymentDetail />, {
      path: "/docker/deployments/:nodeId/:deploymentId/:tab",
      route: "/docker/deployments/node-1/deployment-1/overview",
      extraRoutes: <Route path="/docker" element={<div>Docker list</div>} />,
    });

    await waitFor(() => expect(inspectContainer).toHaveBeenCalledTimes(1));
    expect(inspectContainer).toHaveBeenLastCalledWith("node-1", "container-blue", true);

    await act(async () => {
      realtimeHandlers.get("docker.snapshot.changed")?.({
        nodeId: "node-1",
        kind: "containers",
      });
    });

    await waitFor(() => expect(inspectContainer).toHaveBeenCalledTimes(2));
    expect(inspectContainer).toHaveBeenLastCalledWith("node-1", "container-blue", false);
  });

  it("keeps Availability settings reachable when the origin deployment node is unavailable", async () => {
    vi.mocked(api.getDockerAvailability).mockResolvedValue({ mode: "failover" } as never);
    vi.spyOn(api, "getDockerDeployment").mockResolvedValue(
      makeDeployment({ availability: "unavailable" })
    );
    vi.spyOn(api, "inspectContainer").mockRejectedValue(new Error("Node is offline"));

    renderWithRouter(<DockerDeploymentDetail />, {
      path: "/docker/deployments/:nodeId/:deploymentId/:tab",
      route: "/docker/deployments/node-1/deployment-1/settings",
      extraRoutes: <Route path="/docker" element={<div>Docker list</div>} />,
    });

    expect(await screen.findByText("Availability controls")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Settings" })).toHaveAttribute("data-state", "active");
  });

  it("does not redirect an Availability runtime tab before its placements finish loading", async () => {
    let resolveAvailability!: (value: unknown) => void;
    vi.mocked(api.getDockerAvailability).mockImplementation(
      () => new Promise((resolve) => (resolveAvailability = resolve)) as never
    );
    vi.spyOn(api, "getDockerDeployment").mockResolvedValue(
      makeDeployment({
        slots: makeDeployment().slots.map((slot) =>
          slot.slot === "blue" ? { ...slot, containerId: "stale-origin-slot" } : slot
        ),
      })
    );
    const inspectContainer = vi.spyOn(api, "inspectContainer").mockResolvedValue({
      State: { Status: "running", Running: true },
    } as never);

    renderWithRouter(<DockerDeploymentDetail />, {
      path: "/docker/deployments/:nodeId/:deploymentId/:tab",
      route: "/docker/deployments/node-1/deployment-1/logs",
      extraRoutes: <Route path="/docker" element={<div>Docker list</div>} />,
    });

    await screen.findByRole("tab", { name: "Logs" });
    expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute("data-state", "active");
    expect(inspectContainer).not.toHaveBeenCalled();

    await act(async () => {
      resolveAvailability({
        id: "policy-1",
        mode: "replicated",
        shouldRun: true,
        desiredReplicaCount: 2,
        status: "healthy",
        placements: [
          {
            id: "placement-1",
            nodeId: "node-1",
            generation: 1,
            serving: true,
            actualState: "serving",
            runtimeIdentity: { activeSlot: "blue", slots: { blue: "runtime-blue" } },
          },
        ],
      });
    });

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Logs" })).toHaveAttribute("data-state", "active")
    );
    await waitFor(() =>
      expect(inspectContainer).toHaveBeenCalledWith("node-1", "runtime-blue", true)
    );
    expect(inspectContainer).not.toHaveBeenCalledWith(
      "node-1",
      "stale-origin-slot",
      expect.anything()
    );
  });

  it("inspects the serving Availability placement instead of a stale origin slot id", async () => {
    vi.mocked(api.getDockerAvailability).mockResolvedValue({
      id: "policy-1",
      mode: "replicated",
      shouldRun: true,
      desiredReplicaCount: 2,
      status: "healthy",
      placements: [
        {
          id: "placement-remote",
          nodeId: "node-2",
          generation: 5,
          serving: true,
          actualState: "serving",
          runtimeIdentity: { activeSlot: "blue", slots: { blue: "runtime-blue" } },
        },
      ],
    } as never);
    vi.spyOn(api, "getDockerDeployment").mockResolvedValue(
      makeDeployment({
        slots: makeDeployment().slots.map((slot) =>
          slot.slot === "blue" ? { ...slot, containerId: "stale-origin-slot" } : slot
        ),
      })
    );
    const inspectContainer = vi.spyOn(api, "inspectContainer").mockResolvedValue({
      State: { Status: "running", Running: true },
    } as never);

    renderWithRouter(<DockerDeploymentDetail />, {
      path: "/docker/deployments/:nodeId/:deploymentId/:tab",
      route: "/docker/deployments/node-1/deployment-1/overview",
      extraRoutes: <Route path="/docker" element={<div>Docker list</div>} />,
    });

    await waitFor(() =>
      expect(inspectContainer).toHaveBeenCalledWith("node-2", "runtime-blue", true)
    );
    expect(inspectContainer).not.toHaveBeenCalledWith(
      "node-1",
      "stale-origin-slot",
      expect.anything()
    );
  });

  it("derives the active slot and both slot states from the selected Availability placement", async () => {
    vi.mocked(api.getDockerAvailability).mockResolvedValue({
      id: "policy-1",
      mode: "replicated",
      shouldRun: true,
      desiredReplicaCount: 2,
      status: "healthy",
      placements: [
        {
          id: "placement-remote",
          nodeId: "node-2",
          generation: 5,
          serving: true,
          actualState: "serving",
          runtimeIdentity: {
            containerId: "runtime-green",
            blueContainerId: "runtime-blue",
            greenContainerId: "runtime-green",
            slots: { blue: "runtime-blue", green: "runtime-green" },
          },
        },
      ],
    } as never);
    vi.spyOn(api, "getDockerDeployment").mockResolvedValue(makeDeployment());
    vi.spyOn(api, "inspectContainer").mockImplementation(async (_nodeId, containerId) => {
      if (containerId === "runtime-green") {
        return {
          Id: "runtime-green",
          State: { Status: "running", Running: true, Health: { Status: "healthy" } },
        } as never;
      }
      return {
        Id: "runtime-blue",
        State: { Status: "exited", Running: false, Health: { Status: "unhealthy" } },
      } as never;
    });

    renderWithRouter(<DockerDeploymentDetail />, {
      path: "/docker/deployments/:nodeId/:deploymentId/:tab",
      route: "/docker/deployments/node-1/deployment-1/slots",
      extraRoutes: <Route path="/docker" element={<div>Docker list</div>} />,
    });

    const greenCard = (await screen.findByRole("heading", { name: "Green slot" })).closest(
      ".border"
    );
    const blueCard = screen.getByRole("heading", { name: "Blue slot" }).closest(".border");
    expect(greenCard).not.toBeNull();
    expect(blueCard).not.toBeNull();
    await waitFor(() => {
      expect(greenCard).toHaveTextContent("Active");
      expect(greenCard).toHaveTextContent("running");
      expect(greenCard).toHaveTextContent("healthy");
      expect(blueCard).toHaveTextContent("Standby");
      expect(blueCard).toHaveTextContent("exited");
      expect(blueCard).toHaveTextContent("stopped");
      expect(blueCard).not.toHaveTextContent("unhealthy");
    });
  });

  it.each([
    { name: "stopped standby", state: "exited", active: false, busy: false, expected: "stopped" },
    {
      name: "running failed standby",
      state: "running",
      active: false,
      busy: false,
      expected: "unhealthy",
    },
    {
      name: "unexpectedly exited active slot",
      state: "exited",
      active: true,
      busy: false,
      expected: "unhealthy",
    },
    {
      name: "stopping standby",
      state: "stopping",
      active: false,
      busy: true,
      expected: "unhealthy",
    },
    {
      name: "standby during a transition",
      state: "exited",
      active: false,
      busy: true,
      expected: "unhealthy",
    },
    {
      name: "failed stopped candidate",
      state: "failed",
      active: false,
      busy: false,
      expected: "unhealthy",
    },
  ])("renders $name health without hiding failures or transitions", ({
    state,
    active,
    busy,
    expected,
  }) => {
    const deployment = makeDeployment();
    deployment.slots = deployment.slots.map((slot) =>
      slot.slot === "green" ? { ...slot, status: state, health: "unhealthy" } : slot
    );
    render(
      <DeploymentSlots
        deployment={deployment}
        nodeId="node-1"
        action={null}
        serviceBusy={busy}
        runAction={vi.fn()}
        canManage={false}
        activeSlotOverride={active ? "green" : "blue"}
        slotInspects={{
          green: {
            State: {
              Status: state === "running" ? "running" : "exited",
              Running: state === "running",
              Health: { Status: "unhealthy" },
            },
          },
        }}
      />
    );
    const card = screen
      .getByRole("heading", { name: "Green slot" })
      .closest(".border") as HTMLElement;
    const healthRow = within(card).getByText("Health").parentElement!;
    const healthBadge = within(healthRow).getByText(expected).parentElement!;
    expect(healthBadge).toHaveClass(
      expected === "stopped" ? "text-muted-foreground" : "text-red-600"
    );
    if (state === "stopping") expect(within(card).getByText("stopping")).toBeInTheDocument();
  });
});
