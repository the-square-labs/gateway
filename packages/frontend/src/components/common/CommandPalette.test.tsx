import { act, fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FolderPlus, RefreshCw } from "lucide-react";
import { useLocation } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import { useAuthStore } from "@/stores/auth";
import { useCommandPalettePageActions } from "@/stores/command-palette-page-actions";
import { useDashboardBootstrapStore } from "@/stores/dashboard-bootstrap";
import { useResolvedPageContext } from "@/stores/resolved-page-context";
import { useUIStore } from "@/stores/ui";
import { renderWithRouter } from "@/test/render";
import { CommandPalette } from "./CommandPalette";

function LocationProbe() {
  return <output data-testid="location-path">{useLocation().pathname}</output>;
}

describe("CommandPalette", () => {
  beforeEach(() => {
    vi.spyOn(api, "listNodes").mockResolvedValue({ data: [] } as never);
    vi.spyOn(api, "listProxyHosts").mockResolvedValue({ data: [] } as never);
    vi.spyOn(api, "searchResources").mockResolvedValue({
      query: "",
      results: [],
      total: 0,
      truncated: false,
    });
    vi.spyOn(api, "listDockerContainerSnapshots").mockResolvedValue([]);
    useResolvedPageContext.setState({
      routeKey: null,
      status: "idle",
      resource: null,
    });
    useDashboardBootstrapStore.getState().clear();
    useCommandPalettePageActions.setState({ ownerToken: 0, registrations: {} });
    useUIStore.setState({ recentPages: [], commandActionUsage: {} });
  });

  it("shows adaptive quick actions first and keeps them page-specific", () => {
    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: ["proxy:create", "feat:ai:use"],
          isBlocked: false,
        } as never,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({ isEnabled: true });
      useUIStore.setState({
        recentPages: [{ path: "/nodes/node-a", label: "Node A" }],
      });
    });

    renderWithRouter(<CommandPalette open onOpenChange={vi.fn()} />, {
      route: "/proxy-hosts",
    });

    const quickHeading = screen.getByText("Quick actions");
    const recentHeading = screen.getByText("Recent");
    expect(
      quickHeading.compareDocumentPosition(recentHeading) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();

    const quickGroup = quickHeading.closest("[cmdk-group]");
    expect(quickGroup).not.toBeNull();
    expect(
      within(quickGroup as HTMLElement)
        .getAllByRole("option")
        .map((item) => item.textContent)
    ).toEqual([expect.stringContaining("New route")]);
  });

  it("promotes resource-specific actions into Quick actions", async () => {
    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: [
            "docker:containers:console:node-1",
            "docker:containers:view:node-1",
            "docker:containers:files:node-1",
          ],
          isBlocked: false,
        } as never,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({ isEnabled: false });
      useResolvedPageContext.setState({
        routeKey: "/docker/containers/node-1/api",
        status: "ready",
        resource: {
          resourceType: "docker-container",
          resourceId: "container-1",
          nodeId: "node-1",
          label: "api",
        },
      });
    });

    renderWithRouter(
      <>
        <CommandPalette open onOpenChange={vi.fn()} />
        <LocationProbe />
      </>,
      { route: "/docker/containers/node-1/api" }
    );

    const quickGroup = screen.getByText("Quick actions").closest("[cmdk-group]");
    expect(quickGroup).not.toBeNull();
    expect(
      within(quickGroup as HTMLElement)
        .getAllByRole("option")
        .map((item) => item.textContent)
    ).toEqual(["Open container console", "Open container logs", "Browse container files"]);
    expect(screen.queryByText("Current Page")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("option", { name: "Browse container files" }));
    expect(screen.getByTestId("location-path")).toHaveTextContent(
      "/docker/containers/node-1/api/files"
    );
  });

  it.each([
    {
      label: "node",
      route: "/nodes/node-a",
      scope: "nodes:files:read:node-1",
      action: "Browse node files",
      resource: {
        resourceType: "node" as const,
        resourceId: "node-1",
        label: "Node A",
      },
    },
    {
      label: "volume",
      route: "/docker/volumes/node-a/data",
      scope: "docker:volumes:files:read:node-1",
      action: "Browse volume files",
      resource: {
        resourceType: "docker-volume" as const,
        resourceId: "data",
        nodeId: "node-1",
        label: "data",
      },
    },
  ])("opens the $label files tab inside its resource page", async ({
    route,
    scope,
    action,
    resource,
  }) => {
    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: [scope],
          isBlocked: false,
        } as never,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({ isEnabled: false });
      useResolvedPageContext.setState({
        routeKey: route,
        status: "ready",
        resource,
      });
    });

    renderWithRouter(
      <>
        <CommandPalette open onOpenChange={vi.fn()} />
        <LocationProbe />
      </>,
      { route }
    );

    await userEvent.click(screen.getByRole("option", { name: action }));
    expect(screen.getByTestId("location-path")).toHaveTextContent(`${route}/files`);
  });

  it("promotes actions registered by the current list page", async () => {
    const refresh = vi.fn();
    const createFolder = vi.fn();
    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: [],
          isBlocked: false,
        } as never,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({ isEnabled: false });
      useCommandPalettePageActions.getState().register("/docker", [
        {
          id: "page:docker:refresh",
          label: "Refresh containers",
          icon: <RefreshCw />,
          action: refresh,
        },
        {
          id: "page:docker:new-folder",
          label: "New container folder",
          icon: <FolderPlus />,
          action: createFolder,
        },
      ]);
      const ui = useUIStore.getState();
      ui.recordCommandActionUsage("user-1", "docker", "page:docker:new-folder");
      ui.recordCommandActionUsage("user-1", "docker", "page:docker:new-folder");
    });

    renderWithRouter(<CommandPalette open onOpenChange={vi.fn()} />, {
      route: "/docker/containers",
    });

    const quickGroup = screen.getByText("Quick actions").closest("[cmdk-group]");
    expect(quickGroup).not.toBeNull();
    const options = within(quickGroup as HTMLElement).getAllByRole("option");
    expect(options.map((item) => item.textContent)).toEqual([
      "New container folder",
      "Refresh containers",
    ]);

    await userEvent.click(options[0]);
    expect(createFolder).toHaveBeenCalledOnce();
  });

  it("does not fill page actions with unrelated global actions", () => {
    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: ["proxy:create", "feat:ai:use"],
          isBlocked: false,
        } as never,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({ isEnabled: true });
      useCommandPalettePageActions.getState().register("/logging", [
        {
          id: "page:logging:new-environment",
          label: "New logging environment",
          icon: <FolderPlus />,
          action: vi.fn(),
        },
      ]);
    });

    renderWithRouter(<CommandPalette open onOpenChange={vi.fn()} />, {
      route: "/logging/environments",
    });

    const quickGroup = screen.getByText("Quick actions").closest("[cmdk-group]");
    expect(quickGroup).not.toBeNull();
    expect(within(quickGroup as HTMLElement).getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "New logging environment" })).toBeVisible();
    expect(screen.queryByRole("option", { name: /New route/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Open AI Workspace/ })).not.toBeInTheDocument();
  });

  it("disables Ask AI when Gateway Inference quota is exhausted", async () => {
    const exhaustedUsage = {
      enabled: true,
      api: { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
      subscription: {
        "5h": { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
        "7d": { configured: true, percentage: 99.6, recoveryAt: "2030-01-07T00:00:00.000Z" },
        "30d": {
          configured: false,
          percentage: 0,
          recoveryAt: "2030-01-30T00:00:00.000Z",
        },
      },
    };
    const sendMessage = vi.fn();

    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: ["feat:ai:use"],
          isBlocked: false,
        } as never,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({
        isEnabled: true,
        isConnected: true,
        isStreaming: false,
        providerStatus: {
          enabled: true,
          providerType: "gateway_inference",
          defaultModel: "k3",
          allowUserModelSelection: false,
          supportsImages: false,
          models: [],
        },
        sendMessage,
      });
      useDashboardBootstrapStore.setState({
        snapshot: { inferenceUsage: exhaustedUsage } as never,
      });
    });

    renderWithRouter(<CommandPalette open onOpenChange={vi.fn()} />);
    await userEvent.type(
      screen.getByPlaceholderText("Search or type > for commands..."),
      "start container"
    );

    const askAI = await screen.findByRole("option", { name: /Ask AI: "start container"/ });
    expect(askAI).toHaveAttribute("data-disabled", "true");
    expect(askAI).toHaveTextContent("Quota exhausted");

    await userEvent.click(askAI);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the search visible until the close animation finishes", async () => {
    renderWithRouter(<CommandPalette open onOpenChange={vi.fn()} />);
    const input = screen.getByPlaceholderText("Search or type > for commands...");
    await userEvent.type(input, "start container");

    const dialog = screen.getByRole("dialog");
    fireEvent.animationEnd(dialog);
    expect(input).toHaveValue("start container");

    dialog.setAttribute("data-state", "closed");
    fireEvent.animationEnd(dialog);
    expect(input).toHaveValue("");
  });

  it("keeps theme controls and logout in the default palette view", () => {
    renderWithRouter(<CommandPalette open onOpenChange={vi.fn()} />);

    expect(screen.getByRole("option", { name: /light/i })).toBeVisible();
    expect(screen.getByRole("option", { name: /dark/i })).toBeVisible();
    expect(screen.getByRole("option", { name: /system/i })).toBeVisible();
    expect(screen.getByRole("option", { name: "Log out" })).toBeVisible();
  });

  it("searches all readable resources through the shared backend search", async () => {
    vi.mocked(api.searchResources).mockResolvedValue({
      query: "postgres",
      results: [
        {
          type: "database",
          id: "database-1",
          name: "postgres-primary",
          summary: { slug: "postgres-primary" },
        },
      ],
      total: 1,
      truncated: false,
    });

    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: ["databases:view"],
          isBlocked: false,
        } as never,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({ isEnabled: false });
    });

    renderWithRouter(<CommandPalette open onOpenChange={vi.fn()} />);
    await userEvent.type(
      screen.getByPlaceholderText("Search or type > for commands..."),
      "postgres"
    );

    expect(await screen.findByRole("option", { name: /postgres-primary.*Database/ })).toBeVisible();
    expect(api.searchResources).toHaveBeenCalledWith("postgres", { limit: 20 });
  });

  it("finds deep settings and profile destinations without cluttering the default list", async () => {
    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: [],
          isBlocked: false,
        } as never,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({ isEnabled: false });
    });

    renderWithRouter(<CommandPalette open onOpenChange={vi.fn()} />);
    expect(
      screen.queryByRole("option", { name: "Profile authorizations" })
    ).not.toBeInTheDocument();

    await userEvent.type(
      screen.getByPlaceholderText("Search or type > for commands..."),
      "authorizations"
    );

    expect(await screen.findByRole("option", { name: "Profile authorizations" })).toBeVisible();
  });

  it.each([
    ["General settings", "settings:gateway:view", "/settings/general"],
    ["Advanced settings", "docker:registries:view", "/settings/advanced"],
  ])("routes %s to its dedicated tab", async (label, scope, path) => {
    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: [scope],
          isBlocked: false,
        } as never,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({ isEnabled: false });
    });

    renderWithRouter(
      <>
        <CommandPalette open onOpenChange={vi.fn()} />
        <LocationProbe />
      </>
    );
    await userEvent.type(screen.getByPlaceholderText("Search or type > for commands..."), label);
    await userEvent.click(await screen.findByRole("option", { name: label }));

    expect(screen.getByTestId("location-path")).toHaveTextContent(path);
  });

  it.each([
    "/docker/containers",
    "/logging",
  ])("keeps command mode global and limited to resource commands from %s", async (route) => {
    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: [
            "proxy:create",
            "docker:containers:view:node-1",
            "docker:containers:files:node-1",
          ],
          isBlocked: false,
        } as never,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({ isEnabled: false });
    });
    vi.mocked(api.listDockerContainerSnapshots).mockResolvedValue([
      {
        id: "container-1",
        name: "api",
        image: "gateway/api:latest",
        _nodeId: "node-1",
        _nodeSlug: "node-a",
      },
    ] as never);

    renderWithRouter(
      <>
        <CommandPalette open onOpenChange={vi.fn()} />
        <LocationProbe />
      </>,
      { route }
    );

    const input = screen.getByPlaceholderText("Search or type > for commands...");
    await userEvent.type(input, ">logs api");

    expect(await screen.findByRole("option", { name: /Logs api/ })).toBeVisible();
    expect(screen.queryByRole("option", { name: /New route/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Light theme/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Routes" })).not.toBeInTheDocument();
    expect(api.listDockerContainerSnapshots).toHaveBeenCalledWith();

    await userEvent.clear(input);
    await userEvent.type(input, ">files api");
    await userEvent.click(await screen.findByRole("option", { name: /Files api/ }));
    expect(screen.getByTestId("location-path")).toHaveTextContent(
      "/docker/containers/node-a/api/files"
    );
  });

  it("opens node files commands in the resource files tab", async () => {
    vi.mocked(api.listNodes).mockResolvedValue({
      data: [
        {
          id: "node-1",
          slug: "node-a",
          hostname: "node-a",
          displayName: "Node A",
          status: "online",
        },
      ],
    } as never);
    act(() => {
      useAuthStore.setState({
        user: {
          id: "user-1",
          email: "user@example.com",
          name: "User One",
          groupName: "admin",
          scopes: ["nodes:files:read:node-1"],
          isBlocked: false,
        } as never,
        isAuthenticated: true,
        isLoading: false,
      });
      useAIStore.setState({ isEnabled: false });
    });

    renderWithRouter(
      <>
        <CommandPalette open onOpenChange={vi.fn()} />
        <LocationProbe />
      </>,
      { route: "/logging" }
    );
    await userEvent.type(
      screen.getByPlaceholderText("Search or type > for commands..."),
      ">files node a"
    );

    await userEvent.click(await screen.findByRole("option", { name: /Files Node A/ }));
    expect(screen.getByTestId("location-path")).toHaveTextContent("/nodes/node-a/files");
  });
});
