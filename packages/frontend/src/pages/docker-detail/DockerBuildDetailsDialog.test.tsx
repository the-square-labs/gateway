import { act, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/services/api";
import type { DockerBuild } from "@/types";
import { DockerBuildDetailsDialog } from "./DockerBuildDetailsDialog";

vi.mock("@/hooks/use-realtime", () => ({ useRealtime: vi.fn() }));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("loads logs once and relies on realtime updates while an active dialog is open", async () => {
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
  expect(request).toHaveBeenCalledTimes(1);
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
