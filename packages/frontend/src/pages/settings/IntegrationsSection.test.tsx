import { waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import { renderWithRouter as render } from "@/test/render";
import { IntegrationsSection } from "./IntegrationsSection";

const mocks = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  listGitLabConnectors: vi.fn(),
  listHostingConnectors: vi.fn(async () => []),
}));

vi.mock("@/services/api", () => ({
  api: {
    getCached: (key: string) => mocks.cache.get(key),
    setCache: (key: string, value: unknown) => mocks.cache.set(key, value),
    listGitLabConnectors: mocks.listGitLabConnectors,
    listHostingConnectors: mocks.listHostingConnectors,
  },
}));

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));
vi.mock("./CloudflareIntegrationsSection", () => ({ CloudflareIntegrationsSection: () => null }));
vi.mock("./GitIntegrationsSection", () => ({ GitIntegrationsSection: () => null }));
vi.mock("./ExternalSshIntegrationsSection", () => ({ ExternalSshIntegrationsSection: () => null }));

function setScopes(scopes: string[]) {
  useAuthStore.setState({
    user: {
      id: "user-1",
      oidcSubject: "user-1",
      email: "user@example.com",
      name: "User",
      avatarUrl: null,
      groupId: "group-1",
      groupName: "custom",
      scopes,
      isBlocked: false,
    },
    isAuthenticated: true,
    isLoading: false,
  });
}

describe("IntegrationsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cache.clear();
    mocks.listGitLabConnectors.mockResolvedValue([]);
  });

  it("does not load GitLab connectors for another integration family's viewer", async () => {
    setScopes(["integrations:cloudflare:view"]);

    render(<IntegrationsSection />);

    await waitFor(() => expect(mocks.listGitLabConnectors).not.toHaveBeenCalled());
  });

  it("loads GitLab connectors for a GitLab viewer", async () => {
    setScopes(["integrations:gitlab:view"]);

    render(<IntegrationsSection />);

    await waitFor(() => expect(mocks.listGitLabConnectors).toHaveBeenCalledOnce());
  });
  it("loads only hosting accounts for a hosting-only viewer", async () => {
    setScopes(["integrations:hosting:view"]);
    render(<IntegrationsSection />);
    await waitFor(() => expect(mocks.listHostingConnectors).toHaveBeenCalledOnce());
    expect(mocks.listGitLabConnectors).not.toHaveBeenCalled();
  });
});
