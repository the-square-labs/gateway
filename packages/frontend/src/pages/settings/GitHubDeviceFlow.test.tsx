import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { GitHubDeviceFlow } from "./GitHubDeviceFlow";

vi.mock("@/services/api", () => ({
  api: {
    startGitHubOAuth: vi.fn(),
    getGitHubOAuthStatus: vi.fn(),
    cancelGitHubOAuth: vi.fn().mockResolvedValue({}),
  },
}));

describe("GitHubDeviceFlow", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows the device code before opening GitHub and only opens on explicit click", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    vi.mocked(api.startGitHubOAuth).mockResolvedValue({
      id: "oauth-1",
      status: "pending",
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      pollIntervalSeconds: 60,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      connectorId: null,
      errorMessage: null,
    });

    render(
      <GitHubDeviceFlow
        request={{
          name: "GitHub",
          baseUrl: "https://github.com",
          enabled: true,
          repositoryMode: "single_repository",
          repositoryUrl: "https://github.com/acme/app",
        }}
        onCompleted={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Start GitHub authorization" }));
    expect(await screen.findByText("ABCD-EFGH")).toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Open GitHub" }));
    expect(open).toHaveBeenCalledWith(
      "https://github.com/login/device",
      "_blank",
      "noopener,noreferrer"
    );
  });
});
