import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "@/stores/auth";
import { useDockerFolderStore } from "@/stores/docker-folders";
import { makeNode, makeUser } from "@/test/fixtures";
import type { DockerFolderTreeNode } from "@/types";
import { GwcaImportDialog } from "./GwcaImportDialog";

Object.defineProperties(window.HTMLElement.prototype, {
  hasPointerCapture: { configurable: true, value: () => false },
  setPointerCapture: { configurable: true, value: () => undefined },
  releasePointerCapture: { configurable: true, value: () => undefined },
  scrollIntoView: { configurable: true, value: () => undefined },
});

function folder(
  id: string,
  name: string,
  extra: Partial<DockerFolderTreeNode> = {}
): DockerFolderTreeNode {
  return {
    id,
    name,
    resourceType: "container",
    parentId: null,
    sortOrder: 0,
    depth: 0,
    isSystem: false,
    nodeId: null,
    composeProject: null,
    createdAt: "",
    updatedAt: "",
    children: [],
    ...extra,
  };
}

const initialFolderState = useDockerFolderStore.getState();
const node = makeNode({ id: "node-1", type: "docker", displayName: "Docker 1" });

function renderDialog(scopes: string[]) {
  useAuthStore.setState({ user: makeUser({ scopes }), isAuthenticated: true, isLoading: false });
  return render(
    <GwcaImportDialog open onOpenChange={vi.fn()} nodes={[node]} onImported={vi.fn()} />
  );
}

async function destinationOptions() {
  const trigger = screen.getByRole("combobox", { name: "Destination folder" });
  fireEvent.keyDown(trigger, { key: "Enter" });
  const listbox = await screen.findByRole("listbox");
  return within(listbox)
    .getAllByRole("option")
    .map((option) => option.textContent);
}

describe("GwcaImportDialog destination folder", () => {
  beforeEach(() => {
    useDockerFolderStore.setState({
      foldersByType: {
        ...initialFolderState.foldersByType,
        container: [
          folder("folder-1", "MyProject"),
          folder("folder-2", "Other team"),
          folder("system-1", "compose-stack", { isSystem: true }),
        ],
      },
      loadingByType: { ...initialFolderState.loadingByType, container: false },
      fetchFolders: vi.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(() => {
    useDockerFolderStore.setState(initialFolderState, true);
  });

  it("offers only the folders a folder-only creator may import into and preselects the single one", async () => {
    renderDialog(["docker:containers:create:folder/folder-1"]);

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Destination folder" })).toHaveTextContent(
        "MyProject"
      )
    );
    expect(await destinationOptions()).toEqual(["MyProject"]);
  });

  it("keeps Root and every non-system folder for a broad creator without preselecting", async () => {
    renderDialog(["docker:containers:create"]);

    expect(screen.getByRole("combobox", { name: "Destination folder" })).toHaveTextContent("Root");
    expect(await destinationOptions()).toEqual(["Root", "MyProject", "Other team"]);
  });

  it("offers Root to a node creator only for that node", async () => {
    renderDialog(["docker:containers:create:node-1"]);

    expect(await destinationOptions()).toEqual(["Root", "MyProject", "Other team"]);
  });
});
