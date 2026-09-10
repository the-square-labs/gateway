import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { DockerBuild } from "@/types";
import { DockerBuildDetailsDialog } from "./DockerBuildDetailsDialog";

const realtime = vi.hoisted(() => ({ onReconnect: undefined as (() => void) | undefined }));

vi.mock("@/hooks/use-realtime", () => ({
  useRealtime: vi.fn(
    (
      _topic: string | null,
      _handler: (payload: unknown) => void,
      options?: { onReconnect?: () => void }
    ) => {
      realtime.onReconnect = options?.onReconnect;
    }
  ),
}));

afterEach(() => {
  realtime.onReconnect = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("refreshes build logs after the realtime connection reconnects", async () => {
  const request = vi.spyOn(api, "getDockerBuildLogs").mockResolvedValue([]);

  render(
    <DockerBuildDetailsDialog
      open
      build={build("building")}
      onOpenChange={() => undefined}
      onExited={() => undefined}
    />
  );

  await act(async () => undefined);
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => realtime.onReconnect?.());
  expect(request).toHaveBeenCalledTimes(2);
});

it("polls logs while an active build is open so a missed realtime event cannot leave them empty", async () => {
  vi.useFakeTimers();
  const request = vi.spyOn(api, "getDockerBuildLogs").mockResolvedValue([]);

  render(
    <DockerBuildDetailsDialog
      open
      build={build("building")}
      onOpenChange={() => undefined}
      onExited={() => undefined}
    />
  );

  await act(async () => undefined);
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => vi.advanceTimersByTimeAsync(6_000));
  expect(request).toHaveBeenCalledTimes(4);
});

it.each([
  "all",
  "application",
] as const)("keeps OS and application findings visible under %s scope", async (policyScope) => {
  vi.spyOn(api, "getDockerBuildLogs").mockResolvedValue([]);
  const item = build("failed");
  item.artifact = {
    id: "artifact-1",
    buildId: item.id,
    registryRepository: "app",
    digest: "sha256:artifact",
    platform: "linux/amd64",
    sizeBytes: 100,
    status: "rejected",
    sbomDigest: null,
    provenanceDigest: null,
    policyDecision: "rejected",
    policyReason: "Application vulnerabilities at or above critical: critical",
    verifiedAt: null,
    createdAt: item.createdAt,
    scanSummary: {
      critical: 2,
      high: 0,
      medium: 0,
      low: 0,
      unknown: 0,
      policyScope,
      osPackages: { critical: 1, high: 0, medium: 0, low: 0, unknown: 0 },
      vulnerabilities: ["deb", "npm"].map((packageType) => ({
        id: `CVE-${packageType}`,
        severity: "critical",
        packageName: `${packageType}-package`,
        packageType,
        installedVersion: "1",
        fixedVersions: [],
        fixState: "not-fixed",
        namespace: "",
        dataSource: "",
      })),
    },
  };
  render(
    <DockerBuildDetailsDialog
      open
      build={item}
      onOpenChange={() => undefined}
      onExited={() => undefined}
    />
  );
  await act(async () => undefined);
  expect(screen.getByText("CVE-deb")).toBeInTheDocument();
  expect(screen.getByText("CVE-npm")).toBeInTheDocument();
  if (policyScope === "application") {
    expect(screen.getAllByText("OS package · Report only")).toHaveLength(1);
    expect(screen.getByText(/1 system package findings/)).toBeInTheDocument();
  } else {
    expect(screen.queryByText("OS package · Report only")).not.toBeInTheDocument();
  }
});

function build(status: DockerBuild["status"]): DockerBuild {
  return {
    id: "build-1",
    sourceBindingId: "11111111-1111-4111-8111-111111111111",
    batchId: null,
    serviceName: null,
    provider: "github",
    trigger: "github_push",
    repositoryFullPath: "wiolett/test",
    ref: "refs/heads/main",
    commitSha: "a".repeat(40),
    status,
    builderNodeId: "22222222-2222-4222-8222-222222222222",
    builderName: "builder-1",
    platform: "linux/amd64",
    attempt: 1,
    maxAttempts: 3,
    errorCode: null,
    errorMessage: null,
    progress: {},
    artifact: null,
    target: {
      kind: "pages_project",
      pageProjectId: "33333333-3333-4333-8333-333333333333",
      name: "test-pages",
    },
    createdAt: "2026-08-26T08:00:00.000Z",
    queuedAt: "2026-08-26T08:00:00.000Z",
    startedAt: "2026-08-26T08:00:01.000Z",
    completedAt: null,
  };
}
