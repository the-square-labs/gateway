import { fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { vi } from "vitest";
import { Logging } from "@/pages/Logging";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useResourceFolderStore } from "@/stores/resource-folders";
import { useSystemConfigStore } from "@/stores/system-config";
import { makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";
import type { LoggingEnvironment, LoggingSchema } from "@/types";
import { LoggingEnvironmentDialog } from "./LoggingEnvironmentDialog";
import { LoggingExplorer } from "./LoggingExplorer";
import { LoggingSchemaEditor } from "./LoggingSchemaEditor";
import { LoggingTokenPanel } from "./LoggingTokenPanel";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/services/api", () => ({
  api: {
    listLoggingTokens: vi.fn(),
    createLoggingToken: vi.fn(),
    deleteLoggingToken: vi.fn(),
    getCached: vi.fn(),
    setCache: vi.fn(),
    listLoggingEnvironments: vi.fn(),
    listLoggingSchemas: vi.fn(),
    getLoggingSchema: vi.fn(),
    getLoggingMetadata: vi.fn(),
    searchLogs: vi.fn(),
  },
}));

const environment: LoggingEnvironment = {
  id: "env-1",
  name: "Production",
  slug: "production",
  description: null,
  enabled: true,
  schemaId: null,
  schemaName: null,
  schemaMode: "reject",
  retentionDays: 30,
  rateLimitRequestsPerWindow: null,
  rateLimitEventsPerWindow: null,
  fieldSchema: [],
  createdById: null,
  createdAt: "2026-04-27T00:00:00.000Z",
  updatedAt: "2026-04-27T00:00:00.000Z",
};

const schema: LoggingSchema = {
  id: "schema-1",
  name: "Audit Events",
  slug: "audit-events",
  description: null,
  schemaMode: "reject",
  fieldSchema: [{ location: "field", key: "statusCode", type: "number", required: false }],
  createdById: "user-1",
  createdAt: "2026-04-27T00:00:00.000Z",
  updatedAt: "2026-04-27T00:00:00.000Z",
};

describe("Logging UI", () => {
  beforeEach(() => {
    vi.mocked(api.getCached).mockReturnValue(undefined);
    vi.mocked(api.setCache).mockReturnValue(undefined);
    vi.mocked(api.listLoggingEnvironments).mockResolvedValue([]);
    vi.mocked(api.listLoggingSchemas).mockResolvedValue([]);
    vi.mocked(api.getLoggingSchema).mockResolvedValue(schema);
    useSystemConfigStore.setState({
      config: {
        fileUploadMaxBytes: 100 * 1024 * 1024,
        fileOpenMaxBytes: 10 * 1024 * 1024,
        gatewayGrpcPublicTarget: null,
        gatewayGrpcLocalIp: null,
        relayAutoRecovery: true,
        features: {
          pkiEnabled: true,
          domainsEnabled: true,
          siemEnabled: true,
          loggingEnabled: true,
          inferenceEnabled: false,
        },
      },
      isLoading: false,
      loaded: true,
    });
  });

  it("prevents adding schema rows while duplicate keys exist", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    renderWithRouter(
      <LoggingSchemaEditor
        schema={{
          schemaMode: environment.schemaMode,
          fieldSchema: [
            { location: "field", key: "statusCode", type: "number", required: false },
            { location: "field", key: "statusCode", type: "number", required: false },
          ],
        }}
        canEdit
        onSave={onSave}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /add field/i }));

    expect(toast.error).toHaveBeenCalledWith(
      "Fix duplicate or empty keys before adding more fields"
    );
    expect(onSave).not.toHaveBeenCalled();
  });

  it("shows a newly created ingest token once", async () => {
    vi.mocked(api.listLoggingTokens).mockResolvedValue([]);
    vi.mocked(api.createLoggingToken).mockResolvedValue({
      id: "token-1",
      environmentId: "env-1",
      name: "demo",
      tokenPrefix: "gwl_abcdef",
      enabled: true,
      lastUsedAt: null,
      expiresAt: null,
      createdById: "user-1",
      createdAt: "2026-04-27T00:00:00.000Z",
      token: "gwl_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    });

    renderWithRouter(
      <LoggingTokenPanel
        environment={environment}
        canDelete={false}
        createDialogOpen
        onCreateDialogOpenChange={vi.fn()}
      />
    );

    expect(screen.getByRole("dialog")).toHaveClass("sm:max-w-md");
    expect(screen.getByPlaceholderText("Production collector")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/name/i), { target: { value: "demo" } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    await waitFor(() => {
      expect(screen.getByText(/gwl_abcdef0123456789/)).toBeInTheDocument();
    });
  });

  it("shows log search loading state before the debounced request starts", async () => {
    vi.mocked(api.getLoggingMetadata).mockResolvedValue({
      services: [],
      sources: [],
      labelKeys: [],
      fieldKeys: [],
      labelValues: {},
    });
    vi.mocked(api.searchLogs).mockReturnValue(new Promise(() => {}));

    renderWithRouter(<LoggingExplorer environment={environment} storageAvailable />);

    await waitFor(() => {
      expect(screen.getByText("Searching logs...")).toBeInTheDocument();
    });
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("renders and filters logging environment rows on the main page", async () => {
    vi.mocked(api.listLoggingEnvironments).mockResolvedValue([
      environment,
      {
        ...environment,
        id: "env-2",
        name: "Staging",
        slug: "staging",
        schemaName: "Audit Events",
      },
    ]);
    useAuthStore.setState({
      user: makeUser({
        scopes: ["logs:environments:view", "logs:schemas:view"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });

    renderWithRouter(<Logging />, { path: "/logging/:section?", route: "/logging/environments" });

    expect(await screen.findByText("Production")).toBeInTheDocument();
    expect(screen.getByText("Staging")).toBeInTheDocument();
    expect(screen.queryByText("Business")).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search environments..."), {
      target: { value: "prod" },
    });

    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.queryByText("Staging")).not.toBeInTheDocument();
  });

  it("shows useful placeholders when creating a logging environment", () => {
    renderWithRouter(
      <LoggingEnvironmentDialog open environment={null} onOpenChange={vi.fn()} onSave={vi.fn()} />
    );

    expect(screen.getByPlaceholderText("Production")).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Application logs from production services")
    ).toBeInTheDocument();
  });

  it("renders and filters logging schema rows on the main page", async () => {
    vi.mocked(api.listLoggingSchemas).mockResolvedValue([
      schema,
      {
        ...schema,
        id: "schema-2",
        name: "Payments",
        slug: "payments",
        fieldSchema: [],
      },
    ]);
    useAuthStore.setState({
      user: makeUser({
        scopes: ["logs:schemas:view", "logs:schemas:create"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });

    renderWithRouter(<Logging />, { path: "/logging/:section?", route: "/logging/schemas" });

    expect(await screen.findByText("Audit Events")).toBeInTheDocument();
    expect(screen.getByText("Payments")).toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText("Search schemas..."), {
      target: { value: "audit" },
    });

    expect(screen.getByText("Audit Events")).toBeInTheDocument();
    expect(screen.queryByText("Payments")).not.toBeInTheDocument();
  });

  it("omits the no-op settings tab and labels new schema fields", async () => {
    useAuthStore.setState({
      user: makeUser({
        scopes: ["logs:environments:view", "logs:schemas:view", "logs:schemas:create"],
      }),
      isAuthenticated: true,
      isLoading: false,
    });

    renderWithRouter(<Logging />, { path: "/logging/:section?", route: "/logging/schemas" });

    await screen.findByText("Schemas");
    expect(screen.queryByRole("tab", { name: "Settings" })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Create Schema" })[0]!);
    expect(screen.getByPlaceholderText("Audit Events")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Optional description")).toBeInTheDocument();
  });

  it("lets a folder-only creator create an environment in the granted folder only", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    useAuthStore.setState({
      user: makeUser({ scopes: ["logs:environments:create:folder/folder-1"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    const folder = {
      id: "folder-1",
      name: "Team logs",
      parentId: null,
      sortOrder: 0,
      depth: 0,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      children: [],
    };
    useResourceFolderStore.setState({
      foldersByType: {
        ...useResourceFolderStore.getState().foldersByType,
        "logging-environment": [folder, { ...folder, id: "folder-2", name: "Other" }],
      },
      loadingByType: {
        ...useResourceFolderStore.getState().loadingByType,
        "logging-environment": false,
      },
      fetchFolders: vi.fn().mockResolvedValue(undefined),
    });

    renderWithRouter(
      <LoggingEnvironmentDialog open environment={null} onOpenChange={vi.fn()} onSave={onSave} />
    );

    // The only allowed folder is preselected and the root is not offered.
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Folder" })).toHaveTextContent("Team logs")
    );
    fireEvent.change(screen.getByPlaceholderText("Production"), { target: { value: "Team" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ folderId: "folder-1" }))
    );
  });

  it("shows the create button to a folder-only creator", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["logs:environments:create:folder/folder-1"] }),
      isAuthenticated: true,
      isLoading: false,
    });

    renderWithRouter(<Logging />, { path: "/logging/:section?", route: "/logging/environments" });

    expect(
      (await screen.findAllByRole("button", { name: "Create Environment" })).length
    ).toBeGreaterThan(0);
    expect(api.listLoggingEnvironments).toHaveBeenCalled();
  });
});
