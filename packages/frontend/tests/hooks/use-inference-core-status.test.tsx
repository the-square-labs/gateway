import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InferenceCoreStatus } from "@/types/inference-core";
import {
  INFERENCE_CORE_CHANGED_CHANNEL,
  isStaleInferenceCoreStatus,
  useInferenceCoreStatus,
} from "../../src/hooks/use-inference-core-status";

const mocks = vi.hoisted(() => {
  const realtimeHandlers: Array<(payload: unknown) => void> = [];
  return {
    getInferenceCoreStatus: vi.fn(),
    realtimeHandlers,
    subscribe: vi.fn((_channel: string, handler: (payload: unknown) => void) => {
      realtimeHandlers.push(handler);
      return vi.fn();
    }),
    onReconnect: vi.fn(() => vi.fn()),
  };
});

vi.mock("@/services/api", () => ({
  api: { getInferenceCoreStatus: mocks.getInferenceCoreStatus },
}));

vi.mock("@/services/event-stream", () => ({
  eventStream: { subscribe: mocks.subscribe, onReconnect: mocks.onReconnect },
}));

function makeStatus(overrides: Partial<InferenceCoreStatus> = {}): InferenceCoreStatus {
  return {
    state: "not_installed",
    installed: null,
    latest: null,
    compatibility: "unknown",
    health: {
      status: "unknown",
      version: null,
      coreProtocolMajor: null,
      stateSchemaVersion: null,
      checkedAt: null,
    },
    operation: null,
    lastError: null,
    ...overrides,
  };
}

function makeOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    kind: "install" as const,
    phase: "pulling" as const,
    status: "running" as const,
    progress: null,
    fromVersion: null,
    toVersion: "2.26.0-wiolett.1",
    fromDigest: null,
    toDigest: null,
    error: null,
    startedAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:20.000Z",
    finishedAt: null,
    ...overrides,
  };
}

describe("isStaleInferenceCoreStatus", () => {
  it("rejects an event for an older operation", () => {
    const current = makeStatus({ operation: makeOperation() });
    const stale = makeStatus({
      operation: makeOperation({
        id: "00000000-0000-4000-8000-000000000000",
        startedAt: "2026-08-18T23:00:00.000Z",
      }),
    });
    expect(isStaleInferenceCoreStatus(current, stale)).toBe(true);
  });

  it("rejects an older revision of the same operation", () => {
    const current = makeStatus({ operation: makeOperation() });
    const stale = makeStatus({
      operation: makeOperation({ updatedAt: "2026-08-19T00:00:05.000Z" }),
    });
    expect(isStaleInferenceCoreStatus(current, stale)).toBe(true);
  });

  it("accepts a newer operation and a newer revision", () => {
    const current = makeStatus({ operation: makeOperation() });
    const newerOperation = makeStatus({
      operation: makeOperation({
        id: "11111111-1111-4111-8111-111111111111",
        startedAt: "2026-08-19T01:00:00.000Z",
      }),
    });
    const newerRevision = makeStatus({
      operation: makeOperation({ updatedAt: "2026-08-19T00:01:00.000Z" }),
    });
    expect(isStaleInferenceCoreStatus(current, newerOperation)).toBe(false);
    expect(isStaleInferenceCoreStatus(current, newerRevision)).toBe(false);
    expect(isStaleInferenceCoreStatus(null, makeStatus())).toBe(false);
  });
});

describe("useInferenceCoreStatus", () => {
  afterEach(() => {
    mocks.getInferenceCoreStatus.mockReset();
    mocks.subscribe.mockClear();
    mocks.onReconnect.mockClear();
    mocks.realtimeHandlers.length = 0;
  });

  it("resumes server state after a reload via GET /status", async () => {
    const running = makeStatus({ state: "pulling", operation: makeOperation() });
    mocks.getInferenceCoreStatus.mockResolvedValue(running);

    const { result } = renderHook(() => useInferenceCoreStatus());

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.status?.operation?.id).toBe(running.operation!.id));
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mocks.subscribe).toHaveBeenCalledWith(
      INFERENCE_CORE_CHANGED_CHANNEL,
      expect.any(Function)
    );
  });

  it("applies realtime events and ignores stale operation snapshots", async () => {
    const running = makeStatus({ state: "pulling", operation: makeOperation() });
    mocks.getInferenceCoreStatus.mockResolvedValue(running);
    const { result } = renderHook(() => useInferenceCoreStatus());
    await waitFor(() => expect(result.current.status?.state).toBe("pulling"));

    const stale = makeStatus({
      state: "resolving",
      operation: makeOperation({
        id: "00000000-0000-4000-8000-000000000000",
        phase: "resolving",
        startedAt: "2026-08-18T23:00:00.000Z",
      }),
    });
    act(() => {
      for (const handler of mocks.realtimeHandlers) handler(stale);
    });
    expect(result.current.status?.state).toBe("pulling");

    const ready = makeStatus({ state: "ready", compatibility: "compatible" });
    act(() => {
      for (const handler of mocks.realtimeHandlers) handler(ready);
    });
    expect(result.current.status?.state).toBe("ready");
  });

  it("polls while an operation is running and stops when it completes", async () => {
    vi.useFakeTimers();
    try {
      const running = makeStatus({ state: "pulling", operation: makeOperation() });
      mocks.getInferenceCoreStatus.mockResolvedValue(running);
      const { result } = renderHook(() => useInferenceCoreStatus());
      await act(async () => {});
      expect(result.current.status?.state).toBe("pulling");
      expect(mocks.getInferenceCoreStatus).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_600);
      });
      expect(mocks.getInferenceCoreStatus.mock.calls.length).toBeGreaterThanOrEqual(2);

      mocks.getInferenceCoreStatus.mockResolvedValue(
        makeStatus({ state: "ready", compatibility: "compatible" })
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_600);
      });
      expect(result.current.status?.state).toBe("ready");
      const calls = mocks.getInferenceCoreStatus.mock.calls.length;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6_000);
      });
      expect(mocks.getInferenceCoreStatus.mock.calls.length).toBe(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fetch while disabled", () => {
    renderHook(() => useInferenceCoreStatus(false));
    expect(mocks.getInferenceCoreStatus).not.toHaveBeenCalled();
    expect(mocks.subscribe).not.toHaveBeenCalled();
  });
});
