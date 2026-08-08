import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Route } from "react-router-dom";
import { vi } from "vitest";
import { DockerDeploymentDetail } from "@/pages/DockerDeploymentDetail";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";
import type { DockerDeployment } from "@/types";

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
    vi.spyOn(api, "getNode").mockResolvedValue({
      id: "node-1",
      liveHealthReport: { gpuDevices: [] },
      lastHealthReport: null,
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
    fireEvent.change(screen.getByDisplayValue("30"), { target: { value: "45" } });
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
});
