import { describe, expect, it } from "vitest";
import type { AIProviderStatus } from "@/types/ai";
import { selectedModelSupportsImages } from "../../src/lib/ai-model-capabilities";

const status: AIProviderStatus = {
  enabled: true,
  providerType: "gateway_inference",
  defaultModel: "vision-model",
  allowUserModelSelection: true,
  supportsImages: true,
  models: [
    {
      id: "vision-model",
      displayName: "Vision model",
      supportsImages: true,
      maxContextTokens: 128_000,
      maxOutputTokens: null,
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    },
    {
      id: "text-model",
      displayName: "Text model",
      supportsImages: false,
      maxContextTokens: 128_000,
      maxOutputTokens: null,
      reasoningEfforts: [],
      defaultReasoningEffort: null,
    },
  ],
};

describe("selectedModelSupportsImages", () => {
  it("uses the selected Gateway Inference model capability", () => {
    expect(selectedModelSupportsImages(status, "vision-model")).toBe(true);
    expect(selectedModelSupportsImages(status, "text-model")).toBe(false);
    expect(selectedModelSupportsImages(status, "missing-model")).toBe(false);
  });

  it("uses the configured direct-provider capability", () => {
    expect(
      selectedModelSupportsImages(
        { ...status, providerType: "openai_compatible", models: [] },
        null
      )
    ).toBe(true);
  });
});
