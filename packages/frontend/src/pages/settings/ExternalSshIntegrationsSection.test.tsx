import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import type { ExternalSshConnector } from "@/types/integrations";
import { ExternalSshIntegrationsSection } from "./ExternalSshIntegrationsSection";

const mocks = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  listExternalSshConnectors: vi.fn(),
  testExternalSshConnector: vi.fn(),
  syncExternalSshConnector: vi.fn(),
  updateExternalSshConnector: vi.fn(),
  deleteExternalSshConnector: vi.fn(),
}));

vi.mock("@/services/api", () => ({
  api: {
    getCached: (key: string) => mocks.cache.get(key),
    setCache: (key: string, value: unknown) => mocks.cache.set(key, value),
    listExternalSshConnectors: mocks.listExternalSshConnectors,
    testExternalSshConnector: mocks.testExternalSshConnector,
    syncExternalSshConnector: mocks.syncExternalSshConnector,
    updateExternalSshConnector: mocks.updateExternalSshConnector,
    deleteExternalSshConnector: mocks.deleteExternalSshConnector,
  },
}));

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));
vi.mock("./ExternalSshConnectorDialog", () => ({
  ExternalSshConnectorDialog: () => null,
}));

const connectors: ExternalSshConnector[] = [
  {
    id: "jump-1",
    name: "Jump host",
    host: "jump.example.com",
    port: 22,
    username: "deploy",
    authMethod: "password",
    hostFingerprint: "SHA256:jump",
    jumpConnectorId: null,
    enabled: true,
    testStatus: "success",
    testLastError: null,
    testedAt: "2026-08-14T10:00:00.000Z",
  },
  {
    id: "target-1",
    name: "Production target",
    host: "target.example.com",
    port: 2222,
    username: "root",
    authMethod: "private_key",
    hostFingerprint: "SHA256:target",
    jumpConnectorId: "jump-1",
    enabled: true,
    testStatus: "error",
    testLastError: "Connection timed out",
    testedAt: "2026-08-14T10:00:00.000Z",
  },
];

describe("ExternalSshIntegrationsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cache.clear();
    mocks.listExternalSshConnectors.mockResolvedValue(connectors);
    mocks.testExternalSshConnector.mockResolvedValue({ success: true });
    mocks.syncExternalSshConnector.mockResolvedValue({ success: true });
    mocks.updateExternalSshConnector.mockResolvedValue(connectors[0]);
    useAuthStore.setState({
      user: {
        id: "user-1",
        oidcSubject: "user-1",
        email: "admin@example.com",
        name: "Admin",
        avatarUrl: null,
        groupId: "group-1",
        groupName: "admin",
        scopes: ["integrations:ssh:manage"],
        isBlocked: false,
      },
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it("renders standard connector metadata, badges, jump route, and actions", async () => {
    render(<ExternalSshIntegrationsSection />);

    expect(await screen.findByText("Production target")).toBeInTheDocument();
    expect(screen.getAllByText("enabled")).toHaveLength(2);
    expect(screen.getByText("generated key")).toBeInTheDocument();
    expect(screen.getByText("root@target.example.com:2222 · via Jump host")).toBeInTheDocument();
    expect(screen.getAllByTitle("Test connector")).toHaveLength(2);
    expect(screen.getAllByTitle("Sync connector")).toHaveLength(2);
    expect(screen.getAllByTitle("Delete connector")).toHaveLength(2);
  });

  it("tests a configured connector from its row", async () => {
    const user = userEvent.setup();
    render(<ExternalSshIntegrationsSection />);

    await screen.findByText("Jump host");
    await user.click(screen.getAllByTitle("Test connector")[0]);

    await waitFor(() => expect(mocks.testExternalSshConnector).toHaveBeenCalledWith("jump-1"));
  });

  it("synchronizes a configured connector from its row", async () => {
    const user = userEvent.setup();
    render(<ExternalSshIntegrationsSection />);

    await screen.findByText("Jump host");
    await user.click(screen.getAllByTitle("Sync connector")[0]);

    await waitFor(() => expect(mocks.syncExternalSshConnector).toHaveBeenCalledWith("jump-1"));
  });

  it("edits only the connector display name", async () => {
    const user = userEvent.setup();
    render(<ExternalSshIntegrationsSection />);

    await user.click(await screen.findByText("Jump host"));
    const nameInput = screen.getByDisplayValue("Jump host");
    await user.clear(nameInput);
    await user.type(nameInput, "Primary jump");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.updateExternalSshConnector).toHaveBeenCalledWith("jump-1", "Primary jump")
    );
  });
});
