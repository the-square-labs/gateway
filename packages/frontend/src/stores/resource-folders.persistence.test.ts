import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  localStorage.clear();
});

describe("Builtin group folder persistence", () => {
  it("restores the same collapsed state after reloading the store", async () => {
    localStorage.clear();
    vi.resetModules();
    let { useResourceFolderStore } = await import("./resource-folders");
    const type = "admin-group";
    const id = "admin-groups-builtin";
    useResourceFolderStore.getState().toggleFolder(type, id);
    expect(useResourceFolderStore.getState().expandedFolderIdsByType[type].has(id)).toBe(true);
    vi.resetModules();
    ({ useResourceFolderStore } = await import("./resource-folders"));
    expect(useResourceFolderStore.getState().expandedFolderIdsByType[type].has(id)).toBe(true);
    useResourceFolderStore.getState().toggleFolder(type, id);
    vi.resetModules();
    ({ useResourceFolderStore } = await import("./resource-folders"));
    expect(useResourceFolderStore.getState().expandedFolderIdsByType[type].has(id)).toBe(false);
  });
});
