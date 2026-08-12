import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { ConfirmDialog, confirmAction, useConfirmDialog } from "./ConfirmDialog";

describe("ConfirmDialog", () => {
  afterEach(() => {
    act(() => useConfirmDialog.getState().close());
  });

  it("renders the confirmation message as modal body copy instead of a header subtitle", () => {
    renderWithRouter(<ConfirmDialog />);

    act(() => {
      useConfirmDialog.getState().show({
        title: "Enable AI bypass delete approvals?",
        description:
          "AI Workspace will create, modify, and delete resources without asking for your confirmation.",
        onConfirm: vi.fn(),
      });
    });

    const description = screen.getByText(
      "AI Workspace will create, modify, and delete resources without asking for your confirmation."
    );

    expect(description.closest("[data-dialog-body]")).toBeInTheDocument();
    expect(description.closest("[data-dialog-header]")).not.toBeInTheDocument();
  });

  it("can require an explicit choice for guided setup confirmations", () => {
    renderWithRouter(<ConfirmDialog />);

    act(() => {
      useConfirmDialog.getState().show({
        title: "Skip the guided setup?",
        description: "Continue through the setup checklist or dismiss it.",
        locked: true,
        onConfirm: vi.fn(),
      });
    });

    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
  });

  it("keeps an async confirmation open and locked while its action is pending", async () => {
    const user = userEvent.setup();
    let resolveAction!: () => void;
    const action = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveAction = resolve;
        })
    );
    renderWithRouter(<ConfirmDialog />);

    const result = confirmAction(
      { title: "Delete Proxy Host", description: "Remove it?", confirmLabel: "Delete" },
      action
    );
    await user.click(await screen.findByRole("button", { name: "Delete" }));

    expect(action).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();

    resolveAction();
    await expect(result).resolves.toBe(true);
    await waitFor(() => expect(screen.queryByText("Delete Proxy Host")).not.toBeInTheDocument());
  });
});
