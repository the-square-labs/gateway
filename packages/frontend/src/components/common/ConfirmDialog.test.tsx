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
          "The AI assistant will create, modify, and delete resources without asking for your confirmation.",
        onConfirm: vi.fn(),
      });
    });

    const description = screen.getByText(
      "The AI assistant will create, modify, and delete resources without asking for your confirmation."
    );

    expect(description.closest("[data-dialog-body]")).toBeInTheDocument();
    expect(description.closest("[data-dialog-header]")).not.toBeInTheDocument();
  });
});
