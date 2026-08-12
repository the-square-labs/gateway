import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Skeleton } from "./skeleton";

describe("Skeleton", () => {
  it("does not render a shimmer placeholder", () => {
    render(<Skeleton data-testid="skeleton" />);

    expect(screen.queryByTestId("skeleton")).not.toBeInTheDocument();
  });
});
