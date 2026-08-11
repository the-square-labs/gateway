import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { api } from "@/services/api";
import { SecureLinkTab } from "./SecureLinkTab";

describe("SecureLinkTab", () => {
  it("renders route and host telemetry without global relay metrics", async () => {
    const intervalSpy = vi.spyOn(window, "setInterval");
    const status = {
      state: "active",
      generation: 2,
      sourceNodeId: "11111111-1111-4111-8111-111111111111",
      targetNodeId: "22222222-2222-4222-8222-222222222222",
      transport: "grpc-http2-mtls",
      migratedAt: "2026-08-11T12:00:00.000Z",
      lastError: null,
      healthCheck: { enabled: true, intervalSeconds: 30 },
      sourceNode: { id: "11111111-1111-4111-8111-111111111111", name: "edge-1", status: "online" },
      targetNode: {
        id: "22222222-2222-4222-8222-222222222222",
        name: "docker-1",
        status: "online",
      },
      rateLimit: {
        mode: "inherit",
        enabled: true,
        requestsPerSecond: 1000,
        burst: 3000,
        connectionsPerIp: 1000,
      },
      runtime: {
        routeId: "route-1",
        activeStreams: 7,
        openedTotal: "20",
        completedTotal: "13",
        failedTotal: "0",
        throttledTotal: "0",
        sourceToTargetBytes: "1024",
        targetToSourceBytes: "2048",
        setupLatencyP95Ms: 12,
        averageDurationMs: 180,
        lastActivityAt: "2026-08-11T12:01:00.000Z",
        metricsSince: "2026-08-11T11:00:00.000Z",
      },
      traffic: {
        hostId: "host-1",
        statusCodes: { s2xx: 149, s3xx: 0, s4xx: 1, s5xx: 0 },
        avgResponseTime: 0.01,
        p95ResponseTime: 0.03,
        totalRequests: 150,
        totalBytes: 4096,
        requestsPerSecond: 10,
        bytesPerSecond: 273,
        busiestClientRps: 25,
        windowSeconds: 15,
        sampleTruncated: false,
        lastRequestAt: "2026-08-11T12:01:00.000Z",
      },
      history: [],
    } satisfies Awaited<ReturnType<typeof api.getProxySecureLinkStatus>>;
    vi.spyOn(api, "getProxySecureLinkStatus").mockResolvedValue(status);

    render(<SecureLinkTab hostId="host-1" />);

    expect(await screen.findByText("Link traffic")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
    expect(screen.getByText("Hottest client")).toBeInTheDocument();
    expect(screen.getByText("E2E probe every 30s")).toBeInTheDocument();
    expect(screen.getByText("of 1,000 r/s per-IP limit")).toBeInTheDocument();
    expect(screen.queryByText("Path & policy")).not.toBeInTheDocument();
    expect(screen.queryByText("Metrics since")).not.toBeInTheDocument();
    expect(screen.queryByText("Relay tunnels")).not.toBeInTheDocument();
    expect(screen.queryByText(/Last relay probe/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/route telemetry/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/rate limit inherit/i)).not.toBeInTheDocument();
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
  });
});
