import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerBuild } from "@/types";
import { formatDockerBuildDuration, useDockerBuildClock } from "./docker-build-duration";
import { ACTIVE_DOCKER_BUILD_STATUSES } from "./docker-build-status";

const start = Date.parse("2026-09-10T12:00:00.000Z");

function build(overrides: Partial<DockerBuild> & { updatedAt?: string } = {}): DockerBuild {
  return {
    id: "build-1",
    sourceBindingId: "source-1",
    batchId: null,
    serviceName: null,
    provider: "gitlab",
    trigger: "manual",
    repositoryFullPath: "group/repo",
    ref: "refs/heads/main",
    commitSha: "a".repeat(40),
    status: "building",
    builderNodeId: null,
    platform: null,
    attempt: 1,
    maxAttempts: 3,
    errorCode: null,
    errorMessage: null,
    progress: { elapsedSeconds: 5 },
    artifact: null,
    target: { kind: "container", nodeId: "node-1", containerName: "app", name: "app" },
    createdAt: new Date(start - 10_000).toISOString(),
    queuedAt: new Date(start - 10_000).toISOString(),
    startedAt: new Date(start).toISOString(),
    completedAt: null,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("formatDockerBuildDuration", () => {
  it.each([
    ...ACTIVE_DOCKER_BUILD_STATUSES,
  ])("uses wall clock for %s despite stale progress", (status) => {
    expect(formatDockerBuildDuration(build({ status }), start + 61_000)).toBe("1m 1s");
  });

  it("uses queuedAt until the build starts", () => {
    expect(
      formatDockerBuildDuration(build({ status: "queued", startedAt: null }), start + 1_000)
    ).toBe("11s");
  });

  it.each([
    "succeeded",
    "failed",
    "cancelled",
    "superseded",
  ] as const)("freezes %s at completedAt even when the supplied clock advances", (status) => {
    const row = build({ status, completedAt: new Date(start + 65_000).toISOString() });
    expect(formatDockerBuildDuration(row, start + 90_000)).toBe("1m 5s");
    expect(formatDockerBuildDuration(row, start + 900_000)).toBe("1m 5s");
  });

  it.each([
    0,
    12,
    "12",
  ])("uses stable terminal progress %s without completedAt", (elapsedSeconds) => {
    const row = build({ status: "failed", progress: { elapsedSeconds } });
    expect(formatDockerBuildDuration(row, start + 90_000)).toBe(`${elapsedSeconds}s`);
    expect(formatDockerBuildDuration(row, start + 900_000)).toBe(`${elapsedSeconds}s`);
  });

  it.each([
    undefined,
    null,
    "",
    " ",
    true,
    {},
    -5,
    "bad",
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("falls back to updatedAt for invalid terminal progress %j", (elapsedSeconds) => {
    const row = build({
      status: "cancelled",
      completedAt: "invalid",
      progress: { elapsedSeconds },
      updatedAt: new Date(start + 42_000).toISOString(),
    });
    expect(formatDockerBuildDuration(row, start + 90_000)).toBe("42s");
    expect(formatDockerBuildDuration(row, start + 900_000)).toBe("42s");
  });

  it("guards missing or invalid timing and clamps negative durations", () => {
    expect(formatDockerBuildDuration(build({ startedAt: "invalid" }), start)).toBe("—");
    expect(formatDockerBuildDuration(build(), Number.NaN)).toBe("—");
    expect(formatDockerBuildDuration(build(), start - 1_000)).toBe("0s");
    expect(formatDockerBuildDuration(build({ status: "failed", progress: {} }), start)).toBe("—");
    expect(
      formatDockerBuildDuration(
        build({ status: "failed", completedAt: new Date(start - 1_000).toISOString() }),
        start
      )
    ).toBe("0s");
  });
});

describe("useDockerBuildClock", () => {
  it.each([
    ...ACTIVE_DOCKER_BUILD_STATUSES,
  ])("ticks once per second for %s and cleans up on unmount", (status) => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const { result, unmount } = renderHook(() => useDockerBuildClock([build({ status }), build()]));
    expect(vi.getTimerCount()).toBe(1);
    expect(result.current).toBe(start);
    act(() => vi.advanceTimersByTime(999));
    expect(result.current).toBe(start);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(start + 1_000);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts only for active rows, keeps one interval across refreshes, and stops when all finish", () => {
    vi.useFakeTimers();
    vi.setSystemTime(start);
    const { result, rerender, unmount } = renderHook(
      (rows: DockerBuild[]) => useDockerBuildClock(rows),
      { initialProps: [] as DockerBuild[] }
    );
    expect(vi.getTimerCount()).toBe(0);
    rerender([build({ status: "succeeded" })]);
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current).toBe(start);

    rerender([build()]);
    expect(result.current).toBe(start + 10_000);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(500));
    rerender([build(), build({ id: "build-2" })]);
    expect(vi.getTimerCount()).toBe(1);
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(start + 11_000);

    rerender([build({ status: "succeeded" }), build({ status: "cancelled" })]);
    expect(vi.getTimerCount()).toBe(0);
    const stopped = result.current;
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current).toBe(stopped);
    rerender([build({ status: "queued" })]);
    expect(result.current).toBe(start + 21_000);
    expect(vi.getTimerCount()).toBe(1);
    rerender([]);
    expect(vi.getTimerCount()).toBe(0);
    unmount();
  });
});
