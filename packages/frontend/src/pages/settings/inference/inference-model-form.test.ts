import { describe, expect, it } from "vitest";
import type { InferenceProviderCatalogItem, InferenceProviderConnection } from "@/types/inference";
import {
  buildProviderModelOptions,
  defaultReasoningMap,
  EMPTY_MODEL_FORM,
  exposedReasoningEfforts,
  formWithProviderModel,
  hasCompleteTechnicalLimits,
  modelTechnicalLimits,
  normalizeReasoningMap,
  pricingFromProvider,
  providerModelLabels,
} from "./inference-model-form";

describe("inference model form helpers", () => {
  it("groups account bindings only within one provider and upstream model", () => {
    const options = buildProviderModelOptions(
      [
        connection("openai", "team-a", [model("gpt-5.6", 200_000)]),
        connection("openai", "team-b", [model("gpt-5.6", 180_000)]),
        connection("openrouter", "router", [model("gpt-5.6", 128_000)]),
      ],
      [provider("openai", "Codex", true), provider("openrouter", "OpenRouter", false)]
    );

    expect(options).toHaveLength(2);
    expect(options.find((option) => option.providerId === "openai")).toMatchObject({
      remoteModelId: "gpt-5.6",
      sourceType: "subscription",
      totalAccounts: 2,
      contextWindow: 180_000,
    });
    expect(options.find((option) => option.providerId === "openai")?.bindings).toHaveLength(2);
    expect(options.find((option) => option.providerId === "openrouter")?.bindings).toHaveLength(1);
  });

  it("uses API connection names for pooled API providers and template labels for subscriptions", () => {
    const options = buildProviderModelOptions(
      [
        connection("openai-apikey", "Production key", [model("gpt-5.6", 200_000)]),
        connection("openai-apikey", "Backup key", [model("gpt-5.6", 200_000)]),
        connection("openai", "Team account", [model("gpt-5.6", 200_000)]),
      ],
      [
        provider("openai-apikey", "OpenAI API", false),
        provider("openai", "ChatGPT subscription", true),
      ]
    );

    expect(options.find((option) => option.providerId === "openai-apikey")).toMatchObject({
      providerLabel: "Production key, Backup key",
      sourceType: "api",
      totalAccounts: 2,
    });
    expect(options.find((option) => option.providerId === "openai")?.providerLabel).toBe(
      "ChatGPT subscription"
    );
  });

  it("adds model ids only to colliding display names", () => {
    const alias = model("gpt-5.6", 1_050_000);
    alias.displayName = "GPT-5.6 Sol";
    const canonical = model("gpt-5.6-sol", 1_050_000);
    canonical.displayName = "GPT-5.6 Sol";
    const unique = model("gpt-5.6-terra", 1_050_000);
    unique.displayName = "GPT-5.6 Terra";
    const options = buildProviderModelOptions(
      [connection("openai-apikey", "team", [alias, canonical, unique])],
      [provider("openai-apikey", "OpenAI API", false)]
    );

    expect(Object.fromEntries(providerModelLabels(options))).toEqual({
      "openai-apikey:gpt-5.6": "GPT-5.6 Sol · gpt-5.6",
      "openai-apikey:gpt-5.6-sol": "GPT-5.6 Sol · gpt-5.6-sol",
      "openai-apikey:gpt-5.6-terra": "GPT-5.6 Terra",
    });
  });

  it("intersects capabilities, modalities, and reasoning across provider accounts", () => {
    const first = model("k3", 1_000_000);
    first.modalities = ["text", "image"];
    first.capabilities = { reasoning: true, tools: true, vision: true };
    first.reasoningEfforts = ["low", "high", "max"];
    const second = model("k3", 900_000);
    second.modalities = ["text"];
    second.capabilities = { reasoning: true, tools: true, vision: false };
    second.reasoningEfforts = ["high", "max"];

    const [option] = buildProviderModelOptions(
      [connection("kimi", "a", [first]), connection("kimi", "b", [second])],
      [provider("kimi", "Kimi", true)]
    );

    expect(option?.modalities).toEqual(["text"]);
    expect(option?.reasoningEfforts).toEqual(["high", "max"]);
    expect(option?.capabilities).toEqual({ reasoning: true, tools: true, vision: false });
    expect(option?.capabilityLimitations.vision).toEqual(["b"]);
  });

  it("uses identity reasoning defaults and preserves custom mappings", () => {
    expect(defaultReasoningMap(["low", "high", "max"], {})).toEqual({
      low: "low",
      high: "high",
    });
    expect(defaultReasoningMap(["low", "high", "max"], { ultra: "max" })).toEqual({
      ultra: "max",
    });
    expect(exposedReasoningEfforts({ high: "high", ultra: "max" })).toEqual(["high", "ultra"]);
    expect(exposedReasoningEfforts({ custom: "thinking-max" })).toEqual(["custom"]);
    expect(normalizeReasoningMap({ " ultra ": " max ", "": "ignored" })).toEqual({
      ultra: "max",
    });
  });

  it("keeps auto-compaction within the selected provider model input limit", () => {
    const [option] = buildProviderModelOptions(
      [connection("openai", "team", [model("gpt", 200_000, 150_000, 180_000)])],
      [provider("openai", "Codex", true)]
    );
    const form = formWithProviderModel(EMPTY_MODEL_FORM, option!, true);
    expect(modelTechnicalLimits(form)).toMatchObject({
      contextWindow: 200_000,
      maxInputTokens: 150_000,
      autoCompactTokenLimit: 150_000,
    });
    expect(hasCompleteTechnicalLimits(form)).toBe(true);
  });

  it("requires manual technical limits when discovery does not report them", () => {
    const missing = model("gpt-4", 0);
    missing.contextWindow = null;
    missing.maxInputTokens = null;
    missing.maxOutputTokens = null;
    missing.autoCompactTokenLimit = null;
    const [option] = buildProviderModelOptions(
      [connection("openai-apikey", "team", [missing])],
      [provider("openai-apikey", "OpenAI API", false)]
    );
    const form = formWithProviderModel(EMPTY_MODEL_FORM, option!, true);

    expect(form).toMatchObject({
      contextWindow: "",
      maxInputTokens: "",
      maxOutputTokens: "",
      autoCompactTokenLimit: "",
    });
    expect(hasCompleteTechnicalLimits(form)).toBe(false);
    expect(
      hasCompleteTechnicalLimits({
        ...form,
        contextWindow: "8192",
        maxInputTokens: "6144",
        autoCompactTokenLimit: "5500",
      })
    ).toBe(true);
    expect(
      modelTechnicalLimits({
        ...form,
        contextWindow: "8192",
        maxInputTokens: "6144",
        autoCompactTokenLimit: "5500",
      }).maxOutputTokens
    ).toBeNull();
  });

  it("keeps common provider pricing and converts it for display", () => {
    const discovered = model("gpt-5.1-codex-mini", 400_000, 272_000, 244_800);
    discovered.pricing = {
      version: "openai-api-2026-07-27",
      inputMicrodollarsPerMillion: 250_000,
      cachedInputMicrodollarsPerMillion: 25_000,
      outputMicrodollarsPerMillion: 2_000_000,
      source: "provider",
    };
    const [option] = buildProviderModelOptions(
      [connection("openai-apikey", "team", [discovered])],
      [provider("openai-apikey", "OpenAI API", false)]
    );

    expect(option?.pricing).toEqual(discovered.pricing);
    expect(pricingFromProvider(option?.pricing)).toMatchObject({
      inputPrice: 0.25,
      outputPrice: 2,
    });
  });
});

function provider(id: string, label: string, subscription: boolean): InferenceProviderCatalogItem {
  return {
    id,
    label,
    family: id === "kimi" ? "kimi" : id === "openai" ? "openai" : "custom",
    wireProtocol: "openai-chat",
    baseUrl: "https://provider.test",
    authTypes: subscription ? ["oauth"] : ["api_key"],
    subscription,
    featured: true,
    oauthFlow: subscription ? "device" : null,
    completionMode: subscription ? "device_poll" : null,
  };
}

function connection(
  providerId: string,
  name: string,
  discoveredModels: InferenceProviderConnection["discoveredModels"]
): InferenceProviderConnection {
  return {
    id: `${providerId}-${name}`,
    providerId,
    name,
    authType: providerId === "openrouter" ? "api_key" : "oauth",
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
    discoveredModels,
  };
}

function model(
  remoteModelId: string,
  contextWindow: number,
  maxInputTokens = contextWindow,
  autoCompactTokenLimit = maxInputTokens
): InferenceProviderConnection["discoveredModels"][number] {
  return {
    id: `${remoteModelId}-${contextWindow}`,
    connectionId: "connection",
    remoteModelId,
    displayName: remoteModelId,
    contextWindow,
    maxInputTokens,
    maxOutputTokens: 8_000,
    autoCompactTokenLimit,
    modalities: ["text"],
    capabilities: { tools: true },
    reasoningEfforts: [],
    available: true,
  };
}
