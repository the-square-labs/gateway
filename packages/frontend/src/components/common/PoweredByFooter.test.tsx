import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PoweredByFooter } from "./PoweredByFooter";

describe("PoweredByFooter", () => {
  it("renders the shared product attribution", () => {
    render(<PoweredByFooter />);
    expect(screen.getByRole("link", { name: "Square Labs" })).toHaveAttribute(
      "href",
      "https://thesquarelabs.com"
    );
    expect(screen.getByText(/Powered by/).closest("p")).not.toHaveAttribute("style");
  });
});
