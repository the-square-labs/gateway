import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { confirm } from "@/components/common/ConfirmDialog";
import type { FinalizeSetupState } from "@/types";
import { FinalizeSetupDialog } from "./FinalizeSetupDialog";

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
    vi.mocked(confirm).mockResolvedValue(true);
  });

  it("routes a checklist item into its own wizard and confirms explicit dismissal", async () => {
    const onOpenWizard = vi.fn();
    const onDismiss = vi.fn();

    render(
      <FinalizeSetupDialog
        open
        state={pendingState}
        onOpenWizard={onOpenWizard}
        onDismiss={onDismiss}
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
    expect(onDismiss).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    await waitFor(() =>
      expect(confirm).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Skip the guided setup?",
          cancelLabel: "Continue setup",
          confirmLabel: "Skip checklist",
          locked: true,
        })
      )
    );
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
  });

  it("uses Finish after an actual configured outcome without showing the skip confirmation", async () => {
    const onDismiss = vi.fn();
    render(
      <FinalizeSetupDialog
        open
        state={{ ...pendingState, steps: { ...pendingState.steps, mfa: "configured" } }}
        onOpenWizard={vi.fn()}
        onDismiss={onDismiss}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Finish" }));
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(1));
    expect(confirm).not.toHaveBeenCalled();
  });

  it("marks integrations complete once either connector is configured", () => {
    render(
      <FinalizeSetupDialog
        open
        state={{
          ...pendingState,
          steps: { ...pendingState.steps, cloudflare: "configured" },
        }}
        onOpenWizard={vi.fn()}
        onDismiss={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: /Connect integrations/i })).toHaveTextContent(
      "Configured"
    );
  });

  it("only shows user invitations when a local sign-in method is enabled", () => {
    const props = {
      open: true,
      state: pendingState,
      onOpenWizard: vi.fn(),
      onDismiss: vi.fn(),
    };
    const { rerender } = render(<FinalizeSetupDialog {...props} />);

    expect(screen.queryByRole("button", { name: /Invite users/i })).not.toBeInTheDocument();

    rerender(<FinalizeSetupDialog {...props} canInviteUsers />);
    expect(screen.getByRole("button", { name: /Invite users/i })).toBeInTheDocument();
  });
});
