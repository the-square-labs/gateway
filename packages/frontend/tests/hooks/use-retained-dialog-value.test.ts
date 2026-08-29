import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useRetainedDialogValue } from "../../src/hooks/use-retained-dialog-value";

describe("useRetainedDialogValue", () => {
  it("keeps the last open value while a dialog closes", () => {
    const { result, rerender } = renderHook(
      ({ value, open }: { value: string | null; open: boolean }) =>
        useRetainedDialogValue(value, open),
      {
        initialProps: { value: "first" as string | null, open: true },
      }
    );

    expect(result.current).toBe("first");

    rerender({ value: null, open: false });

    expect(result.current).toBe("first");

    rerender({ value: "second", open: true });

    expect(result.current).toBe("second");
  });
});
