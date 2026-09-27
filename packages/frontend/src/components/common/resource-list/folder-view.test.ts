import { describe, expect, it } from "vitest";
import { applySingleFolderView, defaultOpenFolderId } from "./folder-view";

type Folder = { id: string; items: string[]; children: Folder[] };
const folder = (id: string, items: string[], children: Folder[] = []): Folder => ({
  id,
  items,
  children,
});
const items = (node: Folder) => node.items;
// Apps (ancestor on the path) > Team (the granted folder holding everything the caller sees).
const chain = [folder("apps", [], [folder("team", ["web", "worker"])])];

describe("single-folder view", () => {
  it("shows a folder-limited caller without folder management just the resources", () => {
    expect(
      applySingleFolderView(chain, [], items, { limitedToFolders: true, canManageFolders: false })
    ).toEqual({ folders: [], ungrouped: ["web", "worker"] });
  });

  it("shows only the granted folder, without its ancestors, to a caller who manages folders", () => {
    const view = applySingleFolderView(chain, [], items, {
      limitedToFolders: true,
      canManageFolders: true,
    });
    expect(view.folders.map((node) => node.id)).toEqual(["team"]);
  });

  it("leaves the tree alone for callers who see everything or have ungrouped resources", () => {
    expect(
      applySingleFolderView(chain, [], items, { limitedToFolders: false, canManageFolders: false })
        .folders
    ).toBe(chain);
    expect(
      applySingleFolderView(chain, ["db"], items, {
        limitedToFolders: true,
        canManageFolders: false,
      }).folders
    ).toBe(chain);
  });
});

describe("default open folder", () => {
  it("opens the first folder when nothing is ungrouped and the user never folded one", () => {
    expect(defaultOpenFolderId(chain, 0, false)).toBe("apps");
  });

  it("opens nothing once the user folded a folder or when resources are ungrouped", () => {
    expect(defaultOpenFolderId(chain, 0, true)).toBeNull();
    expect(defaultOpenFolderId(chain, 2, false)).toBeNull();
  });
});
