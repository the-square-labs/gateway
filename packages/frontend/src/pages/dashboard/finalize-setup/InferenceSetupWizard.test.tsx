import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { InferenceProviderCatalogItem } from "@/types/inference";
import { InferenceSetupWizard } from "./InferenceSetupWizard";

const systemConfigMocks = vi.hoisted(() => ({
  config: {
    fileUploadMaxBytes: 100 * 1024 * 1024,
    fileOpenMaxBytes: 10 * 1024 * 1024,
    gatewayGrpcPublicTarget: null,
    gatewayGrpcLocalIp: null,
    relayAutoRecovery: true,
    features: {
      pkiEnabled: true,
      domainsEnabled: true,
      siemEnabled: true,
      loggingEnabled: false,
      inferenceEnabled: false,
    },
  },
  setConfig: vi.fn(),
}));

const aiStoreMocks = vi.hoisted(() => ({
  refreshProviderStatus: vi.fn(),
}));

vi.mock("@/stores/system-config", () => ({
  useSystemConfigStore: (selector: (state: unknown) => unknown) =>
    selector({ config: systemConfigMocks.config, setConfig: systemConfigMocks.setConfig }),
}));

vi.mock("@/stores/ai", () => ({
  useAIStore: {
    getState: () => ({ refreshProviderStatus: aiStoreMocks.refreshProviderStatus }),
  },
}));

const provider: InferenceProviderCatalogItem = {
  id: "openai",
  label: "ChatGPT subscription",
  family: "openai",
  wireProtocol: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authTypes: ["oauth"],
  subscription: true,
  featured: true,
  oauthFlow: "redirect",
  completionMode: "paste_callback",
};

const readyModel = {
  id: "model-id",
  publicId: "gpt-5-6-luna",
  displayName: "GPT-5.6-Luna",
  enabled: true,
  contextWindow: 128_000,
  maxInputTokens: 128_000,
  maxOutputTokens: 8_192,
  autoCompactTokenLimit: 100_000,
  modalities: ["text"],
  capabilities: {},
  configuredCapabilities: {},
  capabilityLimitations: {},
  reasoningEfforts: ["high"],
  defaultReasoningEffort: "high",
  defaultAccessAllowed: true,
  accessMode: "everyone" as const,
  accessSubjects: [],
  subscriptionMultiplier: 1,
  sources: [],
  accessRules: [],
};

describe("InferenceSetupWizard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    systemConfigMocks.config.features.inferenceEnabled = false;
    systemConfigMocks.setConfig.mockReset();
    aiStoreMocks.refreshProviderStatus.mockReset().mockResolvedValue(undefined);
  });

  it("loads the provider catalog during enable without waiting for a store rerender", async () => {
    vi.spyOn(api, "getAuthProvisioningSettings").mockResolvedValue({
      generalSettings: {
        features: { ...systemConfigMocks.config.features, inferenceEnabled: false },
      },
    } as never);
    vi.spyOn(api, "updateAuthProvisioningSettings").mockResolvedValue({
      generalSettings: {
        features: { ...systemConfigMocks.config.features, inferenceEnabled: true },
      },
    } as never);
    vi.spyOn(api, "listInferenceLimits").mockResolvedValue([]);
    vi.spyOn(api, "setInferenceDefaultLimits").mockResolvedValue([] as never);
    const listCatalog = vi.spyOn(api, "listInferenceProviderCatalog").mockResolvedValue([provider]);
    vi.spyOn(api, "listInferenceProviderConnections").mockResolvedValue([]);
    vi.spyOn(api, "listInferenceModels").mockResolvedValue([]);
    const user = userEvent.setup();
    render(
      <InferenceSetupWizard open onBack={vi.fn()} onConfigured={vi.fn()} onSkipped={vi.fn()} />
    );

    await user.click(screen.getByRole("button", { name: "Enable Inference" }));

    await waitFor(() => expect(listCatalog).toHaveBeenCalledOnce());
    expect(systemConfigMocks.setConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        features: expect.objectContaining({ inferenceEnabled: true }),
      })
    );
  });

  it("assigns the configured model to AI Workspace without a second model step", async () => {
    systemConfigMocks.config.features.inferenceEnabled = true;
    vi.spyOn(api, "listInferenceProviderCatalog").mockResolvedValue([provider]);
    vi.spyOn(api, "listInferenceProviderConnections").mockResolvedValue([]);
    vi.spyOn(api, "listInferenceModels").mockResolvedValue([readyModel]);
    vi.spyOn(api, "listInferenceLimits").mockResolvedValue([]);
    vi.spyOn(api, "setInferenceDefaultLimits").mockResolvedValue([] as never);
    const updateAIConfig = vi.spyOn(api, "updateAIConfig").mockResolvedValue({} as never);
    const onConfigured = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <InferenceSetupWizard
        open
        completionActionLabel="Continue to sign in"
        onBack={vi.fn()}
        onConfigured={onConfigured}
        onSkipped={vi.fn()}
      />
    );

    await user.click(await screen.findByRole("button", { name: "Complete Inference setup" }));

    expect(updateAIConfig).toHaveBeenCalledWith({
      enabled: true,
      providerType: "gateway_inference",
      gatewayInferenceModel: "gpt-5-6-luna",
      gatewayInferenceAllowUserModelSelection: true,
    });
    expect(await screen.findByText("AI Workspace is ready")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Continue to sign in" }));
    expect(onConfigured).toHaveBeenCalledOnce();
  });

  it("assigns a newly added Inference model before showing setup completion", async () => {
    systemConfigMocks.config.features.inferenceEnabled = true;
    vi.spyOn(api, "listInferenceProviderCatalog").mockResolvedValue([provider]);
    vi.spyOn(api, "listInferenceProviderConnections").mockResolvedValue([
      {
        id: "connection-id",
        providerId: "openai",
        name: "ChatGPT test",
        authType: "oauth",
        discoveredModels: [
          {
            id: "discovered-id",
            remoteModelId: "gpt-5.6-luna",
            displayName: "GPT-5.6-Luna",
            available: true,
            contextWindow: 128_000,
            maxInputTokens: 128_000,
            maxOutputTokens: 8_192,
            autoCompactTokenLimit: 100_000,
            modalities: ["text"],
            capabilities: {},
            reasoningEfforts: ["high"],
            metadata: {},
          },
        ],
      } as never,
    ]);
    vi.spyOn(api, "listInferenceModels")
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([readyModel]);
    vi.spyOn(api, "saveInferenceModelConfiguration").mockResolvedValue({} as never);
    vi.spyOn(api, "listInferenceLimits").mockResolvedValue([]);
    vi.spyOn(api, "setInferenceDefaultLimits").mockResolvedValue([] as never);
    const updateAIConfig = vi.spyOn(api, "updateAIConfig").mockResolvedValue({} as never);

    render(
      <InferenceSetupWizard open onBack={vi.fn()} onConfigured={vi.fn()} onSkipped={vi.fn()} />
    );

    const modelSelect = await screen.findByRole("combobox");
    fireEvent.click(modelSelect);
    fireEvent.click(await screen.findByRole("option", { name: "ChatGPT test · GPT-5.6-Luna" }));
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));

    await waitFor(() =>
      expect(updateAIConfig).toHaveBeenCalledWith({
        enabled: true,
        providerType: "gateway_inference",
        gatewayInferenceModel: "gpt-5-6-luna",
        gatewayInferenceAllowUserModelSelection: true,
      })
    );
    expect(await screen.findByText("AI Workspace is ready")).toBeInTheDocument();
  });
});
