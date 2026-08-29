import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confirm } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useDockerStore } from "@/stores/docker";
import { makeNode, makeUser } from "@/test/fixtures";
import type { ManagedDatabase, ManagedDatabaseBinding } from "@/types";
import { EnvironmentTab } from "./EnvironmentTab";

vi.mock("@/components/common/ConfirmDialog", () => ({ confirm: vi.fn() }));
const realtimeHandlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: (channel: string | null, handler: (payload: unknown) => void) => {
    if (channel) realtimeHandlers.set(channel, handler);
  },
}));

const database: ManagedDatabase = {
  id: "database-1",
  databaseConnectionId: "connection-1",
  slug: "app-postgres",
  name: "App Postgres",
  type: "postgres",
  version: "17",
  nodeId: "database-node-1",
  storageSizeBytes: 1_073_741_824,
  runtimeConfig: { cpuCores: 1, memoryMb: 512, swapMb: 0 },
  publishedPort: null,
  publishedNativePort: null,
  tlsEnabled: true,
  status: "ready",
  lastError: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const binding: ManagedDatabaseBinding = {
  id: "binding-1",
  managedDatabaseId: database.id,
  targetNodeId: "node-1",
  targetType: "container",
  targetResourceId: "app",
  environment: { connectionUri: "DATABASE_URL" },
  status: "ready",
  lastError: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

describe("EnvironmentTab managed database links", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(confirm).mockReset();
    realtimeHandlers.clear();
  });

  it("reloads environment from the replacement container after recreate settles", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["docker:containers:environment"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    useDockerStore.setState({ invalidate: vi.fn().mockResolvedValue(undefined) });
    const getContainerEnv = vi
      .spyOn(api, "getContainerEnv")
      .mockResolvedValueOnce(["VERSION=old"])
      .mockResolvedValueOnce(["VERSION=old"])
      .mockResolvedValueOnce(["VERSION=new"]);
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 1,
      totalPages: 0,
    });

    const { rerender } = render(
      <MemoryRouter>
        <EnvironmentTab nodeId="node-1" containerId="container-old" containerName="app" />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue("old")).toBeInTheDocument();
    rerender(
      <MemoryRouter>
        <EnvironmentTab nodeId="node-1" containerId="container-new" containerName="app" />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(getContainerEnv).toHaveBeenLastCalledWith("node-1", "container-new")
    );
    expect(screen.getByDisplayValue("old")).toBeInTheDocument();

    realtimeHandlers.get("docker.container.changed")?.({
      nodeId: "node-1",
      name: "app",
      id: "container-new",
      oldId: "container-old",
      action: "recreated",
    });

    expect(await screen.findByDisplayValue("new")).toBeInTheDocument();
    expect(getContainerEnv).toHaveBeenLastCalledWith("node-1", "container-new");
  });

  it("ignores a stale environment response from the previous container id", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["docker:containers:environment"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    useDockerStore.setState({ invalidate: vi.fn().mockResolvedValue(undefined) });
    let resolveOld: ((value: string[]) => void) | undefined;
    let resolveNew: ((value: string[]) => void) | undefined;
    vi.spyOn(api, "getContainerEnv")
      .mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            resolveOld = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<string[]>((resolve) => {
            resolveNew = resolve;
          })
      );
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 1,
      totalPages: 0,
    });

    const { rerender } = render(
      <MemoryRouter>
        <EnvironmentTab nodeId="node-1" containerId="container-old" containerName="app" />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(api.getContainerEnv).toHaveBeenCalledWith("node-1", "container-old")
    );
    rerender(
      <MemoryRouter>
        <EnvironmentTab nodeId="node-1" containerId="container-new" containerName="app" />
      </MemoryRouter>
    );
    await waitFor(() =>
      expect(api.getContainerEnv).toHaveBeenCalledWith("node-1", "container-new")
    );

    await act(async () => resolveNew?.(["VERSION=new"]));
    expect(await screen.findByDisplayValue("new")).toBeInTheDocument();
    await act(async () => resolveOld?.(["VERSION=old"]));
    expect(screen.queryByDisplayValue("old")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("new")).toBeInTheDocument();
  });

  it("hides a confirmed replacement from the ordinary env draft before save", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["docker:containers:environment", "docker:containers:secrets"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    useDockerStore.setState({ invalidate: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(api, "getContainerEnv").mockResolvedValue(["PATH=/usr/bin", "DATABASE_URL=old-value"]);
    vi.spyOn(api, "listDockerSecrets").mockResolvedValue([]);
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [makeNode({ id: database.nodeId, type: "databases" })],
      total: 1,
      page: 1,
      limit: 1,
      totalPages: 1,
    });
    vi.spyOn(api, "listManagedDatabases").mockResolvedValue([database]);
    vi.spyOn(api, "listManagedDatabaseBindings").mockResolvedValue([]);
    vi.mocked(confirm).mockResolvedValue(true);

    render(
      <MemoryRouter>
        <EnvironmentTab nodeId="node-1" containerId="container-1" containerName="app" />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue("DATABASE_URL")).toBeInTheDocument();
    await screen.findByText("No managed database links");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add link" }));

    await waitFor(() => expect(screen.getByText("pending")).toBeInTheDocument());
    expect(screen.queryByDisplayValue("DATABASE_URL")).not.toBeInTheDocument();
    for (const button of screen.getAllByRole("button", { name: "Save & Recreate" })) {
      expect(button).toBeEnabled();
    }
  });

  it("does not show managed database links when no databases node exists", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["docker:containers:environment", "docker:containers:secrets"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    useDockerStore.setState({ invalidate: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(api, "getContainerEnv").mockResolvedValue(["DATABASE_URL=old-value"]);
    vi.spyOn(api, "listDockerSecrets").mockResolvedValue([]);
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 1,
      totalPages: 0,
    });

    render(
      <MemoryRouter>
        <EnvironmentTab nodeId="node-1" containerId="container-1" containerName="app" />
      </MemoryRouter>
    );

    expect(await screen.findByDisplayValue("DATABASE_URL")).toBeInTheDocument();
    await waitFor(() =>
      expect(api.listNodes).toHaveBeenCalledWith({ type: "databases", limit: 1 })
    );
    expect(screen.queryByText("Managed Database Links")).not.toBeInTheDocument();
  });

  it("disables managed database link controls while the container is transitioning", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["docker:containers:environment", "docker:containers:secrets"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    useDockerStore.setState({ invalidate: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(api, "getContainerEnv").mockResolvedValue(["PATH=/usr/bin"]);
    vi.spyOn(api, "listDockerSecrets").mockResolvedValue([]);
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [makeNode({ id: database.nodeId, type: "databases" })],
      total: 1,
      page: 1,
      limit: 1,
      totalPages: 1,
    });
    vi.spyOn(api, "listManagedDatabases").mockResolvedValue([database]);
    vi.spyOn(api, "listManagedDatabaseBindings").mockResolvedValue([]);

    render(
      <MemoryRouter>
        <EnvironmentTab nodeId="node-1" containerId="container-1" containerName="app" disabled />
      </MemoryRouter>
    );

    expect(await screen.findByRole("button", { name: "Add" })).toBeDisabled();
  });

  it("does not re-fetch the old container after saving a managed database link", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["docker:containers:environment", "docker:containers:secrets"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    useDockerStore.setState({ invalidate: vi.fn().mockResolvedValue(undefined) });
    const getContainerEnv = vi.spyOn(api, "getContainerEnv").mockResolvedValue(["PATH=/usr/bin"]);
    vi.spyOn(api, "listDockerSecrets").mockResolvedValue([]);
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [makeNode({ id: database.nodeId, type: "databases" })],
      total: 1,
      page: 1,
      limit: 1,
      totalPages: 1,
    });
    vi.spyOn(api, "listManagedDatabases").mockResolvedValue([database]);
    vi.spyOn(api, "listManagedDatabaseBindings").mockResolvedValue([]);
    vi.spyOn(api, "createManagedDatabaseBinding").mockResolvedValue(binding);
    vi.mocked(confirm).mockResolvedValue(true);
    const onRecreating = vi.fn();

    render(
      <MemoryRouter>
        <EnvironmentTab
          nodeId="node-1"
          containerId="container-1"
          containerName="app"
          onRecreating={onRecreating}
        />
      </MemoryRouter>
    );

    await screen.findByDisplayValue("PATH");
    await screen.findByText("No managed database links");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add link" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Save & Recreate" })[0]!);

    await waitFor(() => expect(api.createManagedDatabaseBinding).toHaveBeenCalledOnce());
    expect(getContainerEnv).toHaveBeenCalledOnce();
    expect(onRecreating).toHaveBeenCalledOnce();
  });

  it("recreates a running container when only a secret changed", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["docker:containers:environment", "docker:containers:secrets"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    useDockerStore.setState({ invalidate: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(api, "getContainerEnv").mockResolvedValue(["PATH=/usr/bin"]);
    vi.spyOn(api, "listDockerSecrets")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "secret-1",
          key: "OPENAI_API_KEY",
          value: "••••••••",
          createdAt: "2026-08-23T17:36:10.000Z",
          updatedAt: "2026-08-23T17:36:10.000Z",
        },
      ]);
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 1,
      totalPages: 0,
    });
    vi.spyOn(api, "createDockerSecret").mockResolvedValue({
      id: "secret-1",
      key: "OPENAI_API_KEY",
      value: "••••••••",
      createdAt: "2026-08-23T17:36:10.000Z",
      updatedAt: "2026-08-23T17:36:10.000Z",
    });
    const updateContainerEnv = vi.spyOn(api, "updateContainerEnv").mockResolvedValue({});
    vi.mocked(confirm).mockResolvedValue(true);
    const onMutationStart = vi.fn();
    const onRecreating = vi.fn();

    render(
      <MemoryRouter>
        <EnvironmentTab
          nodeId="node-1"
          containerId="container-1"
          containerName="app"
          containerState="running"
          onMutationStart={onMutationStart}
          onRecreating={onRecreating}
        />
      </MemoryRouter>
    );

    await screen.findByText("No secrets configured.");
    fireEvent.click(screen.getByTitle("Add secret"));
    fireEvent.change(screen.getByPlaceholderText("SECRET_KEY"), {
      target: { value: "OPENAI_API_KEY" },
    });
    fireEvent.change(screen.getByPlaceholderText("secret value"), {
      target: { value: "secret-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & Recreate" }));

    await waitFor(() => expect(api.createDockerSecret).toHaveBeenCalledOnce());
    expect(updateContainerEnv).toHaveBeenCalledWith(
      "node-1",
      "container-1",
      { PATH: "/usr/bin" },
      undefined
    );
    expect(onMutationStart).toHaveBeenCalledWith("updating");
    expect(onRecreating).toHaveBeenCalledOnce();
  });

  it("removes a deleted secret from runtime env during recreate", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["docker:containers:environment", "docker:containers:secrets"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    useDockerStore.setState({ invalidate: vi.fn().mockResolvedValue(undefined) });
    vi.spyOn(api, "getContainerEnv").mockResolvedValue(["PATH=/usr/bin"]);
    vi.spyOn(api, "listDockerSecrets")
      .mockResolvedValueOnce([
        {
          id: "secret-1",
          key: "OPENAI_API_KEY",
          value: "••••••••",
          createdAt: "2026-08-23T17:36:10.000Z",
          updatedAt: "2026-08-23T17:36:10.000Z",
        },
      ])
      .mockResolvedValueOnce([]);
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 1,
      totalPages: 0,
    });
    vi.spyOn(api, "deleteDockerSecret").mockResolvedValue(undefined);
    const updateContainerEnv = vi.spyOn(api, "updateContainerEnv").mockResolvedValue({});
    vi.mocked(confirm).mockResolvedValue(true);

    render(
      <MemoryRouter>
        <EnvironmentTab
          nodeId="node-1"
          containerId="container-1"
          containerName="app"
          containerState="running"
        />
      </MemoryRouter>
    );

    const secretKey = await screen.findByDisplayValue("OPENAI_API_KEY");
    const secretRow = secretKey.closest(".grid");
    expect(secretRow).not.toBeNull();
    const secretActions = within(secretRow as HTMLElement).getAllByRole("button");
    fireEvent.click(secretActions.at(-1)!);
    fireEvent.click(screen.getByRole("button", { name: "Save & Recreate" }));

    await waitFor(() => expect(api.deleteDockerSecret).toHaveBeenCalledOnce());
    expect(updateContainerEnv).toHaveBeenCalledWith("node-1", "container-1", { PATH: "/usr/bin" }, [
      "OPENAI_API_KEY",
    ]);
  });
});
