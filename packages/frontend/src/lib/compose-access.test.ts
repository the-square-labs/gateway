import { describe, expect, it } from "vitest";
import { canAdoptComposeProject, hasComposeProjectScope } from "./compose-access";

describe("Compose project access", () => {
  it.each([
    [["docker:compose:manage"], true],
    [["docker:compose:manage:node-1"], true],
    [["docker:compose:manage:node-1/project-1"], true],
    [["docker:compose:manage:node-2"], false],
    [["docker:compose:manage:node-1/project-2"], false],
  ] as const)("matches global, node, and exact project grants", (scopes, expected) => {
    expect(hasComposeProjectScope(scopes, "docker:compose:manage", "node-1", "project-1")).toBe(
      expected
    );
  });

  it("requires create and manage permission for Adopt & Apply", () => {
    expect(
      canAdoptComposeProject(
        ["docker:compose:create:node-1", "docker:compose:manage:node-1"],
        "node-1",
        "project-1"
      )
    ).toBe(true);
    expect(canAdoptComposeProject(["docker:compose:create:node-1"], "node-1", "project-1")).toBe(
      false
    );
  });
});
