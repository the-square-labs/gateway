import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigureAIWorkspaceWizard } from "./ConfigureAIWorkspaceWizard";

const mocks = vi.hoisted(() => ({
  getAIConfig: vi.fn(),
  refreshProviderStatus: vi.fn(),
  updateAIConfig: vi.fn(),
}));

vi.mock("@/services/api", () => ({
  api: { getAIConfig: mocks.getAIConfig, updateAIConfig: mocks.updateAIConfig },
}));

vi.mock("@/stores/ai", () => ({
  useAIStore: {
    getState: () => ({ refreshProviderStatus: mocks.refreshProviderStatus }),
  },
}));

vi.mock("./InferenceSetupWizard", () => ({
  InferenceSetupWizard: ({
    open,
    onConfigured,
    completionActionLabel,
  }: {
    open: boolean;
    onConfigured: () => Promise<void>;
    completionActionLabel?: string;
  }) =>
    open ? (
      <button type="button" onClick={() => void onConfigured()}>
        {completionActionLabel ?? "Back to checklist"}
      </button>
    ) : null,
}));

describe("ConfigureAIWorkspaceWizard", () => {
  beforeEach(() => {
    mocks.getAIConfig.mockReset().mockResolvedValue({ gatewayInferenceModels: [] });
    mocks.refreshProviderStatus.mockReset().mockResolvedValue(undefined);
    mocks.updateAIConfig.mockReset().mockResolvedValue(undefined);
  });

  it("keeps only Back on the initial interface-choice screen and restores Skip later", async () => {
    const user = userEvent.setup();
    render(
      <ConfigureAIWorkspaceWizard
        open
        initialStepCanSkip={false}
        onBack={vi.fn()}
        onConfigured={vi.fn()}
        onSkipped={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Skip" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /OAI-compatible provider/ }));

    expect(screen.getByRole("button", { name: "Skip" })).toBeInTheDocument();
  });

  it("uses the interface-choice completion action label", async () => {
    const user = userEvent.setup();
    const onConfigured = vi.fn().mockResolvedValue(undefined);
    render(
      <ConfigureAIWorkspaceWizard
        open
        initialStepCanSkip={false}
        completionActionLabel="Enable AI Workspace"
        onBack={vi.fn()}
        onConfigured={onConfigured}
        onSkipped={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /OAI-compatible provider/ }));
    const apiKey = document.querySelector<HTMLInputElement>('input[type="password"]');
    expect(apiKey).not.toBeNull();
    await user.type(apiKey!, "test-key");
    await user.type(screen.getByPlaceholderText("gpt-4.1-mini"), "test-model");
    await user.click(screen.getByRole("button", { name: "Save AI Workspace" }));

    const enable = await screen.findByRole("button", { name: "Enable AI Workspace" });
    await user.click(enable);

    expect(mocks.updateAIConfig).toHaveBeenCalledOnce();
    expect(onConfigured).toHaveBeenCalledWith("direct");
  });

  it("uses the shared model shell and enables operator model selection by default", async () => {
    mocks.getAIConfig.mockResolvedValue({
      gatewayInferenceModels: [{ id: "gateway-model", displayName: "Gateway Model" }],
    });
    const user = userEvent.setup();

    render(
      <ConfigureAIWorkspaceWizard
        open
        onBack={vi.fn()}
        onConfigured={vi.fn()}
        onSkipped={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /Gateway Inference Use centrally/ }));

    expect(await screen.findByRole("heading", { name: "Gateway Inference" })).toBeInTheDocument();
    expect(
      screen.getByText(
        "Model used when a Work Session starts. Operators can switch to another allowed model."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Default model" })).toHaveTextContent(
      "Gateway Model"
    );

    await user.click(screen.getByRole("button", { name: "Save AI Workspace" }));

    expect(mocks.updateAIConfig).toHaveBeenCalledWith({
      enabled: true,
      providerType: "gateway_inference",
      gatewayInferenceModel: "gateway-model",
      gatewayInferenceAllowUserModelSelection: true,
    });
    expect(screen.queryByText("Enable users in Gateway Inference")).not.toBeInTheDocument();
  });

  it("finishes AI Workspace directly after nested Inference setup", async () => {
    const onConfigured = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <ConfigureAIWorkspaceWizard
        open
        completionActionLabel="Continue to sign in"
        onBack={vi.fn()}
        onConfigured={onConfigured}
        onSkipped={vi.fn()}
      />
    );

    await user.click(screen.getByRole("button", { name: /Gateway Inference Use centrally/ }));
    await user.click(screen.getByRole("button", { name: "Configure Gateway Inference" }));
    await user.click(screen.getByRole("button", { name: "Continue to sign in" }));

    expect(onConfigured).toHaveBeenCalledWith("gateway_inference");
    expect(screen.queryByRole("combobox", { name: "Default model" })).not.toBeInTheDocument();
  });
});
