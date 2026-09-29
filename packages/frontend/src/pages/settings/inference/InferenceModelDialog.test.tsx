import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { vi } from "vitest";
import { api } from "@/services/api";
import type {
  InferenceModel,
  InferenceProviderCatalogItem,
  InferenceProviderConnection,
} from "@/types/inference";
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
    const modelSelector = screen.getByRole("combobox", { name: "Upstream model" });
    await user.click(modelSelector);
    const dropdown = screen
      .getByRole("button", { name: "K3" })
      .closest<HTMLElement>(".dropdown-content")!;
    const dialog = screen.getByRole("dialog", { name: "Add Inference Model" });
    const body = dialog.querySelector<HTMLElement>("[data-dialog-body]")!;
    body.scrollTop = 240;
    dropdown.scrollTop = 80;
    const scrollIntoView = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    scrollIntoView.mockClear();

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
    expect(screen.getByRole("dialog", { name: "Add Inference Model" })).toBe(dialog);
    expect(screen.getByRole("combobox", { name: "Upstream model" })).toBe(modelSelector);
    expect(modelSelector).toHaveFocus();
    expect(modelSelector).toHaveAttribute("aria-expanded", "true");
    expect(body.scrollTop).toBe(240);
    expect(dropdown.scrollTop).toBe(80);
    expect(scrollIntoView).not.toHaveBeenCalled();
    scrollIntoView.mockRestore();
  });

  it("restores reasoning rows in the model's saved order", async () => {
    const user = userEvent.setup();
    const editing = {
      id: "model-1",
      publicId: "k3",
      displayName: "K3",
      sortOrder: 0,
      enabled: true,
      contextWindow: 1_000_000,
      maxInputTokens: 900_000,
      maxOutputTokens: 8_000,
      autoCompactTokenLimit: 800_000,
      modalities: ["text", "image"],
      capabilities: { reasoning: true, tools: true, vision: true },
      configuredCapabilities: { reasoning: true, tools: true, vision: true },
      capabilityLimitations: {},
      reasoningEfforts: ["high", "low", "ultra"],
      defaultReasoningEffort: "high",
      defaultAccessAllowed: true,
      accessMode: "everyone",
      accessSubjects: [],
      subscriptionMultiplier: 1,
      sources: [
        {
          id: "source-1",
          connectionId: "kimi-a",
          discoveredModelId: "kimi-a-k3",
          providerId: "kimi",
          connectionName: "kimi-a",
          upstreamModelId: "k3",
          sourceType: "subscription",
          enabled: true,
          priority: 0,
          subscriptionMultiplierOverride: null,
          // PostgreSQL jsonb does not preserve the order selected by the user.
          reasoningEffortMap: { low: "low", high: "high", ultra: "max" },
          reasoningEfforts: ["low", "high", "max"],
          capabilities: { reasoning: true, tools: true, vision: true },
          contextWindow: 1_000_000,
          maxInputTokens: 900_000,
          maxOutputTokens: 8_000,
          autoCompactTokenLimit: 800_000,
          modalities: ["text", "image"],
          capabilitiesOverride: null,
          metadata: {},
          pricing: null,
        },
      ],
      accessRules: [],
    } as InferenceModel;

    render(
      <InferenceModelDialog
        open
        editing={editing}
        connections={[connection("kimi-a")]}
        catalog={[provider("kimi", "Kimi subscription", true)]}
        groups={[]}
        users={[]}
        onOpenChange={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
      />
    );

    await user.click(screen.getByRole("tab", { name: "Reasoning" }));
    expect(
      [1, 2, 3].map(
        (index) =>
          (screen.getByRole("textbox", { name: `Client effort ${index}` }) as HTMLInputElement)
            .value
      )
    ).toEqual(["high", "low", "ultra"]);
  });

  it("restores the saved system prompt and submits the edited prompt with its delivery mode", async () => {
    const user = userEvent.setup();
    const saveConfiguration = vi
      .spyOn(api, "saveInferenceModelConfiguration")
      .mockResolvedValue({} as never);
    const editing = {
      id: "model-1",
      publicId: "k3",
      displayName: "K3",
      sortOrder: 0,
      enabled: true,
      contextWindow: 1_000_000,
      maxInputTokens: 900_000,
      maxOutputTokens: 8_000,
      autoCompactTokenLimit: 800_000,
      modalities: ["text", "image"],
      capabilities: { reasoning: true, tools: true, vision: true },
      configuredCapabilities: { reasoning: true, tools: true, vision: true },
      capabilityLimitations: {},
      reasoningEfforts: ["high", "low", "ultra"],
      defaultReasoningEffort: "high",
      systemPrompt: "Prefer small diffs.",
      systemPromptMode: "replace",
      defaultAccessAllowed: true,
      accessMode: "everyone",
      accessSubjects: [],
      subscriptionMultiplier: 1,
      sources: [
        {
          id: "source-1",
          connectionId: "kimi-a",
          discoveredModelId: "kimi-a-k3",
          providerId: "kimi",
          connectionName: "kimi-a",
          upstreamModelId: "k3",
          sourceType: "subscription",
          enabled: true,
          priority: 0,
          subscriptionMultiplierOverride: null,
          // PostgreSQL jsonb does not preserve the order selected by the user.
          reasoningEffortMap: { low: "low", high: "high", ultra: "max" },
          reasoningEfforts: ["low", "high", "max"],
          capabilities: { reasoning: true, tools: true, vision: true },
          contextWindow: 1_000_000,
          maxInputTokens: 900_000,
          maxOutputTokens: 8_000,
          autoCompactTokenLimit: 800_000,
          modalities: ["text", "image"],
          capabilitiesOverride: null,
          metadata: {},
          pricing: null,
        },
      ],
      accessRules: [],
    } as InferenceModel;

    render(
      <InferenceModelDialog
        open
        editing={editing}
        connections={[connection("kimi-a")]}
        catalog={[provider("kimi", "Kimi subscription", true)]}
        groups={[]}
        users={[]}
        onOpenChange={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
      />
    );

    await user.click(screen.getByRole("tab", { name: "System prompt" }));
    const prompt = screen.getByRole("textbox", { name: "Model system prompt" });
    expect(prompt).toHaveValue("Prefer small diffs.");
    expect(screen.getByRole("combobox", { name: "System prompt delivery mode" })).toHaveTextContent(
      "Replace harness default"
    );

    await user.clear(prompt);
    await user.type(prompt, "Answer tersely.");
    await user.click(screen.getByRole("button", { name: "Save model" }));

    await waitFor(() => expect(saveConfiguration).toHaveBeenCalled());
    expect(saveConfiguration.mock.calls[0]?.[1].model).toMatchObject({
      systemPrompt: "Answer tersely.",
      systemPromptMode: "replace",
    });
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

  it("clears generated fields when a new model provider is selected", async () => {
    const user = userEvent.setup();
    render(
      <InferenceModelDialog
        open
        editing={null}
        connections={[connection("kimi-a"), connection("openai-key", "openai-apikey")]}
        catalog={[
          provider("kimi", "Kimi subscription", true),
          provider("openai-apikey", "OpenAI API", false),
        ]}
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
    expect(screen.getByLabelText("Public model ID")).toHaveValue("k3");
    expect(screen.getByLabelText("Display name")).toHaveValue("K3");

    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    await user.click(screen.getByRole("button", { name: "openai-key" }));

    expect(screen.getByLabelText("Public model ID")).toHaveValue("");
    expect(screen.getByLabelText("Display name")).toHaveValue("");
    await waitFor(() => {
      expect(screen.queryByRole("spinbutton", { name: "Context window" })).not.toBeInTheDocument();
    });
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
    const dialog = screen.getByRole("dialog", { name: "Add Inference Model" });
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
        metadataSources: { contextWindow: "provider", maxOutputTokens: "fallback" },
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
    expect(screen.getByText("Reported by the provider API; may be overridden")).toBeInTheDocument();
    expect(
      screen.getByText("Not reported by the provider; built-in catalog value")
    ).toBeInTheDocument();
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

  it("hides models without required limits and hides reasoning for a non-reasoning model", async () => {
    const openAi = connection("openai-key", "openai-apikey");
    openAi.discoveredModels = [
      {
        id: "openai-key-gpt-4",
        connectionId: "openai-key",
        remoteModelId: "gpt-4",
        displayName: "GPT-4",
        contextWindow: 8192,
        maxInputTokens: 6144,
        maxOutputTokens: null,
        autoCompactTokenLimit: 5500,
        modalities: ["text"],
        capabilities: { reasoning: false, tools: true, vision: false },
        reasoningEfforts: [],
        available: true,
      },
      {
        id: "openai-key-gpt-legacy",
        connectionId: "openai-key",
        remoteModelId: "gpt-legacy",
        displayName: "GPT Legacy",
        contextWindow: null,
        maxInputTokens: null,
        maxOutputTokens: null,
        autoCompactTokenLimit: null,
        modalities: ["text"],
        capabilities: { reasoning: false, tools: true, vision: false },
        reasoningEfforts: [],
        available: true,
      },
      {
        id: "openai-key-gpt-catalog-reasoning",
        connectionId: "openai-key",
        remoteModelId: "gpt-catalog-reasoning",
        displayName: "GPT Catalog Reasoning",
        contextWindow: 200_000,
        maxInputTokens: 200_000,
        maxOutputTokens: 64_000,
        autoCompactTokenLimit: 180_000,
        modalities: ["text"],
        capabilities: { reasoning: true, tools: true, vision: false },
        reasoningEfforts: ["low", "medium", "high"],
        metadataSources: { reasoningEfforts: "fallback" },
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
    expect(screen.queryByRole("button", { name: "GPT Legacy" })).not.toBeInTheDocument();
    // An API-key roster publishes ids only, so catalog effort levels stay valid there.
    expect(screen.getByRole("button", { name: "GPT Catalog Reasoning" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "GPT-4" }));

    expect(screen.queryByRole("tab", { name: "Reasoning" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Pricing" })).toBeInTheDocument();
    const addModel = screen.getByRole("button", { name: "Add model" });

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

  it("hides catalog-only reasoning on a subscription, labels calculated limits, and keeps the edited model", async () => {
    const claude = claudeSubscription();
    const user = userEvent.setup();
    const { rerender } = render(
      <InferenceModelDialog
        open
        editing={null}
        connections={[claude]}
        catalog={[provider("anthropic", "Claude subscription", true)]}
        groups={[]}
        users={[]}
        onOpenChange={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
      />
    );

    await user.click(screen.getByRole("combobox", { name: "Provider" }));
    await user.click(screen.getByRole("button", { name: "Claude subscription" }));
    await user.click(screen.getByRole("combobox", { name: "Upstream model" }));
    expect(screen.queryByRole("button", { name: "Claude Sonnet 4.5" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Claude Sonnet 5.5" }));
    expect(
      screen.getAllByText("Calculated from limits reported by the provider; may be overridden")
    ).toHaveLength(2);
    expect(screen.getByText("Reported by the provider API; may be overridden")).toBeInTheDocument();

    const editing = {
      id: "model-sonnet-4-5",
      publicId: "claude-sonnet-4-5",
      displayName: "Claude Sonnet 4.5",
      sortOrder: 0,
      enabled: true,
      contextWindow: 200_000,
      maxInputTokens: 200_000,
      maxOutputTokens: 64_000,
      autoCompactTokenLimit: 180_000,
      modalities: ["text", "image"],
      capabilities: { reasoning: true, tools: true, vision: true },
      configuredCapabilities: { reasoning: true, tools: true, vision: true },
      capabilityLimitations: {},
      reasoningEfforts: [],
      defaultReasoningEffort: null,
      defaultAccessAllowed: true,
      accessMode: "everyone",
      accessSubjects: [],
      subscriptionMultiplier: 1,
      sources: [
        {
          id: "source-sonnet-4-5",
          connectionId: claude.id,
          discoveredModelId: `${claude.id}-sonnet-4-5`,
          providerId: "anthropic",
          connectionName: claude.name,
          upstreamModelId: "claude-sonnet-4-5",
          sourceType: "subscription",
          enabled: true,
          priority: 0,
          subscriptionMultiplierOverride: null,
          reasoningEffortMap: {},
          reasoningEfforts: [],
          capabilities: { reasoning: true, tools: true, vision: true },
          contextWindow: 200_000,
          maxInputTokens: 200_000,
          maxOutputTokens: 64_000,
          autoCompactTokenLimit: 180_000,
          modalities: ["text", "image"],
          capabilitiesOverride: null,
          metadata: {},
          pricing: null,
        },
      ],
      accessRules: [],
    } as unknown as InferenceModel;
    rerender(
      <InferenceModelDialog
        open
        editing={editing}
        connections={[claude]}
        catalog={[provider("anthropic", "Claude subscription", true)]}
        groups={[]}
        users={[]}
        onOpenChange={vi.fn()}
        onSaved={vi.fn().mockResolvedValue(undefined)}
      />
    );
    // Switching away from the edited model must not remove it from the picker.
    await user.click(screen.getByRole("combobox", { name: "Upstream model" }));
    await user.click(screen.getByRole("button", { name: "Claude Sonnet 5.5" }));
    await user.click(screen.getByRole("combobox", { name: "Upstream model" }));
    expect(screen.getByRole("button", { name: "Claude Sonnet 4.5" })).toBeInTheDocument();
  });
});

function claudeSubscription(): InferenceProviderConnection {
  const claude = connection("claude-sub", "anthropic");
  claude.authType = "oauth";
  const limits = { maxOutputTokens: 64_000, modalities: ["text", "image"], available: true };
  claude.discoveredModels = [
    {
      ...limits,
      id: "claude-sub-sonnet-4-5",
      connectionId: claude.id,
      remoteModelId: "claude-sonnet-4-5",
      displayName: "Claude Sonnet 4.5",
      contextWindow: 200_000,
      maxInputTokens: 200_000,
      autoCompactTokenLimit: 180_000,
      capabilities: { reasoning: true, tools: true, vision: true },
      reasoningEfforts: ["low", "medium", "high"],
      metadataSources: { contextWindow: "provider", reasoningEfforts: "fallback" },
    },
    {
      ...limits,
      id: "claude-sub-sonnet-5-5",
      connectionId: claude.id,
      remoteModelId: "claude-sonnet-5-5",
      displayName: "Claude Sonnet 5.5",
      contextWindow: 1_000_000,
      maxInputTokens: 1_000_000,
      autoCompactTokenLimit: 900_000,
      capabilities: { reasoning: true, tools: true, vision: true },
      reasoningEfforts: ["low", "medium", "high", "max"],
      metadataSources: {
        contextWindow: "provider",
        maxInputTokens: "derived",
        autoCompactTokenLimit: "derived",
        reasoningEfforts: "provider",
      },
    },
  ];
  return claude;
}

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
    minimumRemainingPercent: 1,
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
