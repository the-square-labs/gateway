import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./dialog";

function Body() {
  const [loading, setLoading] = useState(true);
  useContentLoading(loading);
  return loading ? (
    <button type="button" onClick={() => setLoading(false)}>
      finish
    </button>
  ) : (
    <p>Loaded body</p>
  );
}

function Harness({ open }: { open: boolean }) {
  return (
    <Dialog open={open}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Title</DialogTitle>
        </DialogHeader>
        <Body />
      </DialogContent>
    </Dialog>
  );
}

const panel = () => document.querySelector<HTMLElement>("[data-reveal-phase]");

describe("dialog reveal", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for its data on every opening, even when mounted closed", async () => {
    vi.useFakeTimers();
    const { rerender } = render(<Harness open={false} />);
    await act(() => vi.advanceTimersByTimeAsync(100));

    rerender(<Harness open />);
    expect(panel()).toHaveAttribute("data-reveal-phase", "pending");
    expect(panel()?.style.animationPlayState).toBe("paused");

    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(panel()).toHaveAttribute("data-reveal-phase", "loading");
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();

    act(() => screen.getByText("finish", { selector: "button" }).click());
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(panel()).toHaveAttribute("data-reveal-phase", "revealed");
    expect(screen.getByText("Loaded body")).toBeInTheDocument();
  });

  it("opens at once when nothing loads", () => {
    render(
      <Dialog open>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Title</DialogTitle>
          </DialogHeader>
          <p>Static body</p>
        </DialogContent>
      </Dialog>
    );
    expect(panel()).toHaveAttribute("data-reveal-phase", "revealed");
  });
});
