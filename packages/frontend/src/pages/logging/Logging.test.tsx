import { fireEvent, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { vi } from "vitest";
import { Logging } from "@/pages/Logging";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { useSystemConfigStore } from "@/stores/system-config";
import { makeUser } from "@/test/fixtures";
import { renderWithRouter } from "@/test/render";
import type { LoggingEnvironment, LoggingSchema } from "@/types";
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
        gatewayPublicIps: [],
        gatewayGrpcPublicTarget: null,
        gatewayGrpcLocalIp: null,
        relayAutoRecovery: true,
        features: {
          pkiEnabled: true,
          domainsEnabled: true,
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

    fireEvent.change(screen.getByPlaceholderText("Search environments..."), {
      target: { value: "prod" },
    });

    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.queryByText("Staging")).not.toBeInTheDocument();
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
});
