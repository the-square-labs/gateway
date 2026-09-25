import { describe, expect, it } from "vitest";
import {
  allowedCreationFolderId,
  creationFolderChoices,
  flattenCreationFolders,
  hasCreationDestination,
} from "./creation-folders";

const folders = flattenCreationFolders([
  { id: "team-a", name: "Team A", children: [{ id: "team-a-child", name: "Child" }] },
  { id: "team-b", name: "Team B", children: [] },
]);

describe("creation folder choices", () => {
  it("flattens the tree in order with depths", () => {
    expect(folders).toEqual([
      { id: "team-a", name: "Team A", depth: 0 },
      { id: "team-a-child", name: "Child", depth: 1 },
      { id: "team-b", name: "Team B", depth: 0 },
    ]);
  });

  it("offers every folder and the root with a broad grant", () => {
    const choices = creationFolderChoices(["proxy:create"], "proxy:create", folders);

    expect(choices.allowRoot).toBe(true);
    expect(choices.folders).toHaveLength(3);
    expect(choices.defaultFolderId).toBe("");
  });

  it("hides the root and preselects the only granted folder", () => {
    const choices = creationFolderChoices(
      ["domains:create:folder/team-b"],
      "domains:create",
      folders
    );

    expect(choices.allowRoot).toBe(false);
    expect(choices.folders.map((folder) => folder.id)).toEqual(["team-b"]);
    expect(choices.defaultFolderId).toBe("team-b");
    expect(allowedCreationFolderId(choices, "team-a")).toBe("team-b");
  });

  it("does not preselect when several folders are granted", () => {
    const choices = creationFolderChoices(
      ["ssl:cert:issue:folder/team-a", "ssl:cert:issue:folder/team-b"],
      "ssl:cert:issue",
      folders
    );

    expect(choices.defaultFolderId).toBe("");
    expect(allowedCreationFolderId(choices, "team-b")).toBe("team-b");
  });

  it("allows the root and every folder on a granted ingress node", () => {
    const choices = creationFolderChoices(
      ["proxy:create:node/node-1"],
      "proxy:create",
      folders,
      "node-1"
    );

    expect(choices.allowRoot).toBe(true);
    expect(choices.folders).toHaveLength(3);
    expect(
      creationFolderChoices(["proxy:create:node/node-1"], "proxy:create", folders, "node-2")
        .allowRoot
    ).toBe(false);
  });

  it("does not count per-resource grants as a creation destination", () => {
    expect(hasCreationDestination(["ssl:cert:issue:cert-1"], "ssl:cert:issue")).toBe(false);
    expect(hasCreationDestination(["ssl:cert:issue:folder/team-a"], "ssl:cert:issue")).toBe(true);
    expect(hasCreationDestination(["ssl:cert:issue"], "ssl:cert:issue")).toBe(true);
  });
});
