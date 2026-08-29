import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useInitialLoading } from "../../src/hooks/use-initial-loading";

describe("useInitialLoading", () => {
  it("only reports loading until the first settled state", () => {
    const { result, rerender } = renderHook(
      ({ loading }: { loading: boolean }) => useInitialLoading(loading),
      { initialProps: { loading: true } }
    );

    expect(result.current).toBe(true);

    rerender({ loading: false });
    expect(result.current).toBe(false);

    rerender({ loading: true });
    expect(result.current).toBe(false);
  });

  it("treats an initially settled view as already loaded", () => {
    const { result, rerender } = renderHook(
      ({ loading }: { loading: boolean }) => useInitialLoading(loading),
      { initialProps: { loading: false } }
    );

    expect(result.current).toBe(false);

    rerender({ loading: true });
    expect(result.current).toBe(false);
  });
});
