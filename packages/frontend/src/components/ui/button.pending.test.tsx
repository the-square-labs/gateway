import { render, screen } from "@testing-library/react";
import { Save } from "lucide-react";
import { describe, expect, it } from "vitest";
import { Button } from "./button";

describe("Button pending", () => {
  it("disables the button and puts the spinner in place of the leading icon", () => {
    render(
      <Button pending>
        <Save data-testid="icon" />
        Save
      </Button>
    );
    const button = screen.getByRole("button", { name: "Save" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button.querySelector("[data-pending-spinner] + svg")).toBe(screen.getByTestId("icon"));
    expect(button.className).toContain("[&>[data-pending-spinner]+svg]:hidden");
  });
});
