import { describe, expect, it } from "vitest";
import type { InferenceModel } from "@/types/inference";
import { reorderInferenceModels } from "./InferenceModelsPanel";

function model(id: string, sortOrder: number): InferenceModel {
  return { id, sortOrder, displayName: id } as InferenceModel;
}

describe("reorderInferenceModels", () => {
  it("moves a model and rewrites contiguous persisted positions", () => {
    expect(
      reorderInferenceModels([model("a", 0), model("b", 1), model("c", 2)], "c", "a").map(
        ({ id, sortOrder }) => ({ id, sortOrder })
      )
    ).toEqual([
      { id: "c", sortOrder: 0 },
      { id: "a", sortOrder: 1 },
      { id: "b", sortOrder: 2 },
    ]);
  });
});
