import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PoweredByFooter } from "./PoweredByFooter";

describe("PoweredByFooter", () => {
  it("renders the shared product attribution", () => {
    render(<PoweredByFooter />);
    expect(screen.getByRole("link", { name: "Wiolett Industries" })).toHaveAttribute(
      "href",
      "https://wiolett.net"
    );
    expect(screen.getByText(/Powered by/).closest("p")).not.toHaveAttribute("style");
  });
});
