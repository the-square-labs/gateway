import { describe, expect, it } from "vitest";
import type { CA } from "@/types";
import { arrangeCATree } from "./ca-tree";

const ca = (id: string, overrides: Partial<CA> = {}) =>
  ({ id, commonName: id, parentId: null, folderId: null, ...overrides }) as CA;

const layout = (cas: CA[]) => arrangeCATree(cas).map((row) => `${row.depth}:${row.id}`);

describe("arrangeCATree", () => {
  it("puts every CA right after its parent, siblings by stored order then name", () => {
    expect(
      layout([
        ca("clients", { parentId: "root", sortOrder: 1 }),
        ca("lab-root", { sortOrder: 0 }),
        ca("services", { parentId: "root", sortOrder: 0 }),
        ca("root", { sortOrder: 0 }),
        ca("devices", { parentId: "services" }),
      ])
    ).toEqual(["0:lab-root", "0:root", "1:services", "2:devices", "1:clients"]);
  });

  it("writes the tree position as the sort order the foldered list sorts by", () => {
    const rows = arrangeCATree([ca("child", { parentId: "root" }), ca("root", { sortOrder: 5 })]);
    expect(rows.map((row) => [row.id, row.sortOrder])).toEqual([
      ["root", 0],
      ["child", 1],
    ]);
  });

  it("lists a CA at the top when its parent is filtered out or in another folder", () => {
    expect(
      layout([
        ca("services", { parentId: "root", folderId: "folder-a" }),
        ca("root", { folderId: "folder-b" }),
        ca("orphan", { parentId: "hidden" }),
      ])
    ).toEqual(["0:orphan", "0:root", "0:services"]);
  });
});
