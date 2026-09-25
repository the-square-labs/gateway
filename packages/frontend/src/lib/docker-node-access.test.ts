import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import { makeNode } from "@/test/fixtures";
import { canCreateDockerResourceOnNode, loadVisibleDockerNodes } from "./docker-node-access";

const nodes = [
  makeNode({ id: "node-1", type: "docker" }),
  makeNode({ id: "node-2", type: "docker" }),
];

describe("Docker node pickers", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, "listNodes").mockResolvedValue({
      data: nodes,
      total: nodes.length,
      page: 1,
      limit: 100,
      totalPages: 1,
    } as never);
  });

  it("lists every Docker node for a folder-only creator whose folder is still empty", async () => {
    const scopes = ["docker:containers:create:folder/folder-1"];

    const visible = await loadVisibleDockerNodes(
      scopes,
      ["docker:containers:view", "docker:containers:create"],
      false
    );

    // The backend accepts a folder creation grant on every Docker node.
    expect(visible.map((node) => node.id)).toEqual(["node-1", "node-2"]);
    expect(
      nodes.every((node) =>
        canCreateDockerResourceOnNode(scopes, "docker:containers:create", node.id)
      )
    ).toBe(true);
  });

  it("keeps a node-scoped creator to its own node", async () => {
    const scopes = ["docker:networks:create:node-2"];

    const visible = await loadVisibleDockerNodes(
      scopes,
      ["docker:networks:view", "docker:networks:create"],
      false
    );

    expect(visible.map((node) => node.id)).toEqual(["node-2"]);
    expect(canCreateDockerResourceOnNode(scopes, "docker:networks:create", "node-1")).toBe(false);
    expect(canCreateDockerResourceOnNode(scopes, "docker:networks:create", "node-2")).toBe(true);
  });

  it("does not offer creation on a node where only viewing is granted", () => {
    const scopes = ["docker:volumes:view", "docker:volumes:create:node-1"];

    expect(canCreateDockerResourceOnNode(scopes, "docker:volumes:create", "node-1")).toBe(true);
    expect(canCreateDockerResourceOnNode(scopes, "docker:volumes:create", "node-2")).toBe(false);
    expect(canCreateDockerResourceOnNode(scopes, "docker:networks:create", "node-1")).toBe(false);
  });

  it("lists no node for a view-only folder grant without workloads", async () => {
    vi.mocked(api.listNodes).mockResolvedValue({
      data: [],
      total: 0,
      page: 1,
      limit: 100,
      totalPages: 0,
    } as never);

    const visible = await loadVisibleDockerNodes(
      ["docker:containers:view:folder/folder-1"],
      ["docker:containers:view", "docker:containers:create"],
      false
    );

    expect(visible).toEqual([]);
  });
});
