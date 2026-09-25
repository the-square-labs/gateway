import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import type { ResourceFolderTreeNode } from "@/types";
import {
  CreateFolderSelect,
  getCreateFolderChoices,
  isCreateFolderAllowed,
} from "./CreateFolderSelect";

function folder(
  id: string,
  name: string,
  depth = 0,
  children: ResourceFolderTreeNode[] = []
): ResourceFolderTreeNode {
  return {
    id,
    name,
    parentId: null,
    sortOrder: 0,
    depth,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    children,
  };
}

const TREE = [folder("f1", "Ops", 0, [folder("f1a", "Ops child", 1)]), folder("f2", "Apps")];

describe("getCreateFolderChoices", () => {
  it("offers the root and every folder to a broad creator", () => {
    const choices = getCreateFolderChoices(["databases:create"], "databases:create", TREE);

    expect(choices.allowRoot).toBe(true);
    expect(choices.folders.map((item) => item.id)).toEqual(["f1", "f1a", "f2"]);
    expect(choices.defaultFolderId).toBe("");
  });

  it("offers only granted folders to a folder-scoped creator and preselects a single one", () => {
    const choices = getCreateFolderChoices(
      ["databases:create:folder/f2"],
      "databases:create",
      TREE
    );

    expect(choices.allowRoot).toBe(false);
    expect(choices.folders.map((item) => item.id)).toEqual(["f2"]);
    expect(choices.defaultFolderId).toBe("f2");
    expect(isCreateFolderAllowed(choices, "")).toBe(false);
    expect(isCreateFolderAllowed(choices, "f1")).toBe(false);
    expect(isCreateFolderAllowed(choices, "f2")).toBe(true);
  });

  it("does not preselect when several folders are allowed and the root is not", () => {
    // The server expands a folder grant to its subfolders.
    const choices = getCreateFolderChoices(
      ["databases:create:folder/f1", "databases:create:folder/f1a"],
      "databases:create",
      TREE
    );

    expect(choices.folders.map((item) => item.id)).toEqual(["f1", "f1a"]);
    expect(choices.defaultFolderId).toBe("");
  });

  it("treats a node-scoped creator like a broad one on that node", () => {
    const choices = getCreateFolderChoices(
      ["databases:create:node/n1"],
      "databases:create",
      TREE,
      "n1"
    );

    expect(choices.allowRoot).toBe(true);
    expect(choices.folders).toHaveLength(3);
    expect(
      getCreateFolderChoices(["databases:create:node/n1"], "databases:create", TREE, "n2").allowRoot
    ).toBe(false);
  });
});

describe("CreateFolderSelect", () => {
  it("moves an invalid root selection to the only allowed folder", () => {
    const onChange = vi.fn();
    const choices = getCreateFolderChoices(["pages:create:folder/f2"], "pages:create", TREE);

    render(<CreateFolderSelect choices={choices} value="" onChange={onChange} />);

    expect(onChange).toHaveBeenCalledWith("f2");
  });

  it("keeps a valid selection and shows the root option only when allowed", () => {
    const onChange = vi.fn();
    const choices = getCreateFolderChoices(["pages:create:folder/f2"], "pages:create", TREE);

    render(<CreateFolderSelect choices={choices} value="f2" onChange={onChange} />);

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "Folder" })).toHaveTextContent("Apps");
  });
});
