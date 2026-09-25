import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, vi } from "vitest";
import { OAuthConsent } from "@/pages/OAuthConsent";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { renderWithRouter } from "@/test/render";
import { waitForReveal } from "@/test/reveal";
import type { OAuthConsentPreview } from "@/types";

const preview: OAuthConsentPreview = {
  requestId: "request-1",
  client: {
    id: "goc_client",
    name: "Local CLI",
    uri: null,
    logoUri: null,
  },
  account: {
    id: "user-1",
    email: "admin@example.com",
    name: "Admin User",
    avatarUrl: null,
  },
  requestedScopes: ["nodes:details", "docker:containers:view", "admin:users"],
  grantableScopes: ["nodes:details", "docker:containers:view"],
  unavailableScopes: ["admin:users"],
  manualApprovalScopes: [],
  redirect: {
    uri: "http://127.0.0.1:8765/callback",
    isExternal: false,
  },
  resource: "https://gateway.example.com/api",
  resourceInfo: {
    resource: "https://gateway.example.com/api",
    name: "Gateway API",
    description: "REST API access for CLI and external applications.",
  },
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
};

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  useAuthStore.setState({ user: { scopes: preview.grantableScopes } as never });
  vi.spyOn(api, "listCAs").mockResolvedValue([]);
  vi.spyOn(api, "listNodes").mockResolvedValue({ data: [] } as never);
  vi.spyOn(api, "listProxyHosts").mockResolvedValue({ data: [] } as never);
  vi.spyOn(api, "listDatabases").mockResolvedValue({ data: [] } as never);
  vi.spyOn(api, "listLoggingSchemas").mockResolvedValue([]);
  vi.spyOn(window, "open").mockReturnValue({
    location: { replace: vi.fn() },
    close: vi.fn(),
  } as unknown as Window);
});

describe("OAuthConsent", () => {
  it("shows client, selected account, grantable scopes, and warning without unavailable scopes", async () => {
    vi.spyOn(api, "getOAuthConsent").mockResolvedValue(preview);

    renderWithRouter(<OAuthConsent />, {
      path: "/oauth/consent",
      route: "/oauth/consent?request=request-1",
    });

    expect(await screen.findByText("Authorize Gateway API access")).toBeInTheDocument();
    expect(screen.getByText("Local CLI")).toHaveClass("text-foreground");
    expect(screen.getByText("Gateway API", { selector: ".text-foreground" })).toBeInTheDocument();
    expect(screen.queryByText("Access target")).not.toBeInTheDocument();
    expect(screen.queryByText(/REST API access for CLI/)).not.toBeInTheDocument();
    expect(screen.getByText("Admin User")).toBeInTheDocument();
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
    expect(screen.getByText("Unverified client")).toBeInTheDocument();
    expect(screen.getByText(/Only authorize tools you trust/)).toBeInTheDocument();
    expect(screen.getByText("View Nodes")).toBeInTheDocument();
    expect(screen.getByText("View Containers")).toBeInTheDocument();
    expect(screen.queryByText("Manage Users")).not.toBeInTheDocument();
    expect(screen.queryByText("Unavailable scopes")).not.toBeInTheDocument();
  });

  it("keeps the consent card behind the loader until its resource pickers load", async () => {
    vi.spyOn(api, "getOAuthConsent").mockResolvedValue(preview);
    let resolveNodes!: (value: { data: [] }) => void;
    vi.mocked(api.listNodes).mockReturnValue(
      new Promise((resolve) => {
        resolveNodes = resolve;
      }) as never
    );

    renderWithRouter(<OAuthConsent />, {
      path: "/oauth/consent",
      route: "/oauth/consent?request=request-1",
    });

    await screen.findByText("Authorize Gateway API access");
    expect(screen.getByRole("status", { name: "Loading authorization request..." })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Authorize/i })).not.toBeInTheDocument();

    resolveNodes({ data: [] });
    await waitForReveal();
    expect(screen.getByRole("button", { name: /Authorize/i })).toBeVisible();
    expect(
      screen.queryByRole("status", { name: "Loading authorization request..." })
    ).not.toBeInTheDocument();
  });

  it("renders the inference setup scope once with useful metadata and a content-sized scope section", async () => {
    vi.spyOn(api, "getOAuthConsent").mockResolvedValue({
      ...preview,
      requestedScopes: ["inference:setup"],
      grantableScopes: ["inference:setup"],
      unavailableScopes: [],
      resource: "https://gateway.example.com/api/inference/setup",
      resourceInfo: {
        resource: "https://gateway.example.com/api/inference/setup",
        name: "Gateway Inference Setup",
        description: "Configure Gateway inference clients and their dedicated runtime tokens.",
      },
    });

    renderWithRouter(<OAuthConsent />, {
      path: "/oauth/consent",
      route: "/oauth/consent?request=request-1",
    });

    expect(await screen.findByText("Set up inference clients")).toBeInTheDocument();
    expect(screen.getAllByText("inference:setup")).toHaveLength(1);
    expect(
      screen.getByText(
        "Configure supported inference clients and manage their dedicated runtime tokens."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("Requested scopes").closest("section")).not.toHaveClass(
      "min-h-[12rem]",
      "flex-1"
    );
  });

  it("scrolls the page viewport instead of the authorization card body", async () => {
    vi.spyOn(api, "getOAuthConsent").mockResolvedValue(preview);

    renderWithRouter(<OAuthConsent />, {
      path: "/oauth/consent",
      route: "/oauth/consent?request=request-1",
    });

    await screen.findByText("Authorize Gateway API access");
    await waitForReveal();
    const viewport = document.querySelector("[data-oauth-consent-scroll-viewport]");
    const card = document.querySelector("[data-oauth-consent-card]");
    const body = document.querySelector("[data-oauth-consent-body]");

    expect(viewport).toHaveClass("h-[100dvh]", "overflow-y-auto");
    expect(card?.className).not.toMatch(/max-h-|overflow-y-/);
    expect(body?.className).not.toMatch(/max-h-|overflow-y-/);
  });

  it("submits only selected grantable scopes", async () => {
    vi.spyOn(api, "getOAuthConsent").mockResolvedValue(preview);
    const approve = vi
      .spyOn(api, "approveOAuthConsent")
      .mockRejectedValue(new Error("stop before navigation"));

    renderWithRouter(<OAuthConsent />, {
      path: "/oauth/consent",
      route: "/oauth/consent?request=request-1",
    });

    const nodes = await screen.findByLabelText(/View Nodes/i);
    await waitForReveal();
    await userEvent.click(nodes);
    await userEvent.click(screen.getByRole("button", { name: /Authorize/i }));

    expect(approve).toHaveBeenCalledWith("request-1", ["docker:containers:view"]);
    expect(await screen.findByText("stop before navigation")).toBeInTheDocument();
  });

  it("shows a red warning when the OAuth callback goes to an external origin", async () => {
    vi.spyOn(api, "getOAuthConsent").mockResolvedValue({
      ...preview,
      redirect: {
        uri: "https://client.example.com/callback",
        isExternal: true,
      },
    });

    renderWithRouter(<OAuthConsent />, {
      path: "/oauth/consent",
      route: "/oauth/consent?request=request-1",
    });

    expect(await screen.findByText(/External OAuth callback/i)).toBeInTheDocument();
    expect(screen.getByText(/authorization result will be sent to/i)).toHaveTextContent(
      "client.example.com"
    );
  });

  it("delivers a loopback callback without opening a popup and shows a result screen", async () => {
    vi.spyOn(api, "getOAuthConsent").mockResolvedValue(preview);
    vi.spyOn(api, "approveOAuthConsent").mockResolvedValue({
      redirectUrl: "http://127.0.0.1:8765/callback?code=abc",
    });

    renderWithRouter(<OAuthConsent />, {
      path: "/oauth/consent",
      route: "/oauth/consent?request=request-1",
    });

    await screen.findByText("Authorize Gateway API access");
    await waitForReveal();
    await userEvent.click(screen.getByRole("button", { name: /Authorize/i }));

    expect(await screen.findByText("Authorization complete")).toBeInTheDocument();
    expect(screen.getByText(/If the application did not finish signing in/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open callback/i })).toHaveAttribute(
      "href",
      "http://127.0.0.1:8765/callback?code=abc"
    );
    expect(screen.getByTitle("OAuth callback delivery")).toHaveAttribute(
      "src",
      "http://127.0.0.1:8765/callback?code=abc"
    );
    expect(screen.getByTitle("OAuth callback delivery")).toHaveAttribute("sandbox", "");
    expect(window.open).not.toHaveBeenCalled();
  });

  it("delivers a denied loopback callback without opening a popup", async () => {
    vi.spyOn(api, "getOAuthConsent").mockResolvedValue(preview);
    vi.spyOn(api, "denyOAuthConsent").mockResolvedValue({
      redirectUrl: "http://127.0.0.1:8765/callback?error=access_denied",
    });

    renderWithRouter(<OAuthConsent />, {
      path: "/oauth/consent",
      route: "/oauth/consent?request=request-1",
    });

    await screen.findByText("Authorize Gateway API access");
    await waitForReveal();
    await userEvent.click(screen.getByRole("button", { name: /Deny/i }));

    expect(await screen.findByText("Authorization denied")).toBeInTheDocument();
    expect(screen.getByTitle("OAuth callback delivery")).toHaveAttribute(
      "src",
      "http://127.0.0.1:8765/callback?error=access_denied"
    );
    expect(window.open).not.toHaveBeenCalled();
  });

  it("delivers an IPv6 loopback callback through the completion page", async () => {
    vi.spyOn(api, "getOAuthConsent").mockResolvedValue({
      ...preview,
      redirect: { uri: "http://[::1]:8765/callback", isExternal: false },
    });
    vi.spyOn(api, "approveOAuthConsent").mockResolvedValue({
      redirectUrl: "http://[::1]:8765/callback?code=abc",
    });

    renderWithRouter(<OAuthConsent />, {
      path: "/oauth/consent",
      route: "/oauth/consent?request=request-1",
    });

    await screen.findByText("Authorize Gateway API access");
    await waitForReveal();
    await userEvent.click(screen.getByRole("button", { name: /Authorize/i }));

    expect(await screen.findByText("Authorization complete")).toBeInTheDocument();
    expect(screen.getByTitle("OAuth callback delivery")).toHaveAttribute(
      "src",
      "http://[::1]:8765/callback?code=abc"
    );
    expect(window.open).not.toHaveBeenCalled();
  });

  it("rejects a non-loopback callback returned for a loopback consent request", async () => {
    vi.spyOn(api, "getOAuthConsent").mockResolvedValue(preview);
    vi.spyOn(api, "approveOAuthConsent").mockResolvedValue({
      redirectUrl: "http://client.example.com/callback?code=abc",
    });

    renderWithRouter(<OAuthConsent />, {
      path: "/oauth/consent",
      route: "/oauth/consent?request=request-1",
    });

    await screen.findByText("Authorize Gateway API access");
    await waitForReveal();
    await userEvent.click(screen.getByRole("button", { name: /Authorize/i }));

    expect(
      await screen.findByText("Gateway returned an invalid loopback OAuth callback")
    ).toBeInTheDocument();
    expect(screen.queryByTitle("OAuth callback delivery")).not.toBeInTheDocument();
    expect(window.open).not.toHaveBeenCalled();
  });

  it("uses top-level navigation for external callback approvals", async () => {
    vi.spyOn(api, "getOAuthConsent").mockResolvedValue({
      ...preview,
      redirect: {
        uri: "https://client.example.com/callback",
        isExternal: true,
      },
    });
    vi.spyOn(api, "approveOAuthConsent").mockResolvedValue({
      redirectUrl: "https://client.example.com/callback?code=abc",
    });
    const hrefSetter = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, href: "" },
    });
    Object.defineProperty(window.location, "href", {
      configurable: true,
      set: hrefSetter,
      get: () => "",
    });

    try {
      renderWithRouter(<OAuthConsent />, {
        path: "/oauth/consent",
        route: "/oauth/consent?request=request-1",
      });

      await screen.findByText("Authorize Gateway API access");
      await waitForReveal();
      await waitForReveal();
      await userEvent.click(screen.getByRole("button", { name: /Authorize/i }));

      expect(hrefSetter).toHaveBeenCalledWith("https://client.example.com/callback?code=abc");
      expect(window.open).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("uses top-level navigation for external callback denials", async () => {
    vi.spyOn(api, "getOAuthConsent").mockResolvedValue({
      ...preview,
      redirect: {
        uri: "https://client.example.com/callback",
        isExternal: true,
      },
    });
    vi.spyOn(api, "denyOAuthConsent").mockResolvedValue({
      redirectUrl: "https://client.example.com/callback?error=access_denied",
    });
    const hrefSetter = vi.fn();
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, href: "" },
    });
    Object.defineProperty(window.location, "href", {
      configurable: true,
      set: hrefSetter,
      get: () => "",
    });

    try {
      renderWithRouter(<OAuthConsent />, {
        path: "/oauth/consent",
        route: "/oauth/consent?request=request-1",
      });

      await screen.findByText("Authorize Gateway API access");
      await waitForReveal();
      await waitForReveal();
      await userEvent.click(screen.getByRole("button", { name: /Deny/i }));

      expect(hrefSetter).toHaveBeenCalledWith(
        "https://client.example.com/callback?error=access_denied"
      );
      expect(window.open).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("preserves resource-scoped scope values when authorizing", async () => {
    vi.mocked(api.listNodes).mockResolvedValue({
      data: [{ id: "node-1", type: "docker", hostname: "docker-1", displayName: "Docker 1" }],
    } as never);
    vi.spyOn(api, "getOAuthConsent").mockResolvedValue({
      ...preview,
      requestedScopes: ["docker:containers:view:node-1"],
      grantableScopes: ["docker:containers:view:node-1"],
      unavailableScopes: [],
    });
    const approve = vi
      .spyOn(api, "approveOAuthConsent")
      .mockRejectedValue(new Error("stop before navigation"));

    renderWithRouter(<OAuthConsent />, {
      path: "/oauth/consent",
      route: "/oauth/consent?request=request-1",
    });

    expect(await screen.findByText("View Containers")).toBeInTheDocument();
    // Restrictions stay collapsed behind a summary until opened.
    expect(await screen.findByText("Docker 1")).toBeInTheDocument();
    await waitForReveal();
    await userEvent.click(screen.getByRole("button", { name: /Restrict View Containers/i }));
    expect(screen.getByRole("checkbox", { name: /Docker 1/i })).toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: /Authorize/i }));

    expect(approve).toHaveBeenCalledWith("request-1", ["docker:containers:view:node-1"]);
  });

  it("leaves manual approval scopes unchecked until explicitly selected", async () => {
    vi.spyOn(api, "getOAuthConsent").mockResolvedValue({
      ...preview,
      requestedScopes: ["nodes:details", "docker:containers:secrets"],
      grantableScopes: ["nodes:details", "docker:containers:secrets"],
      unavailableScopes: [],
      manualApprovalScopes: ["docker:containers:secrets"],
    });
    const approve = vi
      .spyOn(api, "approveOAuthConsent")
      .mockRejectedValue(new Error("stop before navigation"));

    renderWithRouter(<OAuthConsent />, {
      path: "/oauth/consent",
      route: "/oauth/consent?request=request-1",
    });

    expect(await screen.findByText(/reveal sensitive data/)).toBeInTheDocument();
    await waitForReveal();
    expect(screen.getByRole("checkbox", { name: /View Nodes/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Container Secrets/i })).not.toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: /Authorize/i }));

    expect(approve).toHaveBeenCalledWith("request-1", ["nodes:details"]);
  });

  describe("folder and resource restrictions", () => {
    const folderId = "0b3d7f0e-1111-4c1a-9d2e-3f4a5b6c7d8e";
    const folderScope = `docker:containers:manage:folder/${folderId}`;

    function mockDockerInventory() {
      vi.mocked(api.listNodes).mockResolvedValue({
        data: [{ id: "node-1", type: "docker", hostname: "docker-1", displayName: "Docker 1" }],
      } as never);
      vi.spyOn(api, "listDockerFolders").mockResolvedValue([
        { id: folderId, name: "MyProject", children: [] },
      ] as never);
      vi.spyOn(api, "listDockerContainers").mockResolvedValue([
        { scopeResourceId: "c1", name: "web", folderId, kind: "container" },
      ] as never);
      vi.spyOn(api, "getOAuthConsent").mockResolvedValue({
        ...preview,
        requestedScopes: ["docker:containers:manage", "nodes:details"],
        grantableScopes: ["docker:containers:manage", "nodes:details"],
        unavailableScopes: [],
      });
    }

    it("loads the signed-in account on the consent page so folders and containers can be offered", async () => {
      useAuthStore.setState({ user: null });
      const getCurrentUser = vi.spyOn(api, "getCurrentUser").mockResolvedValue({
        id: "user-1",
        scopes: ["nodes:details", "docker:containers:manage"],
      } as never);
      mockDockerInventory();

      renderWithRouter(<OAuthConsent />, {
        path: "/oauth/consent",
        route: "/oauth/consent?request=request-1",
      });

      expect(await screen.findByText("Manage Containers")).toBeInTheDocument();
      expect(getCurrentUser).toHaveBeenCalledTimes(1);
      await userEvent.click(
        await screen.findByRole("button", { name: /Restrict Manage Containers/i })
      );
      expect(await screen.findByRole("checkbox", { name: /MyProject/ })).toBeInTheDocument();
      expect(await screen.findByRole("checkbox", { name: /web/ })).toBeInTheDocument();
      expect(screen.getByText("2 scopes will be granted")).toBeInTheDocument();
    });

    it("approves a scope restricted to a selected folder", async () => {
      useAuthStore.setState({
        user: { id: "user-1", scopes: ["nodes:details", "docker:containers:manage"] } as never,
      });
      mockDockerInventory();
      const approve = vi
        .spyOn(api, "approveOAuthConsent")
        .mockRejectedValue(new Error("stop before navigation"));

      renderWithRouter(<OAuthConsent />, {
        path: "/oauth/consent",
        route: "/oauth/consent?request=request-1",
      });

      expect(await screen.findAllByText("All resources")).not.toHaveLength(0);
      await userEvent.click(
        await screen.findByRole("button", { name: /Restrict Manage Containers/i })
      );
      await userEvent.click(await screen.findByRole("checkbox", { name: /MyProject/ }));
      await userEvent.click(
        screen.getByRole("button", { name: /Done restricting Manage Containers/i })
      );
      expect(screen.getByText("MyProject (folder)")).toBeInTheDocument();
      await userEvent.click(screen.getByRole("button", { name: /Authorize/i }));

      expect(approve).toHaveBeenCalledWith("request-1", [folderScope, "nodes:details"]);
    });

    it("limits every selected scope of a folder family from the header action", async () => {
      useAuthStore.setState({
        user: { id: "user-1", scopes: ["nodes:details", "docker:containers:manage"] } as never,
      });
      mockDockerInventory();
      const approve = vi
        .spyOn(api, "approveOAuthConsent")
        .mockRejectedValue(new Error("stop before navigation"));

      renderWithRouter(<OAuthConsent />, {
        path: "/oauth/consent",
        route: "/oauth/consent?request=request-1",
      });

      await userEvent.click(
        await screen.findByRole("button", { name: /Limit selected scopes to folder/i })
      );
      await userEvent.click(await screen.findByRole("menuitem", { name: "MyProject" }));
      await userEvent.click(screen.getByRole("button", { name: /Authorize/i }));

      expect(approve).toHaveBeenCalledWith("request-1", [folderScope, "nodes:details"]);
    });
  });
});
