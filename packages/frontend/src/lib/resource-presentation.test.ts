import { describe, expect, it } from "vitest";
import type { ResourceSearchResult } from "@/types/resource-search";
import { resourceSearchHref, resourceTypeIcon, resourceTypeLabel } from "./resource-presentation";

function result(type: ResourceSearchResult["type"], id: string): ResourceSearchResult {
  return { type, id, name: id, summary: {} };
}

describe("resource presentation", () => {
  it("routes Compose projects and Docker builds to their product surfaces", () => {
    expect(resourceSearchHref(result("docker_compose_project", "compose-1"))).toBe(
      "/docker/compose/compose-1"
    );
    expect(resourceSearchHref(result("docker_build", "build-1"))).toBe(
      "/docker/builds?build=build-1"
    );
  });

  it("keeps unknown future resource types renderable and safely navigable", () => {
    const future = result("future_resource_type" as never, "future-1");

    expect(resourceTypeIcon(future.type)).toBeTypeOf("object");
    expect(resourceTypeLabel(future.type)).toBe("Future Resource Type");
    expect(resourceSearchHref(future)).toBe("/");
  });
});
