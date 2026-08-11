import { act, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithRouter } from "@/test/render";
import { ConfirmDialog, useConfirmDialog } from "./ConfirmDialog";

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
});
