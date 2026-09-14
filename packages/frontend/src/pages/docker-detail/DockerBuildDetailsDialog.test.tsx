import { act, fireEvent, render, screen } from "@testing-library/react";
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
  { policyScope: "all", osOnly: false, legacy: false },
  { policyScope: "application", osOnly: false, legacy: false },
  { policyScope: "application", osOnly: true, legacy: false },
  { policyScope: "application", osOnly: false, legacy: true },
] as const)("respects scan report scope $policyScope (osOnly=$osOnly, legacy=$legacy)", async ({
  policyScope,
  osOnly,
  legacy,
}) => {
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
      critical: osOnly ? 1 : 2,
      high: 0,
      medium: 0,
      low: 0,
      unknown: 0,
      policyScope,
      osPackages: legacy ? undefined : { critical: 1, high: 0, medium: 0, low: 0, unknown: 0 },
      vulnerabilities: (osOnly ? ["deb"] : ["deb", "npm"]).map((packageType) => ({
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
  const view = render(
    <DockerBuildDetailsDialog
      open
      build={item}
      onOpenChange={() => undefined}
      onExited={() => undefined}
    />
  );
  await act(async () => undefined);
  if (!osOnly) expect(screen.getByText("CVE-npm")).toBeInTheDocument();
  if (policyScope === "application" && !legacy) {
    expect(screen.queryByText("CVE-deb")).not.toBeInTheDocument();
    expect(screen.queryByText("2 critical")).not.toBeInTheDocument();
    if (osOnly)
      expect(
        screen.getByText("No application-scope vulnerabilities detected.")
      ).toBeInTheDocument();
    else expect(screen.getByText("1 critical")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Include system packages" }));
    expect(screen.getByText("CVE-deb")).toBeInTheDocument();
    expect(screen.getAllByText("OS package · Report only")).toHaveLength(1);
    expect(screen.getByText(/1 system package findings/)).toBeInTheDocument();
    view.rerender(
      <DockerBuildDetailsDialog
        open
        build={{ ...item, id: "next-build" }}
        onOpenChange={() => undefined}
        onExited={() => undefined}
      />
    );
    expect(screen.queryByText("CVE-deb")).not.toBeInTheDocument();
  } else {
    expect(screen.getByText("CVE-deb")).toBeInTheDocument();
    expect(screen.queryByText("OS package · Report only")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Include system packages" })
    ).not.toBeInTheDocument();
  }
});

it("labels a skipped scan as disabled, never as a clean scan", async () => {
  vi.spyOn(api, "getDockerBuildLogs").mockResolvedValue([]);
  const item = build("succeeded");
  item.artifact = {
    policyDecision: "approved",
    scanSummary: {
      scanner: "disabled",
      skipped: true,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      unknown: 0,
    },
  } as DockerBuild["artifact"];
  render(
    <DockerBuildDetailsDialog
      open
      build={item}
      onOpenChange={() => undefined}
      onExited={() => undefined}
    />
  );
  await act(async () => undefined);
  expect(screen.getByText("Vulnerability scan")).toBeInTheDocument();
  expect(screen.getByText("Disabled")).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Vulnerabilities" })).not.toBeInTheDocument();
  expect(
    screen.queryByText("No application-scope vulnerabilities detected.")
  ).not.toBeInTheDocument();
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
