import { describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "@/services/api-base";
import {
  clearDockerMigrationOwnedByTab,
  isDockerMigrationOwnedByTab,
  markDockerMigrationOwnedByTab,
  resolveMigrationTarget,
} from "../../src/lib/docker-migration-navigation";

describe("resolveMigrationTarget", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("retries transient handoff misses until the target is readable", async () => {
    const resolver = vi
      .fn()
      .mockRejectedValueOnce(new ApiRequestError("Not found", { status: 404 }))
      .mockRejectedValueOnce(new ApiRequestError("Unavailable", { status: 503 }))
      .mockResolvedValue("ready");

    await expect(resolveMigrationTarget(true, resolver, [0, 0, 0])).resolves.toBe("ready");
    expect(resolver).toHaveBeenCalledTimes(3);
  });

  it("does not retry ordinary detail loads", async () => {
    const resolver = vi.fn().mockRejectedValue(new ApiRequestError("Not found", { status: 404 }));

    await expect(resolveMigrationTarget(false, resolver, [0, 0])).rejects.toMatchObject({
      status: 404,
    });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("tracks migration modal ownership within the initiating tab", () => {
    markDockerMigrationOwnedByTab("migration-1");

    expect(isDockerMigrationOwnedByTab("migration-1")).toBe(true);
    expect(isDockerMigrationOwnedByTab("migration-2")).toBe(false);

    clearDockerMigrationOwnedByTab("migration-2");
    expect(isDockerMigrationOwnedByTab("migration-1")).toBe(true);

    clearDockerMigrationOwnedByTab("migration-1");
    expect(isDockerMigrationOwnedByTab("migration-1")).toBe(false);
  });
});
