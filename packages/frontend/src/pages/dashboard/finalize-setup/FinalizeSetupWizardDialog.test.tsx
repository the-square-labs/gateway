import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { describe, expect, it, vi } from "vitest";
import { FinalizeSetupWizardDialog } from "./FinalizeSetupWizardDialog";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

describe("FinalizeSetupWizardDialog", () => {
  it("keeps the wizard locked and reports a failed explicit skip through a toast", async () => {
    const onSkip = vi.fn().mockRejectedValue(new Error("Could not save onboarding progress"));

    render(
      <FinalizeSetupWizardDialog
        open
        title="Configure an essential"
        description="A guided setup flow"
        stepKey="first"
        onSkip={onSkip}
      >
        <p>Step content</p>
      </FinalizeSetupWizardDialog>
    );

    expect(screen.queryByRole("button", { name: "Close" })).not.toBeInTheDocument();
    expect(screen.getByText("A guided setup flow").closest("[data-dialog-header-slot]")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Configure an essential" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Skip" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Could not save onboarding progress")
    );
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it("exposes an explicit close control only when the flow provides a close handler", () => {
    const onClose = vi.fn();

    render(
      <FinalizeSetupWizardDialog
        open
        title="Configure MFA"
        description="Secure the account"
        stepKey="method"
        onClose={onClose}
      >
        <p>Step content</p>
      </FinalizeSetupWizardDialog>
    );

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
