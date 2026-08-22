import { describe, expect, it } from "vitest";
import { reorderReasoningMapping } from "./InferenceModelReasoningFields";

describe("reorderReasoningMapping", () => {
  it("preserves mappings while changing their advertised order", () => {
    expect(
      Object.entries(reorderReasoningMapping({ low: "low", high: "high", ultra: "max" }, 2, 0))
    ).toEqual([
      ["ultra", "max"],
      ["low", "low"],
      ["high", "high"],
    ]);
  });
});
