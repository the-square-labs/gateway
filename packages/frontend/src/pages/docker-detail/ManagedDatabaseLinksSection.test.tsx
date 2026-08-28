import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps, FormEvent } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirm } from "@/components/common/ConfirmDialog";
import { api } from "@/services/api";
import { makeNode } from "@/test/fixtures";
import type { ManagedDatabase, ManagedDatabaseBinding } from "@/types";
import { ManagedDatabaseLinksSection } from "./ManagedDatabaseLinksSection";

vi.mock("@/components/common/ConfirmDialog", () => ({ confirm: vi.fn() }));

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
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

function renderLinks(props: Partial<ComponentProps<typeof ManagedDatabaseLinksSection>> = {}) {
  return render(
    <MemoryRouter>
      <ManagedDatabaseLinksSection
        nodeId="node-1"
        targetType="container"
        targetResourceId="app"
        containerName="app"
        {...props}
      />
    </MemoryRouter>
  );
}

describe("ManagedDatabaseLinksSection", () => {
  beforeEach(() => {
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [
        makeNode({
          id: database.nodeId,
          type: "databases",
          displayName: "Database Blue",
          appearanceColor: "blue",
        }),
      ],
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(confirm).mockReset();
  });

  it("uses the shared empty state and an add dialog that only stages a link", async () => {
    vi.spyOn(api, "listManagedDatabases").mockResolvedValue([database]);
    vi.spyOn(api, "listManagedDatabaseBindings").mockResolvedValue([]);
    const create = vi.spyOn(api, "createManagedDatabaseBinding").mockResolvedValue(binding);

    renderLinks();

    expect(await screen.findByText("No managed database links")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText("Add Managed Database Link")).toBeInTheDocument();
    const databaseSelect = screen.getByRole("combobox", { name: "Database" });
    expect(databaseSelect).toHaveTextContent("App Postgres");
    expect(databaseSelect).not.toHaveTextContent("postgres");

    fireEvent.click(databaseSelect);
    const databaseOption = await screen.findByRole("option", { name: "App Postgres" });
    expect(databaseOption).toHaveTextContent("App Postgres");
    expect(databaseOption).toHaveTextContent("postgres");
    expect(databaseOption).toHaveTextContent("Database Blue");
    fireEvent.click(databaseOption);

    fireEvent.click(screen.getByRole("button", { name: "Add link" }));

    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByText("Add Managed Database Link")).not.toBeInTheDocument();
    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save & Recreate" })).toBeEnabled();
  });

  it("offers credential-variable injection", async () => {
    vi.spyOn(api, "listManagedDatabases").mockResolvedValue([database]);
    vi.spyOn(api, "listManagedDatabaseBindings").mockResolvedValue([]);

    renderLinks();
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByLabelText("Inject as"));
    fireEvent.click(await screen.findByRole("option", { name: "Credential variables" }));

    await waitFor(() => {
      expect(screen.getByLabelText("Host variable")).toHaveValue("POSTGRES_HOST");
      expect(screen.getByLabelText("Database variable")).toHaveValue("POSTGRES_DB");
      expect(screen.getByLabelText("Password variable")).toHaveValue("POSTGRES_PASSWORD");
    });
  });

  it("warns before a staged link replaces an existing environment variable", async () => {
    vi.spyOn(api, "listManagedDatabases").mockResolvedValue([database]);
    vi.spyOn(api, "listManagedDatabaseBindings").mockResolvedValue([]);
    vi.mocked(confirm).mockResolvedValue(false);

    renderLinks({ existingVariableNames: ["DATABASE_URL"] });
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));

    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Replace existing variables?",
          description: expect.stringContaining("DATABASE_URL"),
        })
      )
    );
    expect(screen.queryByText("pending")).not.toBeInTheDocument();
  });

  it("shows the create-database dialog instead of the link form when no database can be linked", async () => {
    vi.spyOn(api, "listManagedDatabases").mockResolvedValue([]);

    renderLinks();
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));

    expect(await screen.findByText("No managed databases available")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create database" })).toBeInTheDocument();
    expect(screen.queryByText("Add Managed Database Link")).not.toBeInTheDocument();
  });

  it("keeps unlink in the settings row, stages it after confirmation, and saves only on request", async () => {
    vi.spyOn(api, "listManagedDatabases").mockResolvedValue([database]);
    vi.spyOn(api, "listManagedDatabaseBindings").mockResolvedValue([binding]);
    const remove = vi.spyOn(api, "deleteManagedDatabaseBinding").mockResolvedValue(undefined);
    vi.mocked(confirm).mockResolvedValue(true);

    renderLinks();

    expect(await screen.findByText("App Postgres")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unlink App Postgres" }));

    await waitFor(() => expect(confirm).toHaveBeenCalledTimes(1));
    expect(remove).not.toHaveBeenCalled();
    expect(await screen.findByText("will unlink")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Save & Recreate" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith(database.id, binding.id));
  });

  it("keeps links visible but unavailable when their databases node is offline", async () => {
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: [
        makeNode({
          id: database.nodeId,
          type: "databases",
          displayName: "Database Blue",
          appearanceColor: "blue",
          status: "offline",
          isConnected: false,
        }),
      ],
      total: 1,
      page: 1,
      limit: 100,
      totalPages: 1,
    });
    vi.spyOn(api, "listManagedDatabases").mockResolvedValue([database]);
    vi.spyOn(api, "listManagedDatabaseBindings").mockResolvedValue([binding]);

    renderLinks();

    expect(await screen.findByText("App Postgres")).toBeInTheDocument();
    expect(screen.getByText("Database Blue")).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByText("No managed databases available")).toBeInTheDocument();
  });

  it("unlocks link controls without waiting for the background container refresh", async () => {
    vi.spyOn(api, "listManagedDatabases").mockResolvedValue([database]);
    vi.spyOn(api, "listManagedDatabaseBindings").mockResolvedValue([]);
    vi.spyOn(api, "createManagedDatabaseBinding").mockResolvedValue(binding);
    vi.mocked(confirm).mockResolvedValue(true);
    const onRecreating = vi.fn(() => new Promise<void>(() => undefined));

    renderLinks({ onRecreating });
    fireEvent.click(await screen.findByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    fireEvent.click(screen.getByRole("button", { name: "Save & Recreate" }));

    await waitFor(() => expect(onRecreating).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Add" })).toBeEnabled();
  });

  it("lets each Compose binding select its own service", async () => {
    const composeBinding: ManagedDatabaseBinding = {
      ...binding,
      targetType: "compose_service",
      targetResourceId: "project-1:web",
    };
    vi.spyOn(api, "listManagedDatabases").mockResolvedValue([database]);
    vi.spyOn(api, "listManagedDatabaseBindings").mockResolvedValue([composeBinding]);
    const create = vi
      .spyOn(api, "createManagedDatabaseBinding")
      .mockResolvedValue({ ...composeBinding, id: "binding-2", targetResourceId: "project-1:api" });
    vi.mocked(confirm).mockResolvedValue(true);

    renderLinks({
      targetType: "compose_service",
      targetResourceId: "project-1",
      containerName: "project",
      composeServices: [
        { name: "web", existingVariableNames: ["DATABASE_URL"] },
        { name: "api", existingVariableNames: [] },
      ],
    });

    const existingService = await screen.findByRole("combobox", {
      name: "Compose service for App Postgres",
    });
    expect(existingService).toHaveTextContent("web");

    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(await screen.findByRole("combobox", { name: "Compose service" })).toHaveTextContent(
      "api"
    );
    fireEvent.click(screen.getByRole("button", { name: "Add link" }));
    fireEvent.click(screen.getByRole("button", { name: "Save & Recreate" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        database.id,
        expect.objectContaining({
          targetType: "compose_service",
          targetResourceId: "project-1:api",
        })
      )
    );
  });

  it("stages moving one existing Compose binding to another service", async () => {
    const composeBinding: ManagedDatabaseBinding = {
      ...binding,
      targetType: "compose_service",
      targetResourceId: "project-1:web",
    };
    vi.spyOn(api, "listManagedDatabases").mockResolvedValue([database]);
    vi.spyOn(api, "listManagedDatabaseBindings").mockResolvedValue([composeBinding]);
    const remove = vi.spyOn(api, "deleteManagedDatabaseBinding").mockResolvedValue(undefined);
    const create = vi
      .spyOn(api, "createManagedDatabaseBinding")
      .mockResolvedValue({ ...composeBinding, targetResourceId: "project-1:worker" });
    vi.mocked(confirm).mockResolvedValue(true);

    renderLinks({
      targetType: "compose_service",
      targetResourceId: "project-1",
      containerName: "project",
      composeServices: [
        { name: "web", existingVariableNames: ["DATABASE_URL"] },
        { name: "worker", existingVariableNames: [] },
      ],
    });

    fireEvent.click(
      await screen.findByRole("combobox", { name: "Compose service for App Postgres" })
    );
    fireEvent.click(await screen.findByRole("option", { name: "worker" }));

    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Save & Recreate" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(database.id, composeBinding.id));
    expect(create).toHaveBeenCalledWith(
      database.id,
      expect.objectContaining({
        targetType: "compose_service",
        targetResourceId: "project-1:worker",
      })
    );
  });

  it("does not submit an enclosing form", async () => {
    vi.spyOn(api, "listManagedDatabases").mockResolvedValue([]);
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    render(
      <MemoryRouter>
        <form onSubmit={onSubmit}>
          <ManagedDatabaseLinksSection
            nodeId="node-1"
            targetType="container"
            targetResourceId="app"
            containerName="app"
          />
        </form>
      </MemoryRouter>
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
