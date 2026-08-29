import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDeferredDialogState } from "../../src/hooks/use-deferred-dialog-state";

describe("useDeferredDialogState", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("closes immediately but retains the payload through the exit animation", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useDeferredDialogState<string>());

    act(() => result.current.setValue("details"));

    expect(result.current.open).toBe(true);
    expect(result.current.value).toBe("details");

    act(() => result.current.setValue(null));

    expect(result.current.open).toBe(false);
    expect(result.current.value).toBe("details");

    act(() => vi.advanceTimersByTime(250));

    expect(result.current.value).toBeNull();
  });
});
