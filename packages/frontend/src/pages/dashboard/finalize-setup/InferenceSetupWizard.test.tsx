import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAuthStore } from "@/stores/auth";
import { makeUser } from "@/test/fixtures";
import type { InferenceProviderCatalogItem } from "@/types/inference";
import type { InferenceCoreStatus } from "@/types/inference-core";
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

const readyCoreStatus: InferenceCoreStatus = {
  state: "ready",
  installed: {
    version: "2.26.0-wiolett.1",
    digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    imageRef: "core@sha256:0123",
  },
  latest: null,
  compatibility: "compatible",
  health: {
    status: "healthy",
    version: "2.26.0-wiolett.1",
    coreProtocolMajor: 1,
    stateSchemaVersion: 1,
    checkedAt: "2026-08-19T08:00:00.000Z",
  },
  operation: null,
  lastError: null,
};

const notInstalledCoreStatus: InferenceCoreStatus = {
  ...readyCoreStatus,
  state: "not_installed",
  installed: null,
  compatibility: "unknown",
  health: {
    status: "unknown",
    version: null,
    coreProtocolMajor: null,
    stateSchemaVersion: null,
    checkedAt: null,
  },
  latest: {
    version: "2.26.0-wiolett.1",
    digest: "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    sizeBytes: 412345678,
    releaseNotesUrl: null,
  },
};

const undiscoveredCoreStatus: InferenceCoreStatus = {
  ...notInstalledCoreStatus,
  latest: null,
};

const failedCoreStatus: InferenceCoreStatus = {
  ...notInstalledCoreStatus,
  state: "failed",
  lastError: "core reported failed readiness",
};

const installingCoreStatus: InferenceCoreStatus = {
  ...notInstalledCoreStatus,
  state: "starting",
  operation: {
    id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    kind: "install",
    phase: "starting",
    status: "running",
    progress: { stage: "Checking readiness" },
    fromVersion: null,
    toVersion: "2.26.0-wiolett.1",
    fromDigest: null,
    toDigest: notInstalledCoreStatus.latest?.digest ?? null,
    error: null,
    startedAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:20.000Z",
    finishedAt: null,
  },
};

describe("InferenceSetupWizard", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    systemConfigMocks.config.features.inferenceEnabled = false;
    systemConfigMocks.setConfig.mockReset();
    aiStoreMocks.refreshProviderStatus.mockReset().mockResolvedValue(undefined);
    useAuthStore.setState({
      user: makeUser({ scopes: ["inference:providers:manage"] }),
      isAuthenticated: true,
      isLoading: false,
    });
    vi.spyOn(api, "getInferenceCoreStatus").mockResolvedValue(readyCoreStatus);
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
            autoCompactTokenLimit: 180_000,
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
    const saveConfiguration = vi
      .spyOn(api, "saveInferenceModelConfiguration")
      .mockResolvedValue({} as never);
    vi.spyOn(api, "listInferenceLimits").mockResolvedValue([]);
    vi.spyOn(api, "setInferenceDefaultLimits").mockResolvedValue([] as never);
    const updateAIConfig = vi.spyOn(api, "updateAIConfig").mockResolvedValue({} as never);

    render(
      <InferenceSetupWizard open onBack={vi.fn()} onConfigured={vi.fn()} onSkipped={vi.fn()} />
    );

    const modelSelect = await screen.findByRole("combobox");
    fireEvent.click(modelSelect);
    fireEvent.click(await screen.findByRole("option", { name: "GPT-5.6-Luna" }));
    fireEvent.click(screen.getByRole("button", { name: "Add model" }));

    await waitFor(() =>
      expect(saveConfiguration).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          model: expect.objectContaining({ autoCompactTokenLimit: 128_000 }),
        })
      )
    );
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

  it("shows the shared core step before provider setup and keeps Skip available", async () => {
    systemConfigMocks.config.features.inferenceEnabled = true;
    vi.spyOn(api, "getInferenceCoreStatus").mockResolvedValue(notInstalledCoreStatus);
    vi.spyOn(api, "listInferenceProviderCatalog").mockResolvedValue([provider]);
    vi.spyOn(api, "listInferenceProviderConnections").mockResolvedValue([]);
    vi.spyOn(api, "listInferenceModels").mockResolvedValue([]);
    const onSkipped = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();

    render(
      <InferenceSetupWizard open onBack={vi.fn()} onConfigured={vi.fn()} onSkipped={onSkipped} />
    );

    expect(await screen.findByText("Not installed")).toBeInTheDocument();
    const installButton = screen.getByRole("button", { name: /Install inference core/ });
    expect(installButton).toBeInTheDocument();
    expect(installButton.closest("[data-setup-footer]")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect provider" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(onSkipped).toHaveBeenCalledOnce();
  });

  it("discovers the release and exposes install from the browser setup session", async () => {
    systemConfigMocks.config.features.inferenceEnabled = true;
    useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });
    vi.spyOn(api, "getInferenceCoreStatus")
      .mockResolvedValueOnce(undiscoveredCoreStatus)
      .mockResolvedValue(notInstalledCoreStatus);
    const checkUpdates = vi.spyOn(api, "checkInferenceCoreUpdates").mockResolvedValue({
      latest: notInstalledCoreStatus.latest,
    });
    vi.spyOn(api, "listInferenceProviderCatalog").mockResolvedValue([provider]);
    vi.spyOn(api, "listInferenceProviderConnections").mockResolvedValue([]);
    vi.spyOn(api, "listInferenceModels").mockResolvedValue([]);

    render(
      <InferenceSetupWizard
        open
        canManageCoreOverride
        onBack={vi.fn()}
        onConfigured={vi.fn()}
        onSkipped={vi.fn()}
      />
    );

    expect(await screen.findByText("2.26.0-wiolett.1")).toBeInTheDocument();
    expect(checkUpdates).toHaveBeenCalledOnce();
    expect(screen.getByText(/393\.2/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Install inference core/ })).toBeInTheDocument();
  });

  it("installs the core in place and continues to providers once running", async () => {
    systemConfigMocks.config.features.inferenceEnabled = true;
    const getStatus = vi
      .spyOn(api, "getInferenceCoreStatus")
      .mockResolvedValueOnce(notInstalledCoreStatus)
      .mockResolvedValue(readyCoreStatus);
    vi.spyOn(api, "listInferenceProviderCatalog").mockResolvedValue([provider]);
    vi.spyOn(api, "listInferenceProviderConnections").mockResolvedValue([]);
    vi.spyOn(api, "listInferenceModels").mockResolvedValue([]);
    const install = vi.spyOn(api, "installInferenceCore").mockResolvedValue({
      operation: {
        id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        kind: "install",
        phase: "resolving",
        status: "running",
        progress: null,
        fromVersion: null,
        toVersion: "2.26.0-wiolett.1",
        fromDigest: null,
        toDigest: null,
        error: null,
        startedAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:00:00.000Z",
        finishedAt: null,
      },
    });
    const user = userEvent.setup();

    render(
      <InferenceSetupWizard open onBack={vi.fn()} onConfigured={vi.fn()} onSkipped={vi.fn()} />
    );

    await user.click(await screen.findByRole("button", { name: /Install inference core/ }));
    await waitFor(() => expect(install).toHaveBeenCalledOnce());

    const continueButton = await screen.findByRole("button", { name: /Continue to providers/ });
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(continueButton.closest("[data-setup-footer]")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();
    await user.click(continueButton);

    expect(await screen.findByText("Inference providers")).toBeInTheDocument();
    expect(getStatus.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("renders Retry install as the setup footer primary action", async () => {
    systemConfigMocks.config.features.inferenceEnabled = true;
    vi.spyOn(api, "getInferenceCoreStatus").mockResolvedValue(failedCoreStatus);
    vi.spyOn(api, "listInferenceProviderCatalog").mockResolvedValue([provider]);
    vi.spyOn(api, "listInferenceProviderConnections").mockResolvedValue([]);
    vi.spyOn(api, "listInferenceModels").mockResolvedValue([]);

    render(
      <InferenceSetupWizard open onBack={vi.fn()} onConfigured={vi.fn()} onSkipped={vi.fn()} />
    );

    const retryButton = await screen.findByRole("button", { name: /Retry install/ });
    expect(retryButton.closest("[data-setup-footer]")).toBeInTheDocument();
    expect(screen.getByText("core reported failed readiness")).toBeInTheDocument();
  });

  it("keeps the active lifecycle stage as a disabled footer primary", async () => {
    systemConfigMocks.config.features.inferenceEnabled = true;
    vi.spyOn(api, "getInferenceCoreStatus").mockResolvedValue(installingCoreStatus);
    vi.spyOn(api, "listInferenceProviderCatalog").mockResolvedValue([provider]);
    vi.spyOn(api, "listInferenceProviderConnections").mockResolvedValue([]);
    vi.spyOn(api, "listInferenceModels").mockResolvedValue([]);

    render(
      <InferenceSetupWizard open onBack={vi.fn()} onConfigured={vi.fn()} onSkipped={vi.fn()} />
    );

    const progressButton = await screen.findByRole("button", { name: /Checking readiness/ });
    expect(progressButton).toBeDisabled();
    expect(progressButton.closest("[data-setup-footer]")).toBeInTheDocument();
  });
});
