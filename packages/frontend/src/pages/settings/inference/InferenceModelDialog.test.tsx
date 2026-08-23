import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { vi } from "vitest";
import { api } from "@/services/api";
import type { InferenceProviderCatalogItem, InferenceProviderConnection } from "@/types/inference";
import { InferenceModelDialog } from "./InferenceModelDialog";

describe("InferenceModelDialog", () => {
  it("keeps the active tab mounted while the dialog exit animation runs", async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <InferenceModelDialog
          open={open}
          editing={null}
          connections={[]}
          catalog={[]}
          groups={[]}
          users={[]}
          onOpenChange={setOpen}
          onSaved={vi.fn().mockResolvedValue(undefined)}
        />
      );
    }

    render(<Harness />);
    const user = userEvent.setup();
    const accessTab = screen.getByRole("tab", { name: "Access" });
    await user.click(accessTab);
    expect(accessTab).toHaveAttribute("data-state", "active");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(accessTab).toHaveAttribute("data-state", "active");
  });

  it("preserves an unsaved model draft when realtime catalog data refreshes", async () => {
    const kimi = connection("kimi-a");
    const kimiProvider = provider("kimi", "Kimi subscription", true);
    const props = {
      open: true,
      editing: null,
      groups: [],
      users: [],
      onOpenChange: vi.fn(),
      onSaved: vi.fn().mockResolvedValue(undefined),
    };
    const user = userEvent.setup();
    const { rerender } = render(
      <InferenceModelDialog {...props} connections={[kimi]} catalog={[kimiProvider]} />
    );

    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    await user.click(screen.getByRole("button", { name: "Kimi subscription" }));
    await user.click(screen.getByRole("combobox", { name: "Upstream model" }));
    await user.click(screen.getByRole("button", { name: "K3" }));
    const displayName = screen.getByLabelText("Display name");
    await user.clear(displayName);
    await user.type(displayName, "Unsaved model name");

    rerender(
      <InferenceModelDialog
        {...props}
        connections={[
          {
            ...kimi,
            lastSyncedAt: "2026-07-27T12:05:00.000Z",
            discoveredModels: kimi.discoveredModels.map((model) => ({ ...model })),
          },
        ]}
        catalog={[{ ...kimiProvider, label: "Kimi refreshed" }]}
      />
    );

    expect(displayName).toHaveValue("Unsaved model name");
  });

  it("shows upstream ids only when display names collide", async () => {
    const openAi = connection("openai-key", "openai-apikey");
    const base = openAi.discoveredModels[0]!;
    openAi.discoveredModels = [
      { ...base, id: "alias", remoteModelId: "gpt-5.6", displayName: "GPT-5.6 Sol" },
      { ...base, id: "canonical", remoteModelId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
      { ...base, id: "unique", remoteModelId: "gpt-5.6-terra", displayName: "GPT-5.6 Terra" },
    ];
    const user = userEvent.setup();

    render(
      <InferenceModelDialog
        open
        editing={null}
        connections={[openAi]}
        catalog={[provider("openai-apikey", "OpenAI API", false)]}
        groups={[]}
        users={[]}
        onOpenChange={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    await user.click(screen.getByRole("button", { name: "openai-key" }));
    await user.click(screen.getByRole("combobox", { name: "Upstream model" }));

    expect(screen.getByRole("button", { name: "GPT-5.6 Sol · gpt-5.6" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "GPT-5.6 Sol · gpt-5.6-sol" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "GPT-5.6 Terra" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "GPT-5.6 Sol" })).not.toBeInTheDocument();
  });

  it("creates account bindings only for one selected provider model", async () => {
    const save = vi
      .spyOn(api, "saveInferenceModelConfiguration")
      .mockResolvedValue({ id: "model-1" } as never);
    const user = userEvent.setup();
    const limitedKimi = connection("kimi-b");
    limitedKimi.discoveredModels[0]!.capabilities.vision = false;

    render(
      <InferenceModelDialog
        open
        editing={null}
        connections={[connection("kimi-a"), limitedKimi, connection("router", "openrouter")]}
        catalog={[
          provider("kimi", "Kimi subscription", true),
          provider("openrouter", "OpenRouter", false),
        ]}
        groups={[]}
        users={[]}
        onOpenChange={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(
      screen.queryByText("Select a provider and model to load discovered capabilities and limits.")
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    await user.click(screen.getByRole("button", { name: "Kimi subscription" }));
    await user.click(screen.getByRole("combobox", { name: "Upstream model" }));
    const modelOption = screen.getByRole("button", { name: "K3" });
    const modelDropdown = modelOption.closest<HTMLElement>(".dropdown-content");
    expect(modelDropdown).toHaveClass("overflow-y-auto");
    expect(modelDropdown?.className).toContain("max-h-[min(16rem");
    const dialog = screen.getByRole("dialog", { name: "Add inference model" });
    expect(dialog).toHaveClass("sm:overflow-clip");
    expect(dialog.className).not.toContain("overflow-y-auto");
    expect(dialog).not.toContainElement(modelDropdown);
    await user.click(modelOption);

    expect(screen.getByText("2 of 2 enabled accounts can serve this model")).toBeInTheDocument();
    expect(screen.getByTestId("model-identity-fields")).toHaveClass(
      "sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_10rem]"
    );
    const unavailableCapability = screen.getByText("vision unavailable");
    expect(unavailableCapability).toBeInTheDocument();
    expect(unavailableCapability.parentElement?.parentElement).toHaveClass(
      "w-full",
      "min-w-0",
      "flex-wrap"
    );
    expect(screen.queryByText(/vision unavailable on/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/provider account or key/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/add source|source priority/i)).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Reasoning" }));
    const reasoningPanel = screen.getByText("Client-to-provider mapping").closest(".border");
    expect(reasoningPanel).toContainElement(
      screen.getByRole("combobox", { name: "Default reasoning effort" })
    );
    await user.click(screen.getByRole("button", { name: "Add mapping" }));
    await user.type(screen.getByRole("textbox", { name: "Client effort 3" }), "ultra");
    const providerEffort = screen.getByRole("combobox", { name: "Provider effort 3" });
    await user.click(providerEffort);
    expect(screen.getByRole("button", { name: "max" })).toBeInTheDocument();
    await user.type(providerEffort, "thinking-max");

    await user.click(screen.getByRole("button", { name: "Add model" }));

    await waitFor(() => expect(save).toHaveBeenCalled());
    const configuration = save.mock.calls[0]?.[1] as {
      sources: Array<Record<string, unknown>>;
      access: Record<string, unknown>;
    };
    expect(save).toHaveBeenCalledWith(null, expect.any(Object));
    expect(configuration.sources).toEqual([
      expect.objectContaining({ connectionId: "kimi-a", discoveredModelId: "kimi-a-k3" }),
      expect.objectContaining({ connectionId: "kimi-b", discoveredModelId: "kimi-b-k3" }),
    ]);
    for (const payload of configuration.sources) {
      expect(payload).not.toHaveProperty("priority");
      expect(payload).not.toHaveProperty("role");
      expect(payload).not.toHaveProperty("manualMetadata");
      expect(payload).toMatchObject({
        reasoningEffortMap: { low: "low", high: "high", ultra: "thinking-max" },
      });
    }
    expect(configuration.access).toEqual({ mode: "everyone", subjects: [] });
  });

  it("preserves model selections and edits across inference realtime refreshes", async () => {
    const initialConnection = connection("kimi-a");
    const initialCatalog = [provider("kimi", "Kimi subscription", true)];
    const user = userEvent.setup();
    const view = render(
      <InferenceModelDialog
        open
        editing={null}
        connections={[initialConnection]}
        catalog={initialCatalog}
        groups={[]}
        users={[]}
        onOpenChange={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    await user.click(screen.getByRole("button", { name: "Kimi subscription" }));
    await user.click(screen.getByRole("combobox", { name: "Upstream model" }));
    await user.click(screen.getByRole("button", { name: "K3" }));
    const publicId = screen.getByPlaceholderText("kimi-k3");
    await user.clear(publicId);
    await user.type(publicId, "custom-kimi");

    view.rerender(
      <InferenceModelDialog
        open
        editing={null}
        connections={[
          { ...initialConnection, discoveredModels: [...initialConnection.discoveredModels] },
        ]}
        catalog={[{ ...initialCatalog[0]! }]}
        groups={[]}
        users={[]}
        onOpenChange={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByText("Provider model metadata")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("kimi-k3")).toHaveValue("custom-kimi");
  });

  it("shows detected OpenAI parameters and uses managed pricing without a manual payload", async () => {
    const save = vi
      .spyOn(api, "saveInferenceModelConfiguration")
      .mockResolvedValue({ id: "openai-model" } as never);
    const openAi = connection("openai-key", "openai-apikey");
    openAi.discoveredModels = [
      {
        id: "openai-key-gpt-5.1-codex-mini",
        connectionId: "openai-key",
        remoteModelId: "gpt-5.1-codex-mini",
        displayName: "GPT-5.1-Codex mini",
        contextWindow: 400_000,
        maxInputTokens: 272_000,
        maxOutputTokens: 128_000,
        autoCompactTokenLimit: 244_800,
        modalities: ["text", "image"],
        capabilities: { reasoning: true, tools: true, vision: true },
        reasoningEfforts: ["low", "medium", "high"],
        pricing: {
          version: "openai-api-2026-07-27",
          inputMicrodollarsPerMillion: 250_000,
          cachedInputMicrodollarsPerMillion: 25_000,
          outputMicrodollarsPerMillion: 2_000_000,
          source: "provider",
        },
        available: true,
      },
    ];
    const user = userEvent.setup();

    render(
      <InferenceModelDialog
        open
        editing={null}
        connections={[openAi]}
        catalog={[provider("openai-apikey", "OpenAI API", false)]}
        groups={[]}
        users={[]}
        onOpenChange={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    await user.click(screen.getByRole("button", { name: "openai-key" }));
    await user.click(screen.getByRole("combobox", { name: "Upstream model" }));
    await user.click(screen.getByRole("button", { name: "GPT-5.1-Codex mini" }));

    expect(screen.getByRole("spinbutton", { name: "Context window" })).toHaveValue(400_000);
    expect(screen.getByRole("spinbutton", { name: "Maximum input tokens" })).toHaveValue(272_000);
    expect(screen.getByRole("spinbutton", { name: "Maximum output tokens" })).toHaveValue(128_000);
    expect(screen.getByRole("spinbutton", { name: "Auto-compaction limit" })).toHaveValue(244_800);
    expect(screen.getByRole("spinbutton", { name: "Context window" })).not.toHaveAttribute(
      "readonly"
    );
    expect(screen.getByRole("spinbutton", { name: "Maximum input tokens" })).not.toHaveAttribute(
      "readonly"
    );
    expect(screen.getByRole("spinbutton", { name: "Auto-compaction limit" })).not.toHaveAttribute(
      "readonly"
    );
    expect(screen.getByRole("spinbutton", { name: "Maximum output tokens" })).toHaveAttribute(
      "readonly"
    );
    expect(
      screen.queryByRole("spinbutton", { name: "Subscription multiplier" })
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("model-identity-fields")).toHaveClass("sm:grid-cols-2");
    await user.clear(screen.getByRole("spinbutton", { name: "Context window" }));
    await user.type(screen.getByRole("spinbutton", { name: "Context window" }), "450000");
    expect(screen.getByText(/Override exceeds provider metadata \(400,000\)/)).toBeInTheDocument();
    expect(screen.queryByText(/Managed provider pricing/)).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Pricing" }));
    expect(screen.getByText(/Managed provider pricing/)).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Input tokens" })).toHaveValue("$0.25");
    expect(screen.getByRole("textbox", { name: "Output tokens" })).toHaveValue("$2");

    await user.click(screen.getByRole("button", { name: "Add model" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    expect(save.mock.calls[0]?.[1]).toMatchObject({
      model: { subscriptionMultiplier: 1 },
      sources: [
        expect.objectContaining({
          manualMetadata: { contextWindow: 450_000 },
        }),
      ],
    });
    expect(save.mock.calls[0]?.[1]).toMatchObject({
      sources: [expect.not.objectContaining({ pricing: expect.anything() })],
    });
  });

  it("requires manual technical metadata and hides reasoning for a non-reasoning model", async () => {
    const openAi = connection("openai-key", "openai-apikey");
    openAi.discoveredModels = [
      {
        id: "openai-key-gpt-4",
        connectionId: "openai-key",
        remoteModelId: "gpt-4",
        displayName: "GPT-4",
        contextWindow: null,
        maxInputTokens: null,
        maxOutputTokens: null,
        autoCompactTokenLimit: null,
        modalities: ["text"],
        capabilities: { reasoning: false, tools: true, vision: false },
        reasoningEfforts: [],
        available: true,
      },
    ];
    const user = userEvent.setup();

    render(
      <InferenceModelDialog
        open
        editing={null}
        connections={[openAi]}
        catalog={[provider("openai-apikey", "OpenAI API", false)]}
        groups={[]}
        users={[]}
        onOpenChange={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    await user.click(screen.getByRole("button", { name: "openai-key" }));
    await user.click(screen.getByRole("combobox", { name: "Upstream model" }));
    await user.click(screen.getByRole("button", { name: "GPT-4" }));

    expect(screen.queryByRole("tab", { name: "Reasoning" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Pricing" })).toBeInTheDocument();
    const addModel = screen.getByRole("button", { name: "Add model" });
    expect(addModel).toBeDisabled();

    const requiredValues: Array<[string, string]> = [
      ["Context window", "8192"],
      ["Maximum input tokens", "6144"],
      ["Auto-compaction limit", "5500"],
    ];
    for (const [name, value] of requiredValues) {
      const input = screen.getByRole("spinbutton", { name });
      expect(input).not.toHaveAttribute("readonly");
      expect(input).toHaveAttribute("placeholder", "Not reported");
      await user.type(input, value);
    }

    const optionalOutput = screen.getByRole("spinbutton", { name: "Maximum output tokens" });
    expect(optionalOutput).not.toHaveAttribute("readonly");
    expect(optionalOutput).toHaveAttribute("placeholder", "Not reported");
    expect(optionalOutput).toHaveValue(null);
    expect(addModel).toBeEnabled();

    await user.click(screen.getByRole("tab", { name: "Pricing" }));
    const inputPrice = screen.getByRole("spinbutton", { name: "Input tokens" });
    await user.clear(inputPrice);
    expect(inputPrice).toHaveValue(null);
    expect(addModel).toBeDisabled();
  });
});

function provider(id: string, label: string, subscription: boolean): InferenceProviderCatalogItem {
  return {
    id,
    label,
    family: id === "kimi" ? "kimi" : "custom",
    wireProtocol: "openai-chat",
    baseUrl: "https://provider.test",
    authTypes: subscription ? ["oauth"] : ["api_key"],
    subscription,
    featured: true,
    oauthFlow: subscription ? "device" : null,
    completionMode: subscription ? "device_poll" : null,
  };
}

function connection(id: string, providerId = "kimi"): InferenceProviderConnection {
  return {
    id,
    providerId,
    name: id,
    authType: providerId === "kimi" ? "oauth" : "api_key",
    baseUrl: "https://provider.test",
    accountLabel: null,
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
    lastSyncedAt: null,
    quota: [],
    discoveredModels: [
      {
        id: `${id}-k3`,
        connectionId: id,
        remoteModelId: "k3",
        displayName: "K3",
        contextWindow: 1_000_000,
        maxInputTokens: 900_000,
        maxOutputTokens: 8_000,
        autoCompactTokenLimit: 800_000,
        modalities: ["text", "image"],
        capabilities: { reasoning: true, tools: true, vision: true },
        reasoningEfforts: ["low", "high", "max"],
        available: true,
      },
    ],
  };
}
