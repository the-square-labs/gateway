import { filterLegacyIdRecentPages, useUIStore } from "./ui";

describe("recent pages", () => {
  beforeEach(() => {
    useUIStore.setState({ recentPages: [], commandActionUsage: {} });
  });

  it("replaces the previous route when the same resource is renamed", () => {
    const store = useUIStore.getState();
    store.addRecentPage("/nodes/old-name", "Node: old-name", undefined, "node:node-1");
    store.addRecentPage("/nodes/new-name", "Node: new-name", undefined, "node:node-1");

    expect(useUIStore.getState().recentPages).toEqual([
      {
        path: "/nodes/new-name",
        label: "Node: new-name",
        icon: undefined,
        resourceKey: "node:node-1",
      },
    ]);
  });

  it("tracks command action frequency independently per user and page context", () => {
    const store = useUIStore.getState();
    store.recordCommandActionUsage("user-1", "proxy-hosts", "action:new-proxy");
    store.recordCommandActionUsage("user-1", "proxy-hosts", "action:new-proxy");
    store.recordCommandActionUsage("user-1", "dashboard", "action:new-proxy");
    store.recordCommandActionUsage("user-2", "proxy-hosts", "action:new-proxy");

    expect(Object.values(useUIStore.getState().commandActionUsage)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: "user-1",
          context: "proxy-hosts",
          actionId: "action:new-proxy",
          count: 2,
        }),
        expect.objectContaining({
          userId: "user-1",
          context: "dashboard",
          actionId: "action:new-proxy",
          count: 1,
        }),
        expect.objectContaining({
          userId: "user-2",
          context: "proxy-hosts",
          actionId: "action:new-proxy",
          count: 1,
        }),
      ])
    );
  });

  it("removes every recent tab for a renamed volume", () => {
    const store = useUIStore.getState();
    store.addRecentPage("/docker/volumes/node-a/data/files", "Volume: data / Files");
    store.addRecentPage("/docker/volumes/node-a/data/settings", "Volume: data / Settings");
    store.addRecentPage("/docker/volumes/node-a/database/files", "Volume: database / Files");

    store.removeRecentPagesByPrefix("/docker/volumes/node-a/data");

    expect(useUIStore.getState().recentPages.map((page) => page.path)).toEqual([
      "/docker/volumes/node-a/database/files",
    ]);
  });

  it("drops only legacy ID-based resource routes during storage migration", () => {
    const oldId = "86ba8510-6d45-4aa4-8b31-06ab78180f95";

    expect(
      filterLegacyIdRecentPages([
        { path: `/nodes/${oldId}`, label: "Old node" },
        { path: `/docker/containers/${oldId}/container-id`, label: "Old container" },
        { path: `/cas/${oldId}`, label: "CA" },
        {
          path: `/nodes/${oldId}`,
          label: "Current UUID-like slug",
          resourceKey: "node:node-1",
        },
      ])
    ).toEqual([
      { path: `/cas/${oldId}`, label: "CA" },
      {
        path: `/nodes/${oldId}`,
        label: "Current UUID-like slug",
        resourceKey: "node:node-1",
      },
    ]);
  });
});
