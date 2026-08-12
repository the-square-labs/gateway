import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import { OAuthConsent } from "@/pages/OAuthConsent";
import { api } from "@/services/api";
import { renderWithRouter } from "@/test/render";
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

describe("OAuthConsent", () => {
  it("shows client, selected account, grantable scopes, unavailable scopes, and warning", async () => {
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
    expect(screen.getByText("Manage Users")).toBeInTheDocument();
    expect(
      screen.getByText("These were requested but cannot be granted by your account.")
    ).toBeInTheDocument();
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

  it("delivers the callback in the background and shows a result screen", async () => {
    vi.spyOn(api, "getOAuthConsent").mockResolvedValue(preview);
    vi.spyOn(api, "approveOAuthConsent").mockResolvedValue({
      redirectUrl: "http://127.0.0.1:8765/callback?code=abc",
    });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    renderWithRouter(<OAuthConsent />, {
      path: "/oauth/consent",
      route: "/oauth/consent?request=request-1",
    });

    await screen.findByText("Authorize Gateway API access");
    await userEvent.click(screen.getByRole("button", { name: /Authorize/i }));

    expect(await screen.findByText("Authorization complete")).toBeInTheDocument();
    expect(screen.getByText(/If the application did not finish signing in/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Open callback/i })).toHaveAttribute(
      "href",
      "http://127.0.0.1:8765/callback?code=abc"
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:8765/callback?code=abc",
      expect.objectContaining({
        mode: "no-cors",
        credentials: "omit",
        referrerPolicy: "no-referrer",
      })
    );
  });

  it("falls back to browser navigation when background callback delivery fails", async () => {
    vi.spyOn(api, "getOAuthConsent").mockResolvedValue(preview);
    vi.spyOn(api, "approveOAuthConsent").mockResolvedValue({
      redirectUrl: "http://127.0.0.1:8765/callback?code=abc",
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("callback offline"));
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
      await userEvent.click(screen.getByRole("button", { name: /Authorize/i }));

      expect(hrefSetter).toHaveBeenCalledWith("http://127.0.0.1:8765/callback?code=abc");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
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
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
      await userEvent.click(screen.getByRole("button", { name: /Authorize/i }));

      expect(hrefSetter).toHaveBeenCalledWith("https://client.example.com/callback?code=abc");
      expect(fetchSpy).not.toHaveBeenCalled();
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
    const fetchSpy = vi.spyOn(globalThis, "fetch");
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
      await userEvent.click(screen.getByRole("button", { name: /Deny/i }));

      expect(hrefSetter).toHaveBeenCalledWith(
        "https://client.example.com/callback?error=access_denied"
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  it("preserves resource-scoped scope values when authorizing", async () => {
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

    expect(await screen.findByText("docker:containers:view:node-1")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /docker:containers:view:node-1/i })).toBeChecked();

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
    expect(screen.getByRole("checkbox", { name: /View Nodes/i })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /Container Secrets/i })).not.toBeChecked();

    await userEvent.click(screen.getByRole("button", { name: /Authorize/i }));

    expect(approve).toHaveBeenCalledWith("request-1", ["nodes:details"]);
  });
});
