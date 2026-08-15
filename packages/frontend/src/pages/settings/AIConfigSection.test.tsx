import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  allowUserReasoningEffortSelection: false,
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
    vi.unstubAllGlobals();
    api.invalidateCache("settings:ai-config");
    useSystemConfigStore.getState().reset();
  });

  it("links to General settings only while inference is disabled", async () => {
    api.setCache("settings:ai-config", AI_CONFIG);
    vi.spyOn(api, "getAIConfig").mockResolvedValue(AI_CONFIG);
    vi.spyOn(api, "listAISkills").mockResolvedValue([]);
    vi.spyOn(api, "listAISandboxJobs").mockResolvedValue([]);
    vi.spyOn(api, "listAISandboxArtifacts").mockResolvedValue({ data: [], nextPage: null });

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

  it("keeps reasoning controls in the OAI-compatible provider block", async () => {
    api.setCache("settings:ai-config", AI_CONFIG);
    vi.spyOn(api, "getAIConfig").mockResolvedValue(AI_CONFIG);
    vi.spyOn(api, "listAISkills").mockResolvedValue([]);
    vi.spyOn(api, "listAISandboxJobs").mockResolvedValue([]);
    vi.spyOn(api, "listAISandboxArtifacts").mockResolvedValue({ data: [], nextPage: null });

    render(
      <MemoryRouter>
        <AIConfigSection />
      </MemoryRouter>
    );

    expect(await screen.findByText("Default reasoning effort")).toBeInTheDocument();
    expect(screen.getByText("User reasoning selection")).toBeInTheDocument();
  });

  it("hides direct-provider reasoning controls for Gateway Inference", async () => {
    const gatewayConfig = {
      ...AI_CONFIG,
      providerType: "gateway_inference" as const,
      gatewayInferenceModel: "gateway-model",
      gatewayInferenceModels: [
        {
          id: "gateway-model",
          displayName: "Gateway model",
          supportsImages: false,
          maxContextTokens: 128_000,
          maxOutputTokens: 16_000,
          reasoningEfforts: ["low", "high"],
          defaultReasoningEffort: "high",
        },
      ],
    };
    useSystemConfigStore.getState().setConfig({
      ...DEFAULT_SYSTEM_CONFIG,
      features: { ...DEFAULT_SYSTEM_CONFIG.features, inferenceEnabled: true },
    });
    api.setCache("settings:ai-config", gatewayConfig);
    vi.spyOn(api, "getAIConfig").mockResolvedValue(gatewayConfig);
    vi.spyOn(api, "listAISkills").mockResolvedValue([]);
    vi.spyOn(api, "listAISandboxJobs").mockResolvedValue([]);
    vi.spyOn(api, "listAISandboxArtifacts").mockResolvedValue({ data: [], nextPage: null });

    render(
      <MemoryRouter>
        <AIConfigSection />
      </MemoryRouter>
    );

    expect(await screen.findByText("User model selection")).toBeInTheDocument();
    expect(screen.queryByText("Default reasoning effort")).not.toBeInTheDocument();
    expect(screen.queryByText("User reasoning selection")).not.toBeInTheDocument();
  });

  it("shows 10 recent artifacts and lazily loads the full list after View all", async () => {
    api.setCache("settings:ai-config", AI_CONFIG);
    vi.spyOn(api, "getAIConfig").mockResolvedValue(AI_CONFIG);
    vi.spyOn(api, "listAISkills").mockResolvedValue([]);
    vi.spyOn(api, "listAISandboxJobs").mockResolvedValue([]);
    const listArtifacts = vi
      .spyOn(api, "listAISandboxArtifacts")
      .mockImplementation(async (options) => {
        if (options?.limit === 10) {
          return {
            data: Array.from({ length: 10 }, (_, index) => artifact(`recent-${index}`)),
            nextPage: 2,
          };
        }
        if (options?.page === 2) {
          return { data: [artifact("older")], nextPage: null };
        }
        return { data: [artifact("all-first")], nextPage: 2 };
      });
    let intersectionCallback: IntersectionObserverCallback | undefined;
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(callback: IntersectionObserverCallback) {
          intersectionCallback = callback;
        }
        observe() {}
        disconnect() {}
      }
    );

    render(
      <MemoryRouter>
        <AIConfigSection />
      </MemoryRouter>
    );

    expect(await screen.findByText("recent-9.txt")).toBeInTheDocument();
    expect(listArtifacts).toHaveBeenCalledWith({ page: 1, limit: 10 });

    fireEvent.click(screen.getByRole("button", { name: "View all" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText(/Scroll to load older artifacts/)).toHaveLength(2);
    await waitFor(() => expect(listArtifacts).toHaveBeenCalledWith({ page: 1, limit: 25 }));

    await waitFor(() => expect(intersectionCallback).toBeDefined());
    act(() => {
      intersectionCallback?.(
        [{ isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver
      );
    });

    await waitFor(() => expect(listArtifacts).toHaveBeenCalledWith({ page: 2, limit: 25 }));
  });
});

function artifact(id: string) {
  return {
    id,
    userId: "user-1",
    conversationId: null,
    conversationTitle: null,
    sourceProcessId: "process-1",
    sourcePath: `${id}.txt`,
    filename: `${id}.txt`,
    mediaType: "text/plain",
    sizeBytes: 10,
    createdAt: "2026-08-13T10:00:00.000Z",
    downloadUrl: `/api/ai/sandbox/artifacts/${id}/download`,
  };
}
