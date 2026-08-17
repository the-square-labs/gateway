import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { FinalizeSetupState } from "@/types";
import { IntegrationsSetupWizard } from "./IntegrationsSetupWizard";

vi.mock("@/services/api", () => ({
  api: {
    createCloudflareConnector: vi.fn(),
    createGitLabConnector: vi.fn(),
    createGitConnector: vi.fn(),
    getGitHubOAuthAvailability: vi.fn(),
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
  it("links to the Cloudflare API token creator from setup", async () => {
    const user = userEvent.setup();
    render(
      <IntegrationsSetupWizard
        open
        state={pendingState}
        onBack={vi.fn()}
        onStep={vi.fn().mockResolvedValue(undefined)}
      />
    );

    await user.click(screen.getByRole("button", { name: /Cloudflare/i }));

    expect(screen.getByRole("link", { name: "Create API token →" })).toHaveAttribute(
      "href",
      expect.stringContaining("dash.cloudflare.com/profile/api-tokens")
    );
  });

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
          allowlistEntries: [
            expect.objectContaining({ fullPath: "https://git.example.test/team/api" }),
          ],
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

  it("uses account-wide OAuth without repository fields in direct GitHub setup", async () => {
    vi.mocked(api.getGitHubOAuthAvailability).mockResolvedValue({ available: true });

    render(
      <IntegrationsSetupWizard
        open
        directSetup={{
          connector: "github",
          repositoryUrl: "https://github.com/acme/app",
        }}
        onFinished={vi.fn()}
      />
    );

    expect(screen.getByRole("dialog", { name: "Add GitHub connector" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "OAuth" })).toHaveAttribute("data-state", "active")
    );
    expect(screen.queryByText("GitHub URL")).not.toBeInTheDocument();
    expect(screen.queryByText("Repository URL")).not.toBeInTheDocument();
    const authorizationButton = screen.getByRole("button", {
      name: "Start GitHub authorization",
    });
    expect(authorizationButton).toBeEnabled();
    expect(authorizationButton.closest("[data-dialog-body]")).not.toBeNull();
  });

  it("creates account-wide GitHub token connectors without repository or username fields", async () => {
    const user = userEvent.setup();
    vi.mocked(api.getGitHubOAuthAvailability).mockResolvedValue({ available: true });
    vi.mocked(api.createGitConnector).mockResolvedValue({} as never);

    render(
      <IntegrationsSetupWizard
        open
        directSetup={{
          connector: "github",
          repositoryUrl: "https://github.com/acme/ignored",
        }}
        onFinished={vi.fn()}
      />
    );

    await waitFor(() => expect(screen.getByRole("tab", { name: "OAuth" })).toBeInTheDocument());
    await user.click(screen.getByRole("tab", { name: "Token" }));

    expect(screen.queryByText("Repository URL")).not.toBeInTheDocument();
    expect(document.querySelector('input[autocomplete="username"]')).not.toBeInTheDocument();
    const tokenInput = await waitFor(() => {
      const input = document.querySelector('input[type="password"]');
      expect(input).not.toBeNull();
      return input!;
    });
    fireEvent.change(tokenInput, {
      target: { value: "github-token" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save GitHub" }));

    await waitFor(() =>
      expect(api.createGitConnector).toHaveBeenCalledWith("github", {
        name: "GitHub",
        baseUrl: "https://github.com",
        enabled: true,
        token: "github-token",
      })
    );
  });
});
