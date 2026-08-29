import { describe, expect, it } from "vitest";
import { matchesDockerContainerStatus } from "../../src/lib/docker-container-filters";

describe("Docker container status filters", () => {
  it("matches unavailable independently of the last Docker state", () => {
    const unavailable = {
      availability: "unavailable" as const,
      state: "running",
    };

    expect(matchesDockerContainerStatus(unavailable, "unavailable")).toBe(true);
    expect(matchesDockerContainerStatus(unavailable, "running")).toBe(false);
    expect(matchesDockerContainerStatus(unavailable, "stopped")).toBe(false);
  });

  it("uses the effective transition state for available containers", () => {
    expect(
      matchesDockerContainerStatus(
        { availability: "available", state: "running", _transition: "stopping" },
        "stopped"
      )
    ).toBe(true);
  });
});
