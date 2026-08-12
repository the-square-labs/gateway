import { vi } from "vitest";
import { runBackgroundPrewarm } from "./background-prewarm";

describe("runBackgroundPrewarm", () => {
  it("starts tasks sequentially with a delay instead of creating a request burst", async () => {
    vi.useFakeTimers();
    const starts: string[] = [];
    const controller = new AbortController();
    const run = runBackgroundPrewarm(
      [
        { key: "one", run: async () => starts.push("one") },
        { key: "two", run: async () => starts.push("two") },
        { key: "three", run: async () => starts.push("three") },
      ],
      controller.signal,
      350
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual(["one"]);
    await vi.advanceTimersByTimeAsync(349);
    expect(starts).toEqual(["one"]);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual(["one", "two"]);
    await vi.advanceTimersByTimeAsync(350);
    expect(starts).toEqual(["one", "two", "three"]);
    await run;
    vi.useRealTimers();
  });

  it("stops before starting another request when the session is aborted", async () => {
    vi.useFakeTimers();
    const starts: string[] = [];
    const controller = new AbortController();
    const run = runBackgroundPrewarm(
      [
        { key: "one", run: async () => starts.push("one") },
        { key: "two", run: async () => starts.push("two") },
      ],
      controller.signal,
      350
    );

    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await run;
    expect(starts).toEqual(["one"]);
    vi.useRealTimers();
  });
});
