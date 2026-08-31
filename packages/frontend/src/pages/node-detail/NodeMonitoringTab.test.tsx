import { act, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { DockerBuild, NodeHealthReport } from "@/types";
import { NodeMonitoringTab } from "./NodeMonitoringTab";

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));

const listeners = new Map<string, (event: MessageEvent) => void>();

afterEach(() => {
  listeners.clear();
  vi.restoreAllMocks();
});

it("renders the current snapshot immediately and ignores older stream history", () => {
  vi.spyOn(api, "createNodeMonitoringStream").mockReturnValue({
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      listeners.set(name, listener as (event: MessageEvent) => void);
    }),
    close: vi.fn(),
  } as unknown as EventSource);

  render(
    <NodeMonitoringTab
      nodeId="11111111-1111-4111-8111-111111111111"
      nodeStatus="online"
      nodeType="nginx"
      initialHealthReport={healthReport()}
    />
  );

  expect(screen.queryByLabelText("Loading node monitoring")).not.toBeInTheDocument();
  expect(screen.getByText("nginx/1.28.3")).toBeInTheDocument();
  expect(screen.getByText("Running")).toBeInTheDocument();
  expect(screen.getByText("Config valid")).toBeInTheDocument();

  act(() => {
    listeners.get("connected")?.(
      new MessageEvent("connected", {
        data: JSON.stringify({
          history: [
            {
              timestamp: "2026-08-31T07:59:00.000Z",
              health: { ...healthReport(), nginxRunning: false, configValid: false },
              stats: null,
              traffic: null,
            },
          ],
        }),
      })
    );
  });

  expect(screen.getByText("nginx/1.28.3")).toBeInTheDocument();
  expect(screen.getByText("Running")).toBeInTheDocument();
  expect(screen.getByText("Config valid")).toBeInTheDocument();
  expect(screen.getByText("Disabled")).toBeInTheDocument();
  expect(screen.getByText("No swap configured")).toBeInTheDocument();
  expect(screen.queryByText("Stopped")).not.toBeInTheDocument();
  expect(screen.queryByText("Config invalid")).not.toBeInTheDocument();
});

it("renders monitoring sparklines from bootstrap history before SSE connects", () => {
  vi.spyOn(api, "createNodeMonitoringStream").mockReturnValue({
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      listeners.set(name, listener as (event: MessageEvent) => void);
    }),
    close: vi.fn(),
  } as unknown as EventSource);
  const initialHealth = healthReport();

  render(
    <NodeMonitoringTab
      nodeId="11111111-1111-4111-8111-111111111111"
      nodeStatus="online"
      nodeType="nginx"
      initialHealthReport={initialHealth}
      initialMonitoringHistory={[
        {
          timestamp: "2026-08-31T07:59:50.000Z",
          health: { ...initialHealth, cpuPercent: 7 },
          stats: null,
          traffic: null,
        },
        {
          timestamp: "2026-08-31T08:00:00.000Z",
          health: initialHealth,
          stats: null,
          traffic: null,
        },
      ]}
    />
  );

  const cpuCard = screen.getByText("CPU").closest(".border");
  expect(cpuCard?.querySelectorAll("svg")).toHaveLength(2);
});

it("discards the previous node history and closes its stream when nodeId changes", () => {
  const close = vi.fn();
  vi.spyOn(api, "createNodeMonitoringStream").mockImplementation(
    () =>
      ({
        addEventListener: vi.fn((name: string, listener: EventListener) => {
          listeners.set(name, listener as (event: MessageEvent) => void);
        }),
        close,
      }) as unknown as EventSource
  );
  const firstHealth = { ...healthReport(), cpuPercent: 7 };
  const secondHealth = {
    ...healthReport(),
    cpuPercent: 80,
    timestamp: Date.parse("2026-08-31T08:01:00.000Z") / 1000,
  };
  const { rerender } = render(
    <NodeMonitoringTab
      nodeId="11111111-1111-4111-8111-111111111111"
      nodeStatus="online"
      nodeType="nginx"
      initialHealthReport={firstHealth}
      initialMonitoringHistory={[
        {
          timestamp: "2026-08-31T08:00:00.000Z",
          health: firstHealth,
          stats: null,
          traffic: null,
        },
      ]}
    />
  );

  rerender(
    <NodeMonitoringTab
      nodeId="22222222-2222-4222-8222-222222222222"
      nodeStatus="online"
      nodeType="nginx"
      initialHealthReport={secondHealth}
      initialMonitoringHistory={[
        {
          timestamp: "2026-08-31T08:01:00.000Z",
          health: secondHealth,
          stats: null,
          traffic: null,
        },
      ]}
    />
  );

  expect(close).toHaveBeenCalledOnce();
  const cpuCard = screen.getByText("CPU").closest(".border");
  const sparkline = cpuCard?.querySelector("polyline[fill='none']");
  expect(sparkline?.getAttribute("points")?.trim().split(/\s+/)).toHaveLength(2);
});

it("shows Build Worker activity from recent assigned jobs", async () => {
  vi.spyOn(api, "createNodeMonitoringStream").mockReturnValue({
    addEventListener: vi.fn((name: string, listener: EventListener) => {
      listeners.set(name, listener as (event: MessageEvent) => void);
    }),
    close: vi.fn(),
  } as unknown as EventSource);
  vi.spyOn(api, "listDockerBuildPage").mockResolvedValue({
    data: [build("complete", "succeeded"), build("active", "building")],
    nextCursor: null,
  });

  render(
    <NodeMonitoringTab
      nodeId="11111111-1111-4111-8111-111111111111"
      nodeStatus="online"
      nodeType="builder"
      initialHealthReport={healthReport()}
    />
  );

  act(() => {
    listeners.get("connected")?.(
      new MessageEvent("connected", {
        data: JSON.stringify({
          history: [
            {
              timestamp: "2026-08-31T08:00:00.000Z",
              health: healthReport(),
              stats: null,
              traffic: null,
            },
          ],
        }),
      })
    );
  });

  expect(await screen.findByRole("heading", { name: "Build activity" })).toBeInTheDocument();
  const runningCard = screen.getByText("Running jobs").closest(".border");
  const durationCard = screen.getByText("Average duration").closest(".border");
  const successCard = screen.getByText("Success rate").closest(".border");
  const vulnerabilitiesCard = screen.getByText("Vulnerabilities").closest(".border");

  expect(within(runningCard as HTMLElement).getByText("1")).toBeInTheDocument();
  expect(within(durationCard as HTMLElement).getByText("9s")).toBeInTheDocument();
  expect(within(successCard as HTMLElement).getByText("100%")).toBeInTheDocument();
  expect(within(vulnerabilitiesCard as HTMLElement).getByText("15")).toBeInTheDocument();
  expect(runningCard?.querySelector("svg")).not.toBeNull();
  expect(durationCard?.querySelector("svg")).not.toBeNull();
  expect(successCard?.querySelector("svg")).not.toBeNull();
  expect(vulnerabilitiesCard?.querySelector("svg")).not.toBeNull();
});

function healthReport(): NodeHealthReport {
  return {
    nginxRunning: true,
    configValid: true,
    nginxUptimeSeconds: 3600,
    workerCount: 2,
    nginxVersion: "1.28.3",
    cpuPercent: 10,
    memoryBytes: 1024,
    diskFreeBytes: 1024,
    timestamp: Date.parse("2026-08-31T08:00:00.000Z") / 1000,
    loadAverage1m: 0.1,
    loadAverage5m: 0.2,
    loadAverage15m: 0.3,
    systemMemoryTotalBytes: 4096,
    systemMemoryUsedBytes: 1024,
    systemMemoryAvailableBytes: 3072,
    swapTotalBytes: 0,
    swapUsedBytes: 0,
    systemUptimeSeconds: 7200,
    openFileDescriptors: 10,
    maxFileDescriptors: 1024,
    diskMounts: [
      {
        mountPoint: "/",
        filesystem: "ext4",
        device: "/dev/vda1",
        totalBytes: 8192,
        usedBytes: 2048,
        freeBytes: 6144,
        usagePercent: 25,
      },
    ],
    diskReadBytes: 0,
    diskWriteBytes: 0,
    networkInterfaces: [],
    localIpAddresses: [],
    publicIpAddresses: [],
    nginxRssBytes: 76_120_064,
    errorRate4xx: 0,
    errorRate5xx: 0,
  };
}

function build(id: string, status: DockerBuild["status"]): DockerBuild {
  const completed = status === "succeeded";
  return {
    id,
    sourceBindingId: "22222222-2222-4222-8222-222222222222",
    batchId: null,
    serviceName: null,
    provider: "github",
    trigger: "github_push",
    repositoryFullPath: `wiolett/${id}`,
    ref: "refs/heads/main",
    commitSha: "a".repeat(40),
    status,
    builderNodeId: "11111111-1111-4111-8111-111111111111",
    builderName: "Build Worker",
    platform: "linux/amd64",
    attempt: 1,
    maxAttempts: 3,
    errorCode: null,
    errorMessage: null,
    progress: {},
    artifact: completed
      ? {
          id: "33333333-3333-4333-8333-333333333333",
          buildId: id,
          registryRepository: "build/test",
          digest: `sha256:${"b".repeat(64)}`,
          platform: "linux/amd64",
          sizeBytes: 1024,
          status: "ready",
          sbomDigest: null,
          provenanceDigest: null,
          scanSummary: {
            critical: 1,
            high: 2,
            medium: 3,
            low: 4,
            unknown: 5,
          },
          policyDecision: "approved",
          policyReason: null,
          verifiedAt: "2026-08-31T08:00:10.000Z",
          createdAt: "2026-08-31T08:00:10.000Z",
        }
      : null,
    target: {
      kind: "pages_project",
      pageProjectId: "44444444-4444-4444-8444-444444444444",
      name: "Docs",
    },
    createdAt: "2026-08-31T08:00:00.000Z",
    queuedAt: "2026-08-31T08:00:00.000Z",
    startedAt: "2026-08-31T08:00:01.000Z",
    completedAt: completed ? "2026-08-31T08:00:10.000Z" : null,
  };
}
