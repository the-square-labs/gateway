import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PoweredByFooter } from "./PoweredByFooter";

describe("PoweredByFooter", () => {
  it("restarts the shared reveal motion when the active tab changes", () => {
    const { rerender } = render(<PoweredByFooter transitionKey="gateway" />);
    const initial = screen.getByText(/Powered by/).closest("p");

    expect(screen.getByRole("link", { name: "Wiolett Industries" })).toHaveAttribute(
      "href",
      "https://wiolett.net"
    );

    rerender(<PoweredByFooter transitionKey="inference" />);

    expect(screen.getByText(/Powered by/).closest("p")).not.toBe(initial);
  });
});
