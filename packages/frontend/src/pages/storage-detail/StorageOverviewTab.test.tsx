import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ObjectStorageConnection, ObjectStorageMetricSnapshot } from "@/types";
import { StorageOverviewTab } from "./StorageOverviewTab";

vi.mock("@/components/ui/stat-card", () => ({
  StatCard: ({ label, value, history }: { label: string; value: string; history: number[] }) => (
    <div data-testid={label} data-history={JSON.stringify(history)}>
      {value}
    </div>
  ),
}));

const storage = { provider: "minio", healthStatus: "online" } as ObjectStorageConnection;
const snapshot = (cpu: number | null): ObjectStorageMetricSnapshot => ({
  timestamp: new Date().toISOString(),
  storageId: "s1",
  provider: "minio",
  name: "Storage",
  status: "online",
  responseMs: 10,
  metrics: { cpu_pct: cpu, latency_ms: 10, bucket_count: 1 },
});

describe("storage resource sampling gaps", () => {
  it("does not draw missing resource measurements as zero or join across missing samples", () => {
    const view = (history: ObjectStorageMetricSnapshot[]) => (
      <StorageOverviewTab
        storage={storage}
        canViewMonitoring
        healthStatus="online"
        history={history}
        monitoringLoading={false}
      />
    );
    const rendered = render(view([snapshot(12), snapshot(null)]));
    expect(screen.getByTestId("CPU")).toHaveAttribute("data-history", "[]");
    expect(screen.getByTestId("CPU")).not.toHaveTextContent("12");
    expect(screen.getByTestId("Latency")).toHaveAttribute("data-history", "[10,10]");
    rendered.rerender(view([snapshot(12), snapshot(null), snapshot(0), snapshot(25)]));
    expect(screen.getByTestId("CPU")).toHaveAttribute("data-history", "[0,25]");
    expect(screen.getByTestId("CPU")).toHaveTextContent("25");
  });
});

describe("managed storage engine details", () => {
  const managed = {
    id: "cluster-1",
    nodeId: "node-1",
    storageSizeBytes: 1024,
    runtimeConfig: { cpuCores: 1, memoryMb: 1024, swapMb: 0 },
    publishedPort: 9000,
    status: "ready",
    lastError: null,
  } as const;
  const view = (value: ObjectStorageConnection) => (
    <StorageOverviewTab
      storage={value}
      canViewMonitoring={false}
      healthStatus="online"
      history={[]}
      monitoringLoading={false}
    />
  );

  it("shows the SeaweedFS engine and version for new clusters", () => {
    render(
      view({
        ...storage,
        provider: "seaweedfs",
        managed: { ...managed, engine: "seaweedfs", version: "4.47" },
      })
    );
    expect(screen.getByText("SeaweedFS 4.47")).toBeInTheDocument();
    expect(screen.getAllByText("SeaweedFS").length).toBeGreaterThan(0);
    expect(screen.queryByText("Legacy")).not.toBeInTheDocument();
  });

  it("labels a cluster without an engine as legacy MinIO and explains the image error", () => {
    render(
      view({
        ...storage,
        managed: { ...managed, version: "2025-04-22" },
        lastError: "managed storage engine image unavailable",
      })
    );
    expect(screen.getByText("MinIO 2025-04-22")).toBeInTheDocument();
    expect(screen.getByText("Legacy")).toBeInTheDocument();
    expect(screen.getByText(/can no longer be downloaded/)).toBeInTheDocument();
  });
});
