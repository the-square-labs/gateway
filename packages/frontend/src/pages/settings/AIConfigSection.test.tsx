import { act, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { DEFAULT_SYSTEM_CONFIG, useSystemConfigStore } from "@/stores/system-config";
import { AIConfigSection } from "./AIConfigSection";

const AI_CONFIG = {
  enabled: true,
  providerType: "openai_compatible",
  providerUrl: "https://api.openai.com/v1",
  endpointMode: "responses",
  supportsImages: false,
  model: "gpt-5",
  gatewayInferenceModel: "",
  gatewayInferenceAllowUserModelSelection: false,
  gatewayInferenceModels: [],
  maxCompletionTokens: 4096,
  maxTokensField: "max_output_tokens",
  reasoningEffort: "medium",
  customSystemPrompt: "",
  rateLimitMax: 20,
  rateLimitWindowSeconds: 60,
  maxToolRounds: 10,
  maxContextTokens: 128_000,
  disabledTools: [],
  hasApiKey: true,
  apiKeyLast4: "1234",
  hasWebSearchKey: false,
  webSearchApiKeyLast4: "",
  webSearchProvider: "tavily",
  webSearchBaseUrl: "",
  sandboxEnabled: false,
  sandboxDefaultTier: "low",
} as const;

describe("AIConfigSection provider guidance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    api.invalidateCache("settings:ai-config");
    useSystemConfigStore.getState().reset();
  });

  it("links to General settings only while inference is disabled", async () => {
    api.setCache("settings:ai-config", AI_CONFIG);
    vi.spyOn(api, "getAIConfig").mockResolvedValue(AI_CONFIG);
    vi.spyOn(api, "listAISandboxJobs").mockResolvedValue([]);
    vi.spyOn(api, "listAISandboxArtifacts").mockResolvedValue([]);

    render(
      <MemoryRouter>
        <AIConfigSection />
      </MemoryRouter>
    );

    const guidance = screen.getByRole("link", {
      name: "enable and configure Inference in General settings",
    });
    expect(guidance).toHaveAttribute("href", "/settings/general");

    act(() => {
      useSystemConfigStore.getState().setConfig({
        ...DEFAULT_SYSTEM_CONFIG,
        features: {
          ...DEFAULT_SYSTEM_CONFIG.features,
          inferenceEnabled: true,
        },
      });
    });

    await waitFor(() =>
      expect(
        screen.queryByRole("link", {
          name: "enable and configure Inference in General settings",
        })
      ).not.toBeInTheDocument()
    );
  });
});
