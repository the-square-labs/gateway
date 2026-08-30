import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("Sidebar AI entry points", () => {
  it("keeps the side-panel star in the header and the full Workspace CTA", () => {
    const source = readFileSync(resolve("src/components/layout/SidebarContent.tsx"), "utf8");
    const header = source.slice(
      source.indexOf("{/* Header */}"),
      source.indexOf("{/* Header */}") + 1800
    );

    expect(header).toContain("<AIButton />");
    expect(source).toContain("<AIButton showLabel />");
  });
});
