import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { ModelReasoningFields, reorderReasoningMapping } from "./InferenceModelReasoningFields";

describe("InferenceModelReasoningFields", () => {
  it("persists the requested reasoning order", () => {
    expect(Object.keys(reorderReasoningMapping({ low: "low", high: "high" }, 0, 1))).toEqual([
      "high",
      "low",
    ]);
  });

  it("leaves the outer panel as the only bottom border", () => {
    render(
      <ModelReasoningFields
        selected={null}
        mapping={{ low: "low", high: "high" }}
        setMapping={vi.fn()}
        defaultEffort="high"
        setDefaultEffort={vi.fn()}
      />
    );

    const lastRow = screen.getByRole("textbox", { name: "Client effort 2" }).closest(".grid");
    expect(lastRow).not.toHaveClass("border-b");
    expect(screen.getByRole("textbox", { name: "Client effort 1" }).closest(".grid")).toHaveClass(
      "border-b"
    );
  });
});
