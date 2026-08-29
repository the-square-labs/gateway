import { describe, expect, it } from "vitest";
import { filterDockerImages } from "@/pages/docker-images-filter";
import { normalizeDockerImageUsageContainers } from "@/pages/docker-images-usage";
import type { DockerImage } from "@/types";

const image = (overrides: Partial<DockerImage> & Record<string, unknown>): DockerImage =>
  ({
    id: "sha256:default",
    repoTags: ["example/app:latest"],
    containers: 0,
    ...overrides,
  }) as DockerImage;

describe("DockerImages filtering", () => {
  it("hides dangling and untagged images", () => {
    const images = [
      image({ id: "tagged" }),
      image({ id: "dangling", repoTags: ["<none>:<none>"] }),
      image({ id: "untagged", repoTags: [] }),
    ];

    expect(filterDockerImages(images, "", "all").map((entry) => entry.id)).toEqual(["tagged"]);
  });

  it("supports legacy Docker field casing", () => {
    const legacy = image({
      id: undefined,
      repoTags: undefined,
      containers: undefined,
      Id: "legacy-id",
      RepoTags: ["legacy/app:v1"],
      Containers: 1,
    });

    expect(filterDockerImages([legacy], "LEGACY", "used")).toEqual([legacy]);
  });

  it("filters used and unused images while excluding unknown usage", () => {
    const used = image({ id: "used", containers: 2 });
    const unused = image({ id: "unused", containers: 0 });
    const unknown = image({ id: "unknown", containers: undefined });

    expect(filterDockerImages([used, unused, unknown], "", "used")).toEqual([used]);
    expect(filterDockerImages([used, unused, unknown], "", "unused")).toEqual([unused]);
    expect(filterDockerImages([used, unused, unknown], "", "all")).toEqual([used, unused, unknown]);
  });

  it("searches image ids and tags case-insensitively", () => {
    const byId = image({ id: "sha256:ABC123", repoTags: ["example/app:latest"] });
    const byTag = image({ id: "sha256:def456", repoTags: ["Registry.EXAMPLE/Worker:v2"] });

    expect(filterDockerImages([byId, byTag], "abc", "all")).toEqual([byId]);
    expect(filterDockerImages([byId, byTag], "worker", "all")).toEqual([byTag]);
  });

  it("applies usage filtering before search without mutating the source list", () => {
    const used = image({ id: "used-worker", repoTags: ["example/worker:v1"], containers: 1 });
    const unused = image({ id: "unused-worker", repoTags: ["example/worker:v2"], containers: 0 });
    const source = [used, unused];

    expect(filterDockerImages(source, "worker", "unused")).toEqual([unused]);
    expect(source).toEqual([used, unused]);
  });
});

describe("Docker image usage normalization", () => {
  it("normalizes current and legacy container fields and keeps only matching repositories", () => {
    expect(
      normalizeDockerImageUsageContainers(
        [
          { id: "current", name: "/api", state: "running", image: "example/app:v2" },
          { Id: "legacy", Name: "/worker", State: "exited", Image: "example/app:v1" },
          { id: "other", name: "/db", state: "running", image: "postgres:17" },
        ],
        "example/app:latest",
        "node-1",
        "docker-a"
      )
    ).toEqual([
      {
        id: "current",
        name: "/api",
        state: "running",
        image: "example/app:v2",
        nodeId: "node-1",
        nodeSlug: "docker-a",
      },
      {
        id: "legacy",
        name: "/worker",
        state: "exited",
        image: "example/app:v1",
        nodeId: "node-1",
        nodeSlug: "docker-a",
      },
    ]);
  });

  it("treats a non-array daemon response as empty", () => {
    expect(normalizeDockerImageUsageContainers(null, "example/app:latest", "node-1")).toEqual([]);
  });
});
