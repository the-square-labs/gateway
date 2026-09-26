import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useContentLoading } from "@/components/common/reveal-gate";
import { Button } from "./button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "./dialog";

function Body({ stuck = false }: { stuck?: boolean }) {
  const [loading, setLoading] = useState(true);
  useContentLoading(loading);
  return loading ? (
    <button type="button" onClick={() => !stuck && setLoading(false)}>
      finish
    </button>
  ) : (
    <input aria-label="Name" />
  );
}

function Harness({ stuck = false, withButton = true }: { stuck?: boolean; withButton?: boolean }) {
  const [open, setOpen] = useState(!withButton);
  return (
    <>
      {withButton ? <Button onClick={() => setOpen(true)}>Create route</Button> : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Route</DialogTitle>
          </DialogHeader>
          <Body stuck={stuck} />
        </DialogContent>
      </Dialog>
    </>
  );
}

const panel = () => document.querySelector<HTMLElement>("[data-reveal-phase]");
const finish = () => act(() => screen.getByText("finish", { selector: "button" }).click());

describe("dialog opening", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spins the button that opened it and opens complete once its data is in", async () => {
    vi.useFakeTimers();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Create route" });
    fireEvent.pointerDown(opener);
    fireEvent.click(opener);

    expect(opener).toHaveAttribute("data-dialog-opening");
    expect(panel()?.style.animationPlayState).toBe("paused");
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(screen.queryByRole("status", { name: "Loading" })).not.toBeInTheDocument();

    await finish();
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(panel()).toHaveAttribute("data-reveal-phase", "revealed");
    expect(panel()?.style.animationPlayState).toBe("");
    expect(opener).not.toHaveAttribute("data-dialog-opening");
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
  });

  it("dims the screen with a spinner when no button opened it", async () => {
    vi.useFakeTimers();
    render(<Harness withButton={false} />);
    expect(screen.queryByRole("status", { name: "Loading" })).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();

    await finish();
    await act(() => vi.advanceTimersByTimeAsync(400));
    expect(screen.queryByRole("status", { name: "Loading" })).not.toBeInTheDocument();
    expect(panel()).toHaveAttribute("data-reveal-phase", "revealed");
  });

  it("opens anyway when its data never arrives", async () => {
    vi.useFakeTimers();
    render(<Harness stuck />);
    const opener = screen.getByRole("button", { name: "Create route" });
    fireEvent.pointerDown(opener);
    fireEvent.click(opener);
    await act(() => vi.advanceTimersByTimeAsync(10_001));
    expect(panel()).toHaveAttribute("data-reveal-phase", "revealed");
    expect(opener).not.toHaveAttribute("data-dialog-opening");
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
