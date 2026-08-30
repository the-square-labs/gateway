import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Badge } from "./badge";

describe("Badge", () => {
  it("uses compact dimensions only for the inline size", () => {
    render(
      <>
        <Badge>Standalone</Badge>
        <Badge size="inline">Inline</Badge>
      </>
    );

    expect(screen.getByText("Standalone").parentElement).toHaveClass("h-6", "px-2");
    expect(screen.getByText("Inline").parentElement).toHaveClass("h-5", "px-1");
    expect(screen.getByText("Standalone").parentElement?.tagName).toBe("DIV");
    expect(screen.getByText("Inline").parentElement?.tagName).toBe("SPAN");
  });
});
