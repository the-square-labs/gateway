import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NumericInput } from "./numeric-input";

describe("NumericInput", () => {
  it("uses a single destructive border without a second focus ring", () => {
    render(<NumericInput aria-label="Limit" value={64} min={1} max={50} onChange={vi.fn()} />);

    const input = screen.getByRole("spinbutton", { name: "Limit" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveClass(
      "border-destructive",
      "focus-visible:border-destructive",
      "focus-visible:ring-0"
    );
    expect(input).not.toHaveClass("outline-destructive");
  });
});
