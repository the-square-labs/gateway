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
