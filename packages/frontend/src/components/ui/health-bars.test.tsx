import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HealthBars } from "./health-bars";

afterEach(() => vi.restoreAllMocks());

describe("intentionally stopped health history", () => {
  it("makes the current stopped bucket gray without erasing previous failures", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(42);
    const now = Date.now();
    const { container } = render(
      <HealthBars
        currentStatus="stopped"
        bucketMs={60_000}
        history={[
          { ts: new Date(now - 120_000).toISOString(), status: "offline" },
          { ts: new Date(now).toISOString(), status: "offline" },
        ]}
      />
    );
    const bars = container.querySelectorAll("div[title]");
    expect(bars.length).toBeGreaterThan(1);
    expect(bars[bars.length - 1]).toHaveClass("bg-muted");
    expect(container.querySelector(".bg-red-400")).not.toBeNull();
  });

  it("keeps historical stopped samples gray after the workload starts", () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(42);
    const now = Date.now();
    const { container } = render(
      <HealthBars
        currentStatus="online"
        bucketMs={60_000}
        history={[{ ts: new Date(now - 120_000).toISOString(), status: "stopped" }]}
      />
    );
    const bars = container.querySelectorAll("div[title]");
    expect(bars[bars.length - 3]).toHaveClass("bg-muted");
    expect(bars[bars.length - 1]).toHaveClass("bg-emerald-500");
    expect(container.querySelector(".bg-red-400, .bg-warning")).toBeNull();
  });
});
