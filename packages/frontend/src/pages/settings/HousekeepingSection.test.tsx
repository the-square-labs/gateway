import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { HousekeepingConfig, HousekeepingStats } from "@/types";
import { HousekeepingSection } from "./HousekeepingSection";

const config: HousekeepingConfig = {
  enabled: true,
  cronExpression: "0 2 * * *",
  nginxLogs: { enabled: true, retentionDays: 30 },
  auditLog: { enabled: true, retentionDays: 90 },
  dismissedAlerts: { enabled: true, retentionDays: 30 },
  deliveryLog: { enabled: true, retentionDays: 7 },
  structuredLogs: { enabled: false, maxRows: 100_000, maxSizeBytes: 10 * 1024 ** 3 },
  clickHouseInternals: { enabled: true, maxSizeBytes: 512 * 1024 ** 2 },
  orphanedAIArtifacts: { enabled: true },
  gatewayLogs: { enabled: false },
  orphanedVolumes: { enabled: false, retentionDays: 30 },
  dockerPrune: { enabled: true },
  orphanedCerts: { enabled: true },
  acmeCleanup: { enabled: true },
};

const stats = {
  nginxLogs: { totalSizeBytes: 0, fileCount: 0, oldestFile: null },
  auditLog: { totalRows: 0, oldestEntry: null },
  dismissedAlerts: { count: 0, oldestAlert: null },
  deliveryLog: { total: 0, success: 0, failed: 0, retrying: 0 },
  structuredLogs: { totalRows: 0, totalSizeBytes: 0, status: "healthy" },
  clickHouseInternals: {
    totalRows: 0,
    totalSizeBytes: 0,
    status: "healthy",
    capBytes: 512 * 1024 ** 2,
  },
  orphanedAIArtifacts: { count: 0, totalSizeBytes: 0 },
  gatewayLogs: { totalSizeBytes: 0, fileCount: 0, available: false },
  orphanedVolumes: { count: 0, reclaimableBytes: 0 },
  orphanedCerts: { count: 0, certIds: [], currentCount: 0, supersededCount: 0, unknownCount: 0 },
  acmeChallenges: { fileCount: 0, totalSizeBytes: 0 },
  dockerImages: { oldImageCount: 0, reclaimableBytes: 0 },
  lastRun: null,
  isRunning: false,
} satisfies HousekeepingStats;

describe("HousekeepingSection ClickHouse internals", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    api.invalidateCache("housekeeping:");
  });

  it("edits and saves the internal log cap in MiB", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getHousekeepingConfig").mockResolvedValue(structuredClone(config));
    vi.spyOn(api, "getHousekeepingStats").mockResolvedValue(stats);
    const update = vi
      .spyOn(api, "updateHousekeepingConfig")
      .mockImplementation(async (next) => next as HousekeepingConfig);

    render(
      <MemoryRouter>
        <HousekeepingSection canRun canConfigure />
      </MemoryRouter>
    );

    const input = await screen.findByRole("spinbutton", {
      name: "Maximum ClickHouse internal log size in MiB",
    });
    expect(input).toHaveValue(512);
    await user.clear(input);
    await user.type(input, "768");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          clickHouseInternals: { enabled: true, maxSizeBytes: 768 * 1024 ** 2 },
        })
      )
    );
  });
});
