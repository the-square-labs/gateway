import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import type { InferenceProviderCatalogItem, InferenceProviderConnection } from "@/types/inference";
import {
  groupProviderConnections,
  InferenceProvidersPanel,
  reorderProviderConnections,
} from "./InferenceProvidersPanel";

describe("InferenceProvidersPanel", () => {
  afterEach(() => {
    api.invalidateCache("req:/api/inference/providers");
    vi.restoreAllMocks();
  });

  it("groups repeated providers and manages one subscription connection in a modal", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["inference:providers:manage"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    const connections = [connection("account-a"), connection("account-b")];
    vi.spyOn(api, "listInferenceProviderCatalog").mockResolvedValue([
      provider("kimi", "Kimi subscription"),
      provider("openrouter", "OpenRouter"),
    ]);
    vi.spyOn(api, "listInferenceProviderConnections").mockResolvedValue(connections);
    const sync = vi.spyOn(api, "syncInferenceProvider").mockResolvedValue(connections[0]!);
    const update = vi.spyOn(api, "updateInferenceProvider").mockResolvedValue(connections[0]!);
    const user = userEvent.setup();

    render(<InferenceProvidersPanel />);

    expect(await screen.findAllByText("Kimi subscription")).toHaveLength(3);
    expect(screen.queryByText("OpenRouter")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reorder account-a" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reorder account-b" })).not.toBeInTheDocument();
    expect(screen.getByText("account-a").closest("tr")).toHaveClass("cursor-grab");
    await user.click(screen.getByRole("button", { name: "Collapse Kimi subscription" }));
    expect(screen.getByText("account-a").closest("tr")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("account-b").closest("tr")).toHaveAttribute("aria-hidden", "true");
    await user.click(screen.getByRole("button", { name: "Expand Kimi subscription" }));
    expect(screen.getByText("account-a").closest("tr")).not.toHaveAttribute("aria-hidden");
    expect(
      screen.getByText(
        /Higher connections are used first by Sequential routing; Balanced distributes evenly/
      )
    ).toBeInTheDocument();
    const syncAction = screen.getByRole("button", { name: "Sync account-a" });
    expect(syncAction).toHaveClass("border");
    await user.click(syncAction);
    await waitFor(() => expect(sync).toHaveBeenCalledWith("account-a"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByText("account-a"));

    const dialog = screen.getByRole("dialog");
    expect(dialog).toBeInTheDocument();
    expect(within(dialog).getByText("80% remaining")).toBeInTheDocument();
    expect(within(dialog).getByText("50% remaining")).toBeInTheDocument();
    expect(within(dialog).queryByText("Monthly")).not.toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Minimum remaining percentage" })).toHaveValue(0);

    await user.click(screen.getByRole("button", { name: "Sync now" }));
    await waitFor(() => expect(sync).toHaveBeenCalledTimes(2));

    const reserve = screen.getByRole("spinbutton", { name: "Minimum remaining percentage" });
    await user.clear(reserve);
    await user.type(reserve, "25");
    await user.click(screen.getByRole("button", { name: "Save settings" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("account-a", {
        minimumRemainingPercent: 25,
      })
    );
  });

  it("does not expose a subscription reserve for API credentials", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["inference:providers:manage"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "listInferenceProviderCatalog").mockResolvedValue([
      provider("openrouter", "OpenRouter"),
    ]);
    vi.spyOn(api, "listInferenceProviderConnections").mockResolvedValue([
      connection("router-key", "openrouter", {
        apiMonthlyLimitMicrodollars: 100_000_000,
        apiMonthlySpentMicrodollars: 12_340_000,
      }),
    ]);
    const update = vi
      .spyOn(api, "updateInferenceProvider")
      .mockResolvedValue(connection("router-key", "openrouter"));
    const user = userEvent.setup();

    render(<InferenceProvidersPanel />);
    await user.click(await screen.findByText("router-key"));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.queryByRole("spinbutton", { name: "Minimum remaining percentage" })
    ).not.toBeInTheDocument();
    expect(screen.getByText(/Used this UTC month: \$12\.34/)).toBeInTheDocument();
    const apiLimit = screen.getByRole("spinbutton", { name: "Monthly API limit in USD" });
    expect(apiLimit).toHaveValue(100);
    await user.clear(apiLimit);
    await user.type(apiLimit, "125");
    await user.click(screen.getByRole("button", { name: "Save settings" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("router-key", {
        apiMonthlyLimitMicrodollars: 125_000_000,
      })
    );
  });

  it("keeps provider rows visible while a synchronized connection refreshes", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["inference:providers:manage"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    const connections = [connection("account-a")];
    let resolveRefresh: ((value: InferenceProviderConnection[]) => void) | undefined;
    vi.spyOn(api, "listInferenceProviderCatalog").mockResolvedValue([
      provider("kimi", "Kimi subscription"),
    ]);
    vi.spyOn(api, "listInferenceProviderConnections")
      .mockResolvedValueOnce(connections)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          })
      );
    const sync = vi.spyOn(api, "syncInferenceProvider").mockResolvedValue(connections[0]!);
    const user = userEvent.setup();

    render(<InferenceProvidersPanel />);
    expect(await screen.findByText("account-a")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sync account-a" }));
    await waitFor(() => expect(sync).toHaveBeenCalledWith("account-a"));

    expect(screen.getByText("account-a")).toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();

    await act(async () => resolveRefresh?.(connections));
  });

  it("closes the connect dialog before refreshing providers after success", async () => {
    useAuthStore.setState({
      user: makeUser({ scopes: ["inference:providers:manage"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    const catalog = [provider("openrouter", "OpenRouter")];
    let resolveRefresh: ((value: InferenceProviderConnection[]) => void) | undefined;
    vi.spyOn(api, "listInferenceProviderCatalog").mockResolvedValue(catalog);
    vi.spyOn(api, "listInferenceProviderConnections")
      .mockResolvedValueOnce([])
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          })
      );
    const create = vi
      .spyOn(api, "createInferenceProviderConnection")
      .mockResolvedValue(connection("router-key", "openrouter"));
    const user = userEvent.setup();

    render(<InferenceProvidersPanel />);
    await user.click(await screen.findByRole("button", { name: "Connect provider" }));
    const dialog = screen.getByRole("dialog", { name: "Connect inference provider" });
    await user.type(within(dialog).getByPlaceholderText("Team account"), "Router key");
    const apiKey = dialog.querySelector<HTMLInputElement>('input[type="password"]');
    expect(apiKey).not.toBeNull();
    await user.type(apiKey!, "sk-test");
    await user.click(within(dialog).getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(
      screen.queryByRole("dialog", { name: "Connect inference provider" })
    ).not.toBeInTheDocument();
    await act(async () => resolveRefresh?.([connection("router-key", "openrouter")]));
  });

  it("renders cached connections while the background refresh is pending", () => {
    api.setCache("req:/api/inference/providers/catalog", [provider("kimi", "Kimi subscription")]);
    api.setCache("req:/api/inference/providers/connections", [connection("cached-account")]);
    vi.spyOn(api, "listInferenceProviderCatalog").mockImplementation(() => new Promise(() => {}));
    vi.spyOn(api, "listInferenceProviderConnections").mockImplementation(
      () => new Promise(() => {})
    );

    const { rerender } = render(<InferenceProvidersPanel />);

    expect(screen.getByText("cached-account")).toBeInTheDocument();
    expect(screen.queryByText("Loading...")).not.toBeInTheDocument();
    rerender(<InferenceProvidersPanel refreshToken={1} />);
    expect(api.listInferenceProviderCatalog).toHaveBeenCalledTimes(2);
    expect(api.listInferenceProviderConnections).toHaveBeenCalledTimes(2);
  });

  it("assigns persisted routing order from the visible drag order", () => {
    const connections = [connection("account-a"), connection("account-b"), connection("account-c")];

    expect(reorderProviderConnections(connections, "account-c", "account-a")).toEqual([
      expect.objectContaining({ id: "account-c", routingOrder: 0 }),
      expect.objectContaining({ id: "account-a", routingOrder: 1 }),
      expect.objectContaining({ id: "account-b", routingOrder: 2 }),
    ]);
  });

  it("keeps connections inside their provider group", () => {
    const connections = [
      connection("kimi-a"),
      connection("router", "openrouter"),
      connection("kimi-b"),
    ];

    expect(reorderProviderConnections(connections, "kimi-a", "router")).toBe(connections);
    expect(groupProviderConnections(connections).map((row) => row.id)).toEqual([
      "provider-group:kimi",
      "kimi-a",
      "kimi-b",
      "router",
    ]);
    expect(groupProviderConnections(connections, new Set(["kimi"]))).toEqual([
      expect.objectContaining({ id: "provider-group:kimi" }),
      expect.objectContaining({ id: "kimi-a", collapsed: true }),
      expect.objectContaining({ id: "kimi-b", collapsed: true }),
      expect.objectContaining({ id: "router" }),
    ]);
  });
});

function provider(id: string, label: string): InferenceProviderCatalogItem {
  return {
    id,
    label,
    family: id === "kimi" ? "kimi" : "custom",
    wireProtocol: "openai-chat",
    baseUrl: "https://provider.test",
    authTypes: id === "kimi" ? ["oauth"] : ["api_key"],
    subscription: id === "kimi",
    featured: true,
    oauthFlow: id === "kimi" ? "device" : null,
    completionMode: id === "kimi" ? "device_poll" : null,
  };
}

function connection(
  id: string,
  providerId = "kimi",
  overrides: Partial<InferenceProviderConnection> = {}
): InferenceProviderConnection {
  return {
    id,
    providerId,
    name: id,
    authType: providerId === "kimi" ? "oauth" : "api_key",
    baseUrl: "https://provider.test",
    accountLabel: `${id}@example.test`,
    enabled: true,
    routingOrder: 0,
    minimumRemainingPercent: 0,
    apiMonthlyLimitMicrodollars: null,
    apiMonthlySpentMicrodollars: 0,
    routingStrategy: "balanced",
    status: "healthy",
    healthReason: null,
    syncStatus: "success",
    syncLastError: null,
    lastSyncedAt: "2026-07-27T10:00:00.000Z",
    quota: [
      { dimension: "5h", status: "fresh", remainingFraction: 0.8 },
      { dimension: "7d", status: "fresh", remainingFraction: 0.5 },
    ],
    discoveredModels: [],
    ...overrides,
  };
}
