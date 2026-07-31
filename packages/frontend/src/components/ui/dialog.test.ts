import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { assertNoNestedDialogVerticalScroll } from "./dialog";

describe("DialogContent layout guard", () => {
  it("rejects a nested vertical scroll container", () => {
    expect(() =>
      assertNoNestedDialogVerticalScroll([
        createElement("div", { className: "max-h-[70vh] overflow-y-auto" }),
      ])
    ).toThrow("DialogContent owns vertical scrolling");
  });

  it("allows non-scrolling body wrappers", () => {
    expect(() =>
      assertNoNestedDialogVerticalScroll([createElement("div", { className: "space-y-4" })])
    ).not.toThrow();
  });
});
