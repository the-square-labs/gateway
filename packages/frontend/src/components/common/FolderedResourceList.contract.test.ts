/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  resolve(process.cwd(), "src/components/common/FolderedResourceList.tsx"),
  "utf8"
);
const groups = readFileSync(resolve(process.cwd(), "src/pages/AdminGroups.tsx"), "utf8");

describe("shared folder interaction contract", () => {
  it("uses the persisted folder store for system folders as well as ordinary folders", () => {
    expect(source).toContain("toggleFolder(resourceType, folder.id)");
    expect(source).toContain("isFolderExpanded: (folder) => expandedFolderIds.has(folder.id)");
    expect(source).not.toContain("collapsedSystemFolderIds");
  });

  it("suppresses successful group move toasts without suppressing failures", () => {
    expect(groups).toContain("notifyOnMove={false}");
    expect(source).toContain('if (notifyOnMove) toast.success("Resource moved")');
    expect(source).toContain(
      'toast.error(err instanceof Error ? err.message : "Failed to move resource")'
    );
  });
});
