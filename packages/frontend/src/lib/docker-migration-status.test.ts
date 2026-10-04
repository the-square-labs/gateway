import { describe, expect, it } from "vitest";
import { dockerMigrationError } from "./docker-migration-status";

const waited = "Waiting for a migration node to reconnect";

describe("docker migration error", () => {
  it("is not shown for a migration that waited for a node and then completed or went on", () => {
    expect(dockerMigrationError({ status: "completed", errorMessage: waited })).toBeNull();
    expect(dockerMigrationError({ status: "running", errorMessage: waited })).toBeNull();
    expect(dockerMigrationError({ status: "waiting", errorMessage: waited })).toBeNull();
  });

  it("is shown for a migration that ended without success or needs an operator", () => {
    for (const status of ["failed", "cancelled", "needs_attention", "cleanup_pending"] as const) {
      expect(dockerMigrationError({ status, errorMessage: "Target container is unhealthy" })).toBe(
        "Target container is unhealthy"
      );
    }
    expect(dockerMigrationError({ status: "failed", errorMessage: null })).toBeNull();
  });
});
