import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import type { CloudflareConnector } from "@/types/integrations";
import { CloudflareIntegrationsSection } from "./CloudflareIntegrationsSection";

const mocks = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  listCloudflareConnectors: vi.fn(),
  getCloudflareConnector: vi.fn(),
  rotateCloudflareConnectorToken: vi.fn(),
  updateCloudflareConnector: vi.fn(),
}));

vi.mock("@/services/api", () => ({
  api: {
    getCached: (key: string) => mocks.cache.get(key),
    setCache: (key: string, value: unknown) => mocks.cache.set(key, value),
    listCloudflareConnectors: mocks.listCloudflareConnectors,
    getCloudflareConnector: mocks.getCloudflareConnector,
    rotateCloudflareConnectorToken: mocks.rotateCloudflareConnectorToken,
    updateCloudflareConnector: mocks.updateCloudflareConnector,
  },
}));

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

const connector: CloudflareConnector = {
  id: "cloudflare-1",
  provider: "cloudflare",
  name: "Production Cloudflare",
  baseUrl: "https://api.cloudflare.com",
  enabled: true,
  settings: {
    autoSyncEnabled: true,
    autoSyncIntervalSeconds: 900,
    defaultTtl: 1,
    defaultProxied: true,
  },
  capabilities: { apiReachable: true, tokenActive: false },
  syncStatus: "error",
  syncLastError: "Invalid API Token",
  syncFailureCount: 1,
  createdAt: "2026-08-16T10:00:00.000Z",
  updatedAt: "2026-08-16T10:00:00.000Z",
  hasToken: true,
  tokenMasked: "****old1",
  zones: [],
};

describe("CloudflareIntegrationsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cache.clear();
    mocks.cache.set("settings:cloudflare-connectors", [connector]);
    mocks.listCloudflareConnectors.mockResolvedValue([connector]);
    mocks.getCloudflareConnector.mockResolvedValue(connector);
    mocks.rotateCloudflareConnectorToken.mockResolvedValue({
      ...connector,
      tokenMasked: "****new1",
    });
    mocks.updateCloudflareConnector.mockResolvedValue({
      ...connector,
      tokenMasked: "****new1",
      syncLastError: null,
    });
    useAuthStore.setState({
      user: {
        id: "user-1",
        oidcSubject: "user-1",
        email: "admin@example.com",
        name: "Admin",
        avatarUrl: null,
        groupId: "group-1",
        groupName: "admin",
        scopes: ["integrations:cloudflare:manage"],
        isBlocked: false,
      },
      isAuthenticated: true,
      isLoading: false,
    });
  });

  it("rotates a replacement token without revalidating unchanged connector settings", async () => {
    const user = userEvent.setup();
    render(<CloudflareIntegrationsSection />);

    await user.click(await screen.findByText("Production Cloudflare"));
    const tokenInput = await screen.findByPlaceholderText("****old1");
    await user.type(tokenInput, "replacement-token");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.rotateCloudflareConnectorToken).toHaveBeenCalledWith(
        "cloudflare-1",
        "replacement-token"
      )
    );
    expect(mocks.updateCloudflareConnector).not.toHaveBeenCalled();
  });

  it("rotates a replacement token before validating changed connector settings", async () => {
    const user = userEvent.setup();
    render(<CloudflareIntegrationsSection />);

    await user.click(await screen.findByText("Production Cloudflare"));
    const nameInput = await screen.findByDisplayValue("Production Cloudflare");
    await user.clear(nameInput);
    await user.type(nameInput, "Renamed Cloudflare");
    await user.type(screen.getByPlaceholderText("****old1"), "replacement-token");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.rotateCloudflareConnectorToken).toHaveBeenCalledWith(
        "cloudflare-1",
        "replacement-token"
      )
    );
    expect(mocks.updateCloudflareConnector).toHaveBeenCalledWith(
      "cloudflare-1",
      expect.objectContaining({ name: "Renamed Cloudflare", enabled: true })
    );
    expect(mocks.rotateCloudflareConnectorToken.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.updateCloudflareConnector.mock.invocationCallOrder[0]
    );
  });
});
