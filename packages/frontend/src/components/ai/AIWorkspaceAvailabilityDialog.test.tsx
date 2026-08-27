import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AIWorkspaceAvailabilityDialog } from "./AIWorkspaceAvailabilityDialog";

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (
    <div data-testid="dialog" data-open={String(open)}>
      {children}
    </div>
  ),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

describe("AIWorkspaceAvailabilityDialog", () => {
  it("retains the access-required content while the dialog closes", () => {
    const props = {
      onClose: vi.fn(),
      onConfigure: vi.fn(),
    };
    const { rerender } = render(<AIWorkspaceAvailabilityDialog state="no_access" {...props} />);

    expect(
      screen.getByRole("heading", { name: "AI Workspace access required" })
    ).toBeInTheDocument();

    rerender(<AIWorkspaceAvailabilityDialog state={null} {...props} />);

    expect(screen.getByTestId("dialog")).toHaveAttribute("data-open", "false");
    expect(
      screen.getByRole("heading", { name: "AI Workspace access required" })
    ).toBeInTheDocument();
    expect(screen.queryByText("AI Workspace is not configured")).not.toBeInTheDocument();
  });
});
