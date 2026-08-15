import { getTemplatePreviewEditorHeight } from "./NginxTemplates";

describe("getTemplatePreviewEditorHeight", () => {
  it("shrinks short previews and caps long previews", () => {
    expect(getTemplatePreviewEditorHeight("server {}")).toBe("min(64dvh, 120px)");
    expect(
      getTemplatePreviewEditorHeight(Array.from({ length: 10 }, () => "line").join("\n"))
    ).toBe("min(64dvh, 196px)");
    expect(
      getTemplatePreviewEditorHeight(Array.from({ length: 100 }, () => "line").join("\n"))
    ).toBe("min(64dvh, 640px)");
  });
});
