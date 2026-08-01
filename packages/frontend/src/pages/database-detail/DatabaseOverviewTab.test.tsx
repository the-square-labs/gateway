import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { DatabaseConnection, DatabaseMetricSnapshot } from "@/types";
import { DatabaseOverviewTab } from "./DatabaseOverviewTab";

const database = {
  id: "database-1",
  slug: "orders",
  name: "Orders",
  type: "postgres",
  manualSizeLimitMb: 1_024,
  healthStatus: "online",
  managed: {
    id: "managed-database-1",
    nodeId: "node-1",
    version: "17.5",
    storageSizeBytes: 2 * 1024 ** 3,
    runtimeConfig: { cpuCores: 1, memoryMb: 1_024, swapMb: 0 },
    publishedPort: 15432,
    endpointHost: "database.example.test",
    status: "ready",
    lastError: null,
  },
} as DatabaseConnection;

const history = [
  {
    timestamp: "2026-08-01T20:00:00.000Z",
    databaseId: database.id,
    type: "postgres",
    name: database.name,
    status: "online",
    responseMs: 5,
    metrics: {
      database_size_bytes: 512 * 1024 ** 2,
      managed_cpu_percent: 42.5,
      managed_memory_usage_bytes: 512 * 1024 ** 2,
      managed_memory_limit_bytes: 1024 * 1024 ** 2,
      managed_swap_usage_bytes: 64 * 1024 ** 2,
      managed_swap_limit_bytes: 256 * 1024 ** 2,
      managed_pids: 12,
    },
  },
] as DatabaseMetricSnapshot[];

describe("DatabaseOverviewTab", () => {
  it("uses the managed storage size in monitoring instead of a stale connection limit", () => {
    const { container } = render(
      <DatabaseOverviewTab
        database={database}
        canViewMonitoring
        healthStatus="online"
        history={history}
        monitoringLoading={false}
      />
    );

    expect(screen.getByText("512.0 MB / 2.0 GB")).toBeInTheDocument();
    expect(screen.getByText("CPU")).toBeInTheDocument();
    expect(screen.getAllByText("Memory")).toHaveLength(1);
    expect(screen.getByText("Swap")).toBeInTheDocument();
    expect(screen.getByText("PIDs")).toBeInTheDocument();
    expect(screen.getByText("database.example.test")).toBeInTheDocument();
    expect(screen.getByText("Published TCP Port")).toBeInTheDocument();
    const metricsGrid = container.querySelector("div.grid.gap-3");
    expect(metricsGrid).not.toBeNull();
    expect(
      Array.from(metricsGrid!.children)
        .slice(0, 4)
        .map((card) => card.querySelector("p")?.textContent)
    ).toEqual(["Database Size", "Memory", "CPU", "Swap"]);
  });

  it("marks a managed database with no swap budget as disabled without a sparkline", () => {
    const disabledSwapHistory = [
      {
        ...history[0],
        metrics: {
          ...history[0]!.metrics,
          managed_swap_usage_bytes: 0,
          managed_swap_limit_bytes: 0,
        },
      },
    ] as DatabaseMetricSnapshot[];

    render(
      <DatabaseOverviewTab
        database={database}
        canViewMonitoring
        healthStatus="online"
        history={disabledSwapHistory}
        monitoringLoading={false}
      />
    );

    const swapCard = screen.getByText("Swap").closest(".border") as HTMLElement | null;
    expect(swapCard).not.toBeNull();
    expect(within(swapCard!).getByText("Disabled")).toBeInTheDocument();
    expect(swapCard?.querySelector("svg.w-full")).toBeNull();
  });

  it("hides managed monitoring while the database is paused", () => {
    render(
      <DatabaseOverviewTab
        database={{ ...database, managed: { ...database.managed!, status: "paused" } }}
        canViewMonitoring
        healthStatus="paused"
        history={history}
        monitoringLoading={false}
      />
    );

    expect(screen.queryByText("Database Size")).not.toBeInTheDocument();
    expect(screen.getByText("Paused")).toBeInTheDocument();
  });
});
