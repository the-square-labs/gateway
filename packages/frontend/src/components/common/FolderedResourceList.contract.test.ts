/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const adapter = readFileSync(
  resolve(process.cwd(), "src/components/common/FolderedResourceList.tsx"),
  "utf8"
);
const core = readFileSync(
  resolve(process.cwd(), "src/components/common/resource-list/FolderedResourceListCore.tsx"),
  "utf8"
);
const source = `${adapter}\n${core}`;
const groups = readFileSync(resolve(process.cwd(), "src/pages/AdminGroups.tsx"), "utf8");

describe("shared folder interaction contract", () => {
  it("uses the persisted folder store for system folders as well as ordinary folders", () => {
    expect(adapter).toContain("toggleFolder: (id) => toggleFolder(resourceType, id)");
    expect(core).toContain(
      "isFolderExpanded: (folder) => lockExpanded || expandedFolderIds.has(folder.id)"
    );
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
