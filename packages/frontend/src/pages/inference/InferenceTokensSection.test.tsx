import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { InferenceTokensSection } from "./InferenceTokensSection";

vi.mock("@/services/api", () => ({
  api: {
    listInferenceTokens: vi.fn(),
    createInferenceToken: vi.fn(),
    revokeInferenceToken: vi.fn(),
  },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

describe("InferenceTokensSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listInferenceTokens).mockResolvedValue([]);
  });

  it("hides token creation without scope", async () => {
    render(<InferenceTokensSection canManage={false} />);
    await waitFor(() => expect(api.listInferenceTokens).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: /create token/i })).not.toBeInTheDocument();
    expect(
      screen.getByText("Inference API Tokens").parentElement?.querySelector("svg")
    ).not.toBeNull();
  });

  it("shows only active inference tokens", async () => {
    vi.mocked(api.listInferenceTokens).mockResolvedValue([
      {
        id: "active-token",
        name: "Active Codex",
        tokenPrefix: "gwi_active",
        status: "active",
        lastUsedAt: null,
        revokedAt: null,
        createdAt: "2026-07-24T00:00:00.000Z",
      },
      {
        id: "revoked-token",
        name: "Old Codex",
        tokenPrefix: "gwi_revoked",
        status: "revoked",
        lastUsedAt: null,
        revokedAt: "2026-07-25T00:00:00.000Z",
        createdAt: "2026-07-23T00:00:00.000Z",
      },
    ]);

    render(<InferenceTokensSection canManage />);

    expect(await screen.findByText("Active Codex")).toBeInTheDocument();
    expect(screen.queryByText("Old Codex")).not.toBeInTheDocument();
  });

  it("validates the name and shows a newly created secret once", async () => {
    vi.mocked(api.createInferenceToken).mockResolvedValue({
      id: "token-1",
      name: "Codex",
      tokenPrefix: "gwi_12345678",
      status: "active",
      lastUsedAt: null,
      revokedAt: null,
      createdAt: "2026-07-24T00:00:00.000Z",
      token: "gwi_secret-once",
    });
    render(<InferenceTokensSection canManage />);
    fireEvent.click(await screen.findByRole("button", { name: "Create Token" }));
    const submit = screen.getByRole("button", { name: "Create token" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Codex" } });
    fireEvent.click(submit);

    expect(await screen.findByText("gwi_secret-once")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByText("gwi_secret-once")).not.toBeInTheDocument());
  });
});
