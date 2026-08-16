import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { DockerFolderTreeNode } from "@/types";
import { useDockerFolderStore } from "./docker-folders";

function folder(id: string, name: string): DockerFolderTreeNode {
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
  };
}

describe("docker folder store", () => {
  beforeEach(() => {
    api.invalidateCache("req:/api/docker/folders");
    useDockerFolderStore.setState((state) => ({
      folders: [],
      foldersByType: { ...state.foldersByType, container: [] },
      isLoading: true,
      loadingByType: { ...state.loadingByType, container: true },
      error: null,
      errorByType: { ...state.errorByType, container: null },
    }));
    vi.spyOn(api, "listDockerFolders").mockReset();
  });

  it("hydrates folders synchronously from the persistent API projection before refresh", async () => {
    const cached = [folder("cached", "Cached")];
    const fresh = [folder("fresh", "Fresh")];
    api.setCache("req:/api/docker/folders?resourceType=container", { data: cached });

    let resolveRefresh: (folders: DockerFolderTreeNode[]) => void;
    vi.mocked(api.listDockerFolders).mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    );

    const refresh = useDockerFolderStore.getState().fetchFolders("container");

    expect(useDockerFolderStore.getState().folders).toEqual(cached);
    expect(useDockerFolderStore.getState().isLoading).toBe(false);

    resolveRefresh!(fresh);
    await refresh;

    expect(useDockerFolderStore.getState().folders).toEqual(fresh);
  });

  it("shares an in-flight folder refresh for the same resource type", async () => {
    let resolveRefresh!: (folders: DockerFolderTreeNode[]) => void;
    vi.mocked(api.listDockerFolders).mockImplementation(
      () => new Promise((resolve) => (resolveRefresh = resolve))
    );

    const first = useDockerFolderStore.getState().fetchFolders("container");
    const second = useDockerFolderStore.getState().fetchFolders("container");

    expect(api.listDockerFolders).toHaveBeenCalledTimes(1);
    resolveRefresh([]);
    await Promise.all([first, second]);
  });
});
