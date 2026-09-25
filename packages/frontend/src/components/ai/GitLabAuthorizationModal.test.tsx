import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { useAIStore } from "@/stores/ai";
import { renderWithRouter } from "@/test/render";
import { waitForReveal } from "@/test/reveal";
import type { GitLabUserCredentialStatus } from "@/types/integrations";
import { GitLabAuthorizationModal } from "./GitLabAuthorizationModal";

const defaultResolveCredentialChallenge = useAIStore.getState().resolveCredentialChallenge;

const challenge = {
  id: "challenge-1",
  runId: "run-1",
  conversationId: "conversation-1",
  userId: "user-1",
  provider: "gitlab" as const,
  connectorId: "connector-1",
  toolCallId: "call-1",
  toolName: "gitlab_read_file",
  status: "pending" as const,
  decisionClientCommandId: null,
  resolvedAt: null,
  createdAt: "2026-07-22T00:00:00.000Z",
  updatedAt: "2026-07-22T00:00:00.000Z",
};

const missingStatus: GitLabUserCredentialStatus = {
  connectorId: "connector-1",
  connectorName: "Main GitLab",
  baseUrl: "https://gitlab.example.com",
  patCreationUrl:
    "https://gitlab.example.com/-/user_settings/personal_access_tokens?name=Gateway%20AI",
  authorized: false,
  status: "missing",
  tokenMasked: null,
  gitlabUserId: null,
  gitlabUsername: null,
  tokenScopes: [],
  tokenExpiresAt: null,
  lastValidatedAt: null,
};

describe("GitLabAuthorizationModal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    act(() => {
      useAIStore.setState({
        pendingCredentialChallenge: null,
        resolveCredentialChallenge: defaultResolveCredentialChallenge,
      });
    });
  });

  it("keeps the PAT local, clears an invalid value, and lets the user retry or reject", async () => {
    const user = userEvent.setup();
    const resolveCredentialChallenge = vi.fn();
    vi.spyOn(api, "getGitLabUserCredentialStatus").mockResolvedValue(missingStatus);
    vi.spyOn(api, "authorizeGitLabUserCredential")
      .mockRejectedValueOnce(new Error("GitLab rejected this token"))
      .mockResolvedValueOnce({
        ...missingStatus,
        authorized: true,
        status: "valid",
        tokenMasked: "****good",
      });
    act(() => {
      useAIStore.setState({ pendingCredentialChallenge: challenge, resolveCredentialChallenge });
    });

    renderWithRouter(<GitLabAuthorizationModal />);

    expect(await screen.findByText("Main GitLab")).toBeInTheDocument();
    const explanation = screen.getByText(/Gateway needs your personal repository credential/);
    expect(explanation.closest("[data-dialog-body]")).toBeInTheDocument();
    expect(explanation.closest("[data-dialog-header]")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create personal access token/i })).toHaveAttribute(
      "href",
      missingStatus.patCreationUrl
    );
    const input = screen.getByLabelText("Personal access token");
    expect(input).toHaveAttribute("type", "password");

    await user.type(input, "glpat-invalid");
    await user.click(screen.getByRole("button", { name: "Authorize" }));
    expect(await screen.findByText("GitLab rejected this token")).toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(resolveCredentialChallenge).not.toHaveBeenCalled();

    await user.type(input, "glpat-good");
    await user.click(screen.getByRole("button", { name: "Authorize" }));
    await waitFor(() => expect(resolveCredentialChallenge).toHaveBeenCalledWith("authorized"));
    expect(api.authorizeGitLabUserCredential).toHaveBeenLastCalledWith("connector-1", "glpat-good");
  });

  it("resumes automatically when a reconnect finds an already authorized PAT", async () => {
    const resolveCredentialChallenge = vi.fn();
    vi.spyOn(api, "getGitLabUserCredentialStatus").mockResolvedValue({
      ...missingStatus,
      authorized: true,
      status: "valid",
      tokenMasked: "****good",
    });
    const authorize = vi.spyOn(api, "authorizeGitLabUserCredential");
    act(() => {
      useAIStore.setState({ pendingCredentialChallenge: challenge, resolveCredentialChallenge });
    });

    renderWithRouter(<GitLabAuthorizationModal />);

    await waitFor(() => expect(resolveCredentialChallenge).toHaveBeenCalledWith("authorized"));
    expect(authorize).not.toHaveBeenCalled();
  });

  it("collects username and token for a generic Git credential challenge", async () => {
    const user = userEvent.setup();
    const resolveCredentialChallenge = vi.fn();
    vi.spyOn(api, "getGitUserCredentialStatus").mockResolvedValue({
      provider: "git",
      connectorId: "connector-1",
      connectorName: "Private Git",
      baseUrl: "https://git.example.com",
      authorized: false,
      status: "missing",
      tokenMasked: null,
      username: null,
      authorizationUrl: null,
    });
    vi.spyOn(api, "authorizeGitUserCredential").mockResolvedValue({} as never);
    act(() => {
      useAIStore.setState({
        pendingCredentialChallenge: {
          ...challenge,
          provider: "git",
          toolName: "git_list_remote_refs",
        },
        resolveCredentialChallenge,
      });
    });

    renderWithRouter(<GitLabAuthorizationModal />);
    await screen.findByText("Private Git");
    await user.type(screen.getByLabelText("Username"), "deploy-user");
    await user.type(screen.getByLabelText("Access token or password"), "secret-token");
    await user.click(screen.getByRole("button", { name: "Authorize" }));

    expect(api.authorizeGitUserCredential).toHaveBeenCalledWith("git", "connector-1", {
      username: "deploy-user",
      token: "secret-token",
    });
    expect(resolveCredentialChallenge).toHaveBeenCalledWith("authorized");
  });

  it("opens once the connector details are in instead of filling them in later", async () => {
    let resolveStatus!: (status: GitLabUserCredentialStatus) => void;
    vi.spyOn(api, "getGitLabUserCredentialStatus").mockReturnValue(
      new Promise((resolve) => {
        resolveStatus = resolve;
      })
    );
    act(() => {
      useAIStore.setState({
        pendingCredentialChallenge: null,
        resolveCredentialChallenge: vi.fn(),
      });
    });

    // The modal stays mounted with the chat surface and opens when a tool asks for a credential.
    renderWithRouter(<GitLabAuthorizationModal />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    act(() => {
      useAIStore.setState({ pendingCredentialChallenge: challenge });
    });

    expect(screen.getByRole("dialog")).not.toHaveAttribute("data-reveal-phase", "revealed");
    expect(screen.queryByText("Loading connector details…")).not.toBeInTheDocument();

    await act(async () => resolveStatus(missingStatus));
    await waitForReveal();

    expect(screen.getByText("Main GitLab")).toBeInTheDocument();
    expect(screen.getByText("https://gitlab.example.com")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /create personal access token/i })).toBeVisible();
  });

  it("locks Authorize with a pending state while the credential is checked", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getGitLabUserCredentialStatus").mockResolvedValue(missingStatus);
    vi.spyOn(api, "authorizeGitLabUserCredential").mockReturnValue(new Promise(() => {}));
    act(() => {
      useAIStore.setState({
        pendingCredentialChallenge: challenge,
        resolveCredentialChallenge: vi.fn(),
      });
    });

    renderWithRouter(<GitLabAuthorizationModal />);
    await waitForReveal();

    await user.type(screen.getByLabelText("Personal access token"), "glpat-slow");
    await user.click(screen.getByRole("button", { name: "Authorize" }));

    const checking = screen.getByRole("button", { name: "Checking GitLab access…" });
    expect(checking).toBeDisabled();
    expect(checking).toHaveAttribute("aria-busy", "true");
    expect(api.authorizeGitLabUserCredential).toHaveBeenCalledTimes(1);
  });
});
