import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { FinalizeSetupState } from "@/types";
import { IntegrationsSetupWizard } from "./IntegrationsSetupWizard";

vi.mock("@/services/api", () => ({
  api: {
    createCloudflareConnector: vi.fn(),
    createGitLabConnector: vi.fn(),
    createGitConnector: vi.fn(),
  },
}));

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

const pendingState: FinalizeSetupState = {
  steps: {
    nodes: "pending",
    ai_workspace: "pending",
    cloudflare: "pending",
    gitlab: "pending",
    mfa: "pending",
    invite_users: "pending",
  },
};

describe("IntegrationsSetupWizard", () => {
  it("opens the requested Git connector directly for an assistant handoff", async () => {
    vi.mocked(api.createGitConnector).mockResolvedValue({} as never);
    const onFinished = vi.fn();

    render(
      <IntegrationsSetupWizard
        open
        directSetup={{
          connector: "git",
          baseUrl: "https://git.example.test",
          repositoryUrl: "https://git.example.test/team/api",
        }}
        onFinished={onFinished}
      />
    );

    expect(screen.getByRole("dialog", { name: "Add Git connector" })).toBeInTheDocument();
    expect(screen.queryByText("Connect integrations")).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("https://git.example.test")).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://git.example.test/team/api")).toBeInTheDocument();

    fireEvent.change(document.querySelector('input[autocomplete="username"]')!, {
      target: { value: "deploy-user" },
    });
    fireEvent.change(document.querySelector('input[type="password"]')!, {
      target: { value: "test-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save Git connector" }));

    await waitFor(() =>
      expect(api.createGitConnector).toHaveBeenCalledWith(
        "git",
        expect.objectContaining({
          username: "deploy-user",
          repositoryMode: "single_repository",
          repositoryUrl: "https://git.example.test/team/api",
        })
      )
    );
    expect(screen.getByText("Git connector connected")).toBeInTheDocument();
    expect(onFinished).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Continue scenario" }));
    expect(onFinished).toHaveBeenCalledWith("configured");
  });

  it("lists GitHub and generic Git in the Finalize Setup integrations flow", () => {
    render(
      <IntegrationsSetupWizard
        open
        state={pendingState}
        onBack={vi.fn()}
        onStep={vi.fn().mockResolvedValue(undefined)}
      />
    );

    expect(screen.getByRole("button", { name: /GitHub/i })).toHaveTextContent("Optional");
    expect(screen.getByRole("button", { name: /^Git /i })).toHaveTextContent("Optional");
  });
});
