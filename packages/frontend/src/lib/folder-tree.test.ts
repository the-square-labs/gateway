import { describe, expect, it } from "vitest";
import { collectFolderTreeIds, findFolderTreeNode } from "./folder-tree";

interface TestFolder {
  id: string;
  children: TestFolder[];
}

const folders: TestFolder[] = [
  {
    id: "root",
    children: [
      {
        id: "nested",
        children: [{ id: "deep", children: [] }],
      },
    ],
  },
];

describe("folder tree helpers", () => {
  it("collects folder ids at every nesting level", () => {
    expect([...collectFolderTreeIds(folders)]).toEqual(["root", "nested", "deep"]);
  });

  it("finds nested folders", () => {
    expect(findFolderTreeNode(folders, "deep")?.id).toBe("deep");
    expect(findFolderTreeNode(folders, "missing")).toBeNull();
  });
});
