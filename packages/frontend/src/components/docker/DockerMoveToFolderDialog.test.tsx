import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { canCreateInFolder } from "@/lib/scope-utils";
import type { DockerFolderTreeNode } from "@/types";
import { DockerMoveToFolderDialog } from "./DockerMoveToFolderDialog";

function folder(id: string, name: string): DockerFolderTreeNode {
  return { id, name, isSystem: false, children: [] } as unknown as DockerFolderTreeNode;
}

describe("DockerMoveToFolderDialog", () => {
  it("offers only the destinations a folder-limited editor may move containers into", () => {
    // Same rule as POST /docker/folders/move-containers: edit on the destination folder, or broadly for the root.
    const scopes = ["docker:containers:edit:folder/f1"];
    const onMove = vi.fn();
    render(
      <DockerMoveToFolderDialog
        open
        onOpenChange={vi.fn()}
        folders={[folder("f1", "Team"), folder("f2", "Other")]}
        currentFolderId="f2"
        canMoveTo={(folderId) =>
          canCreateInFolder(scopes, "docker:containers:edit", folderId, "node-1")
        }
        onMove={onMove}
      />
    );

    expect(screen.getByRole("button", { name: /Root \(ungrouped\)/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Other/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /Team/ }));
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    expect(onMove).toHaveBeenCalledWith("f1");
  });

  it("keeps the root and every folder for callers without a restriction", () => {
    render(
      <DockerMoveToFolderDialog
        open
        onOpenChange={vi.fn()}
        folders={[folder("f1", "Team")]}
        currentFolderId="f1"
        onMove={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: /Root \(ungrouped\)/ })).toBeEnabled();
  });
});
