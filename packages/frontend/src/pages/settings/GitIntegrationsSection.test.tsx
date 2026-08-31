import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import type { GitConnector } from "@/types/integrations";
import { GitIntegrationsSection } from "./GitIntegrationsSection";

const mocks = vi.hoisted(() => ({
  listGitConnectors: vi.fn(),
  getGitHubOAuthAvailability: vi.fn(),
  startGitHubOAuth: vi.fn(),
  cancelGitHubOAuth: vi.fn(),
  previewGitConnectorTest: vi.fn(),
  previewGitHubConnectorTest: vi.fn(),
  createGitConnector: vi.fn(),
  updateGitConnector: vi.fn(),
  testGitConnector: vi.fn(),
  syncGitConnector: vi.fn(),
  deleteGitConnector: vi.fn(),
  cache: new Map<string, unknown>(),
}));

vi.mock("@/services/api", () => ({
  api: {
    getCached: (key: string) => mocks.cache.get(key),
    setCache: (key: string, value: unknown) => mocks.cache.set(key, value),
    listGitConnectors: mocks.listGitConnectors,
    getGitHubOAuthAvailability: mocks.getGitHubOAuthAvailability,
    previewGitConnectorTest: mocks.previewGitConnectorTest,
    previewGitHubConnectorTest: mocks.previewGitHubConnectorTest,
    startGitHubOAuth: mocks.startGitHubOAuth,
    getGitHubOAuthStatus: vi.fn(),
    cancelGitHubOAuth: mocks.cancelGitHubOAuth,
    createGitConnector: mocks.createGitConnector,
    updateGitConnector: mocks.updateGitConnector,
    testGitConnector: mocks.testGitConnector,
    syncGitConnector: mocks.syncGitConnector,
    deleteGitConnector: mocks.deleteGitConnector,
  },
}));

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(),
}));

const githubConnector: GitConnector = {
  id: "github-1",
  provider: "github",
  name: "Production GitHub",
  baseUrl: "https://github.com",
  enabled: true,
  authMode: "oauth",
  username: "octocat",
  allowlistMode: "all_visible",
  capabilities: { projectsView: true, repoRead: true },
  syncStatus: "never",
  testedAt: "2026-08-14T10:00:00.000Z",
  syncFinishedAt: null,
  hasToken: true,
  tokenMasked: "****1234",
  allowlistEntries: [],
};

describe("GitIntegrationsSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cache.clear();
    mocks.listGitConnectors.mockImplementation((provider: string) =>
      Promise.resolve(provider === "github" ? [] : [])
    );
    mocks.getGitHubOAuthAvailability.mockResolvedValue({ available: true });
    mocks.startGitHubOAuth.mockResolvedValue({
      id: "oauth-1",
      status: "pending",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      pollIntervalSeconds: 60,
      expiresAt: "2026-08-31T12:00:00.000Z",
      connectorId: null,
      errorMessage: null,
    });
    mocks.cancelGitHubOAuth.mockResolvedValue({ status: "cancelled" });
    mocks.previewGitConnectorTest.mockResolvedValue({
      success: true,
      baseUrl: "https://git.example.com",
      capabilities: { projectsView: true, repoRead: true, repoWrite: true },
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
        scopes: ["integrations:github:manage", "integrations:git:manage"],
        isBlocked: false,
      },
      isAuthenticated: true,
      isLoading: false,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("chooses GitHub authentication before opening the shared connector form", async () => {
    const user = userEvent.setup();
    render(<GitIntegrationsSection />);

    await waitFor(() => expect(mocks.getGitHubOAuthAvailability).toHaveBeenCalled());
    await user.click(screen.getAllByRole("button", { name: "Add Connector" })[0]);

    expect(screen.getByRole("heading", { name: "Add GitHub Connector" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /OAuth/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Personal access token/ })).toBeEnabled();
    expect(screen.queryByText("Connector name")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /OAuth/ }));

    expect(screen.getByRole("heading", { name: "Connect GitHub with OAuth" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start GitHub authorization" })).toBeInTheDocument();
    expect(screen.queryByText("Repository access")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Repository URL")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start GitHub authorization" })).toBeEnabled();
  });

  it("keeps GitHub token access account-wide and exposes Test Connection", async () => {
    const user = userEvent.setup();
    render(<GitIntegrationsSection />);

    await waitFor(() => expect(mocks.getGitHubOAuthAvailability).toHaveBeenCalled());
    await user.click(screen.getAllByRole("button", { name: "Add Connector" })[0]);
    await user.click(screen.getByRole("button", { name: /Personal access token/ }));

    expect(screen.getByText("GitHub personal access token")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test Connection" })).toBeDisabled();
    expect(screen.queryByText("Repository access")).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText("Repository URL")).not.toBeInTheDocument();
  });

  it("opens the GitHub method dialog only after the connector form finishes closing", async () => {
    const user = userEvent.setup();
    render(<GitIntegrationsSection />);

    await waitFor(() => expect(mocks.getGitHubOAuthAvailability).toHaveBeenCalled());
    await user.click(screen.getAllByRole("button", { name: "Add Connector" })[0]);
    await user.click(screen.getByRole("button", { name: /Personal access token/ }));
    vi.useFakeTimers();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));

    expect(screen.queryByRole("heading", { name: "Add GitHub Connector" })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(249));
    expect(screen.queryByRole("heading", { name: "Add GitHub Connector" })).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));

    expect(screen.getByRole("heading", { name: "Add GitHub Connector" })).toBeInTheDocument();
    vi.useRealTimers();
  });

  it("uses the shared shell and preview test for generic Git", async () => {
    const user = userEvent.setup();
    render(<GitIntegrationsSection />);

    await waitFor(() => expect(mocks.listGitConnectors).toHaveBeenCalledTimes(2));
    await user.click(screen.getAllByRole("button", { name: "Add Connector" })[1]);

    expect(screen.getByText("Git repository access")).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "One repository" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add repository url" })).toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText("https://git.example.com"),
      "https://git.example.com"
    );
    await user.type(screen.getByLabelText("Repository URL 1"), "https://git.example.com/team/app");
    await user.click(screen.getByRole("button", { name: "Add repository url" }));
    await user.type(screen.getByLabelText("Repository URL 2"), "https://git.example.com/team/web");
    await user.type(screen.getByPlaceholderText("Git username"), "deploy");
    await user.type(screen.getByPlaceholderText("Access token"), "secret");
    await user.click(screen.getByRole("button", { name: "Test Connection" }));

    await waitFor(() =>
      expect(mocks.previewGitConnectorTest).toHaveBeenCalledWith({
        baseUrl: "https://git.example.com",
        repositoryUrl: "https://git.example.com/team/app",
        username: "deploy",
        token: "secret",
      })
    );
  });

  it("renders configured connectors with GitLab-style status, capabilities, and actions", async () => {
    mocks.listGitConnectors.mockImplementation((provider: string) =>
      Promise.resolve(provider === "github" ? [githubConnector] : [])
    );
    render(<GitIntegrationsSection />);

    const row = await screen.findByText("Production GitHub");
    const panel = row.closest("div.flex.flex-col") ?? row.parentElement;
    expect(panel).not.toBeNull();
    const scope = within(panel as HTMLElement);
    expect(scope.getByText("enabled")).toBeInTheDocument();
    expect(scope.getByText("success")).toBeInTheDocument();
    expect(scope.getByText("Repo read")).toBeInTheDocument();
    expect(scope.getByTitle("Test connector")).toBeInTheDocument();
    expect(scope.getByTitle("Sync connector")).toBeInTheDocument();
    expect(scope.getByTitle("Delete connector")).toBeInTheDocument();
  });

  it("manually synchronizes a configured connector", async () => {
    const user = userEvent.setup();
    mocks.listGitConnectors.mockImplementation((provider: string) =>
      Promise.resolve(provider === "github" ? [githubConnector] : [])
    );
    mocks.syncGitConnector.mockResolvedValue({ ...githubConnector, syncStatus: "success" });
    render(<GitIntegrationsSection />);

    await user.click(await screen.findByTitle("Sync connector"));

    await waitFor(() => expect(mocks.syncGitConnector).toHaveBeenCalledWith("github", "github-1"));
  });

  it("reauthorizes an existing OAuth connector in place", async () => {
    const user = userEvent.setup();
    mocks.listGitConnectors.mockImplementation((provider: string) =>
      Promise.resolve(provider === "github" ? [githubConnector] : [])
    );
    render(<GitIntegrationsSection />);

    await user.click(await screen.findByText("Production GitHub"));
    expect(screen.queryByText("Authorization code")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reauthorize" }));
    expect(screen.getByRole("heading", { name: "Authorize GitHub" })).toBeInTheDocument();
    expect(screen.queryByLabelText("GitHub authentication method")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start GitHub authorization" }));

    await waitFor(() =>
      expect(mocks.startGitHubOAuth).toHaveBeenCalledWith({
        connectorId: "github-1",
        name: "Production GitHub",
        enabled: true,
      })
    );
  });

  it("switches an existing OAuth connector to a personal access token", async () => {
    const user = userEvent.setup();
    mocks.listGitConnectors.mockImplementation((provider: string) =>
      Promise.resolve(provider === "github" ? [githubConnector] : [])
    );
    mocks.updateGitConnector.mockResolvedValue({ ...githubConnector, authMode: "token" });
    render(<GitIntegrationsSection />);

    await user.click(await screen.findByText("Production GitHub"));
    await user.click(screen.getByLabelText("GitHub authentication method"));
    await user.click(screen.getByRole("option", { name: "Personal access token" }));
    await user.type(screen.getByPlaceholderText("****1234"), "replacement-token");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(mocks.updateGitConnector).toHaveBeenCalledWith(
        "github",
        "github-1",
        expect.objectContaining({ authMode: "token", token: "replacement-token" })
      )
    );
  });

  it("switches an existing token connector to OAuth through the separate authorization step", async () => {
    const user = userEvent.setup();
    const tokenConnector = { ...githubConnector, authMode: "token" as const };
    mocks.listGitConnectors.mockImplementation((provider: string) =>
      Promise.resolve(provider === "github" ? [tokenConnector] : [])
    );
    render(<GitIntegrationsSection />);

    await user.click(await screen.findByText("Production GitHub"));
    await user.click(screen.getByLabelText("GitHub authentication method"));
    await user.click(screen.getByRole("option", { name: "OAuth" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(screen.getByRole("heading", { name: "Authorize GitHub" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start GitHub authorization" }));
    await waitFor(() =>
      expect(mocks.startGitHubOAuth).toHaveBeenCalledWith({
        connectorId: "github-1",
        name: "Production GitHub",
        enabled: true,
      })
    );
  });

  it("does not load connector families the user cannot view", async () => {
    useAuthStore.setState((state) => ({
      user: state.user ? { ...state.user, scopes: [] } : null,
    }));

    render(<GitIntegrationsSection />);

    await waitFor(() => {
      expect(mocks.listGitConnectors).not.toHaveBeenCalled();
      expect(mocks.getGitHubOAuthAvailability).not.toHaveBeenCalled();
    });
    expect(screen.queryByText("GitHub Integrations")).not.toBeInTheDocument();
    expect(screen.queryByText("Git Integrations")).not.toBeInTheDocument();
  });
});
