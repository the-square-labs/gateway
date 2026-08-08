import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm } from "@/components/common/ConfirmDialog";
import type { FinalizeSetupState } from "@/types";
import { FinalizeSetupDialog, finalizeSetupSkipPromptStorageKey } from "./FinalizeSetupDialog";

vi.mock("@/components/common/ConfirmDialog", () => ({
  confirm: vi.fn(),
}));

const pendingState: FinalizeSetupState = {
  steps: {
    nodes: "pending",
    ai_assistant: "pending",
    inference: "pending",
    cloudflare: "pending",
    gitlab: "pending",
    mfa: "pending",
    invite_users: "pending",
  },
};

describe("FinalizeSetupDialog", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.mocked(confirm).mockResolvedValue(true);
  });

  it("routes a checklist item into its own wizard and confirms the first skip-for-now action", async () => {
    const onOpenWizard = vi.fn();
    const onSkipForNow = vi.fn();

    render(
      <FinalizeSetupDialog
        open
        state={pendingState}
        userId="owner-1"
        onOpenWizard={onOpenWizard}
        onSkipForNow={onSkipForNow}
        onFinish={vi.fn()}
      />
    );

    expect(screen.getByRole("dialog", { name: "Finalize Gateway setup" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Gateway is ready to use/i).closest("[data-dialog-header-slot]")
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Connect your first node/i }));
    expect(onOpenWizard).toHaveBeenCalledWith("nodes");
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onSkipForNow).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Skip setup for now?",
          cancelLabel: "Continue setup",
          confirmLabel: "Skip for now",
          locked: true,
        })
      )
    );
    await waitFor(() => expect(onSkipForNow).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem(finalizeSetupSkipPromptStorageKey("owner-1"))).toBe("true");
  });

  it("uses Finish only after every item has an outcome without showing the skip confirmation", async () => {
    const onFinish = vi.fn();
    render(
      <FinalizeSetupDialog
        open
        state={{
          ...pendingState,
          steps: Object.fromEntries(
            Object.keys(pendingState.steps).map((step) => [step, "configured"])
          ) as FinalizeSetupState["steps"],
        }}
        userId="owner-1"
        onOpenWizard={vi.fn()}
        onSkipForNow={vi.fn()}
        onFinish={onFinish}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    expect(onFinish).toHaveBeenCalledTimes(1);
    expect(confirm).not.toHaveBeenCalled();
  });

  it("closes without another warning after the first skip was acknowledged", async () => {
    const onSkipForNow = vi.fn();
    window.localStorage.setItem(finalizeSetupSkipPromptStorageKey("owner-1"), "true");
    render(
      <FinalizeSetupDialog
        open
        state={pendingState}
        userId="owner-1"
        onOpenWizard={vi.fn()}
        onSkipForNow={onSkipForNow}
        onFinish={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));
    await waitFor(() => expect(onSkipForNow).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps integrations in progress until both connectors have an outcome", () => {
    render(
      <FinalizeSetupDialog
        open
        state={{
          ...pendingState,
          steps: { ...pendingState.steps, cloudflare: "configured" },
        }}
        userId="owner-1"
        onOpenWizard={vi.fn()}
        onSkipForNow={vi.fn()}
        onFinish={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /Connect integrations/i })).toHaveTextContent(
      "In progress"
    );
  });

  it("only shows user invitations when a local sign-in method is enabled", () => {
    const props = {
      open: true,
      state: pendingState,
      userId: "owner-1",
      onOpenWizard: vi.fn(),
      onSkipForNow: vi.fn(),
      onFinish: vi.fn(),
    };
    const { rerender } = render(<FinalizeSetupDialog {...props} />);

    expect(screen.queryByRole("button", { name: /Invite users/i })).not.toBeInTheDocument();

    rerender(<FinalizeSetupDialog {...props} canInviteUsers />);
    expect(screen.getByRole("button", { name: /Invite users/i })).toBeInTheDocument();
  });
});
