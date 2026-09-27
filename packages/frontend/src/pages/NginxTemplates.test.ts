import { codeEditorHeightForLines } from "@/components/ui/code-editor";
import { getTemplatePreviewEditorHeight } from "./NginxTemplates";

describe("getTemplatePreviewEditorHeight", () => {
  it("fits every line of short previews and caps long previews", () => {
    expect(getTemplatePreviewEditorHeight("server {}")).toBe("min(64dvh, 120px)");
    expect(
      getTemplatePreviewEditorHeight(Array.from({ length: 10 }, () => "line").join("\n"))
    ).toBe("min(64dvh, 201px)");
    expect(
      getTemplatePreviewEditorHeight(Array.from({ length: 100 }, () => "line").join("\n"))
    ).toBe("min(64dvh, 640px)");
  });
});

describe("codeEditorHeightForLines", () => {
  it("adds the 18.2px lines, the content padding and the border", () => {
    // 23 lines: 418.6px + 16px padding, rounded up to 435px, then the border and 1px of slack.
    expect(codeEditorHeightForLines(23)).toBe(438);
    expect(codeEditorHeightForLines(23, false)).toBe(436);
  });
});
