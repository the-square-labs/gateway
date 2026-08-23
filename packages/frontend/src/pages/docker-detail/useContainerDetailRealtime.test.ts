import { describe, expect, it } from "vitest";
import { matchesCurrentContainerRecreate } from "./useContainerDetailRealtime";

describe("container detail realtime recreate matching", () => {
  it("matches while the page still tracks the replaced container id", () => {
    expect(
      matchesCurrentContainerRecreate(
        { action: "recreated", name: "api", oldId: "old-id", id: "new-id" },
        "old-id",
        "api"
      )
    ).toBe(true);
  });

  it("still matches after inspect already adopted the replacement id", () => {
    expect(
      matchesCurrentContainerRecreate(
        { action: "recreated", name: "api", oldId: "old-id", id: "new-id" },
        "new-id",
        "api"
      )
    ).toBe(true);
  });

  it("does not match a recreate for another container name", () => {
    expect(
      matchesCurrentContainerRecreate(
        { action: "recreated", name: "worker", oldId: "old-id", id: "new-id" },
        "new-id",
        "api"
      )
    ).toBe(false);
  });
});
