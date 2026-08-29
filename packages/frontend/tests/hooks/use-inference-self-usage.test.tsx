import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INFERENCE_USAGE_CHANGED_CHANNEL } from "@/lib/inference-self-usage";
import type { InferenceSelfUsage } from "@/types/inference";
import { useInferenceSelfUsage } from "../../src/hooks/use-inference-self-usage";

const mocks = vi.hoisted(() => {
  const realtimeHandlers: Array<() => void> = [];
  return {
    getCached: vi.fn(),
    getInferenceSelfUsage: vi.fn(),
    realtimeHandlers,
    subscribe: vi.fn((_channel: string, handler: () => void) => {
      realtimeHandlers.push(handler);
      return vi.fn();
    }),
  };
});

vi.mock("@/services/api", () => ({
  api: {
    getCached: mocks.getCached,
    getInferenceSelfUsage: mocks.getInferenceSelfUsage,
  },
}));

vi.mock("@/services/event-stream", () => ({
  eventStream: { subscribe: mocks.subscribe },
}));

const usage = (percentage: number): InferenceSelfUsage => ({
  enabled: true,
  api: { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
  subscription: {
    "5h": { configured: false, percentage: 0, recoveryAt: "2030-01-01T00:00:00.000Z" },
    "7d": {
      configured: true,
      percentage,
      recoveryAt: "2030-01-07T00:00:00.000Z",
    },
    "30d": { configured: false, percentage: 0, recoveryAt: "2030-01-30T00:00:00.000Z" },
  },
});

describe("useInferenceSelfUsage", () => {
  afterEach(() => {
    mocks.getCached.mockReset();
    mocks.getInferenceSelfUsage.mockReset();
    mocks.subscribe.mockClear();
    mocks.realtimeHandlers.length = 0;
  });

  it("refreshes every mounted usage surface from one realtime invalidation", async () => {
    mocks.getCached.mockReturnValue(undefined);
    mocks.getInferenceSelfUsage.mockResolvedValueOnce(usage(40));

    const { result } = renderHook(() => ({
      profile: useInferenceSelfUsage(),
      dashboard: useInferenceSelfUsage(),
    }));

    await waitFor(() => {
      expect(result.current.profile.usage?.subscription["7d"].percentage).toBe(40);
      expect(result.current.dashboard.usage?.subscription["7d"].percentage).toBe(40);
    });
    expect(mocks.getInferenceSelfUsage).toHaveBeenCalledTimes(1);
    // Each mounted consumer listens for usage settlements and catalog changes;
    // request deduplication still keeps the initial read to one request.
    expect(mocks.subscribe).toHaveBeenCalledTimes(4);
    expect(mocks.subscribe).toHaveBeenCalledWith(
      INFERENCE_USAGE_CHANGED_CHANNEL,
      expect.any(Function)
    );

    mocks.getInferenceSelfUsage.mockResolvedValueOnce(usage(85));
    await act(async () => {
      for (const handler of mocks.realtimeHandlers) handler();
    });

    await waitFor(() => {
      expect(result.current.profile.usage?.subscription["7d"].percentage).toBe(85);
      expect(result.current.dashboard.usage?.subscription["7d"].percentage).toBe(85);
    });
    expect(mocks.getInferenceSelfUsage).toHaveBeenCalledTimes(2);
  });

  it("uses the dashboard-warmed usage snapshot without issuing another initial request", () => {
    mocks.getCached.mockReturnValue(usage(40));

    const { result } = renderHook(() => useInferenceSelfUsage());

    expect(result.current.loading).toBe(false);
    expect(result.current.usage?.subscription["7d"].percentage).toBe(40);
    expect(mocks.getInferenceSelfUsage).not.toHaveBeenCalled();
  });
});
