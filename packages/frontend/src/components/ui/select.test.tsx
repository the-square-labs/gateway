import { Fragment } from "react";
import { describe, expect, it } from "vitest";
import { __selectTestOnly, SelectItem } from "./select";

describe("SelectContent empty state", () => {
  it("detects empty dynamic children without replacing existing options", () => {
    expect(__selectTestOnly.hasRenderableSelectChildren([])).toBe(false);
    expect(__selectTestOnly.hasRenderableSelectChildren(null)).toBe(false);
    expect(
      __selectTestOnly.hasRenderableSelectChildren(
        <Fragment>
          {[]}
          {null}
        </Fragment>
      )
    ).toBe(false);
    expect(
      __selectTestOnly.hasRenderableSelectChildren(
        <SelectItem value="available">Available</SelectItem>
      )
    ).toBe(true);
  });
});
