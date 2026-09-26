import { act, render, screen, waitFor } from "@testing-library/react";
import { StrictMode, useContext } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Skeleton } from "@/components/ui/skeleton";
import { InitialPageReadyContext, PageTransition } from "./PageTransition";

function ReadyProbe() {
  const ready = useContext(InitialPageReadyContext);
  return <span>{ready ? "Page ready" : "Page waiting"}</span>;
}

describe("PageTransition", () => {
  it("holds the initial parent reveal for a loading nested tab without hiding it on subsequent tabs", async () => {
    const content = (tab: string, loading: boolean) => (
      <PageTransition>
        <h1>Persistent header</h1>
        <PageTransition key={tab}>{loading ? <Skeleton /> : <div>Loaded tab</div>}</PageTransition>
      </PageTransition>
    );
    const { rerender } = render(content("first", true));
    const parent = document.querySelector("[data-page-transition]");
    expect(parent).toHaveStyle({ visibility: "hidden" });
    rerender(content("first", false));
    await waitFor(() => expect(parent).toHaveStyle({ visibility: "visible" }));
    rerender(content("second", true));
    expect(parent).toHaveStyle({ visibility: "visible" });
    expect(parent?.querySelector("[data-page-transition]")).toHaveStyle({ visibility: "hidden" });
  });
  it("reveals navigated page content only after its initial data is ready", async () => {
    const { rerender } = render(
      <PageTransition>
        <Skeleton />
        <ReadyProbe />
      </PageTransition>
    );

    const transition = document.querySelector<HTMLElement>("[data-page-transition]");
    expect(transition).toHaveStyle({ visibility: "hidden" });
    expect(transition).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Page waiting")).toBeInTheDocument();

    rerender(
      <PageTransition>
        <div>Ready content</div>
        <ReadyProbe />
      </PageTransition>
    );

    await waitFor(() => {
      expect(screen.getByText("Ready content")).toBeVisible();
      expect(screen.getByText("Page ready")).toBeVisible();
      expect(transition).toHaveStyle({ visibility: "visible" });
      expect(transition).not.toHaveAttribute("aria-busy");
    });
  });

  it("does not hide a page for later local loading states", async () => {
    const { rerender } = render(
      <PageTransition>
        <div>Ready content</div>
      </PageTransition>
    );
    await waitFor(() =>
      expect(document.querySelector("[data-page-transition]")).toHaveStyle({
        visibility: "visible",
      })
    );

    rerender(
      <PageTransition>
        <Skeleton />
      </PageTransition>
    );

    expect(document.querySelector("[data-page-transition]")).toHaveStyle({ visibility: "visible" });
  });

  it("keeps initial content hidden while StrictMode replays layout effects", async () => {
    const { rerender } = render(
      <StrictMode>
        <PageTransition>
          <Skeleton />
        </PageTransition>
      </StrictMode>
    );

    const transition = document.querySelector<HTMLElement>("[data-page-transition]");
    expect(transition).toHaveStyle({ visibility: "hidden" });
    expect(transition).toHaveAttribute("aria-busy", "true");

    rerender(
      <StrictMode>
        <PageTransition>
          <div>StrictMode content ready</div>
        </PageTransition>
      </StrictMode>
    );

    await waitFor(() => {
      expect(screen.getByText("StrictMode content ready")).toBeVisible();
      expect(transition).toHaveStyle({ visibility: "visible" });
    });
  });

  it("waits for initial data again when keyed tab content changes", async () => {
    const { rerender } = render(
      <PageTransition key="general">
        <div>General settings</div>
      </PageTransition>
    );

    const generalTransition = document.querySelector<HTMLElement>("[data-page-transition]");
    await waitFor(() => expect(generalTransition).toHaveStyle({ visibility: "visible" }));

    rerender(
      <PageTransition key="features">
        <Skeleton />
      </PageTransition>
    );

    const featuresTransition = document.querySelector<HTMLElement>("[data-page-transition]");
    expect(featuresTransition).not.toBe(generalTransition);
    expect(featuresTransition).toHaveStyle({ visibility: "hidden" });
    expect(featuresTransition).toHaveAttribute("aria-busy", "true");

    rerender(
      <PageTransition key="features">
        <div>Features settings</div>
      </PageTransition>
    );

    await waitFor(() => {
      expect(screen.getByText("Features settings")).toBeVisible();
      expect(featuresTransition).toHaveStyle({ visibility: "visible" });
    });
  });

  describe("loader timing", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const page = (loading: boolean) => (
      <PageTransition>{loading ? <Skeleton /> : <div>Loaded content</div>}</PageTransition>
    );

    it("reveals fast content without a loader", async () => {
      vi.useFakeTimers();
      const { rerender } = render(page(true));
      await act(() => vi.advanceTimersByTimeAsync(300));
      rerender(page(false));
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(screen.queryByRole("status", { name: "Loading" })).not.toBeInTheDocument();
      expect(document.querySelector("[data-page-transition]")).toHaveStyle({
        visibility: "visible",
      });
    });

    it("shows a loader after half a second and keeps it for at least half a second", async () => {
      vi.useFakeTimers();
      const { rerender } = render(page(true));
      await act(() => vi.advanceTimersByTimeAsync(499));
      expect(screen.queryByRole("status", { name: "Loading" })).not.toBeInTheDocument();
      await act(() => vi.advanceTimersByTimeAsync(2));
      expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();

      await act(() => vi.advanceTimersByTimeAsync(100));
      rerender(page(false));
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
      expect(document.querySelector("[data-page-transition]")).toHaveStyle({
        visibility: "hidden",
      });

      await act(() => vi.advanceTimersByTimeAsync(250));
      expect(screen.queryByRole("status", { name: "Loading" })).not.toBeInTheDocument();
      expect(document.querySelector("[data-page-transition]")).toHaveStyle({
        visibility: "visible",
      });
    });

    it("waits for a follow-up load that starts right after the first one", async () => {
      vi.useFakeTimers();
      const { rerender } = render(
        <PageTransition>
          <Skeleton key="list" />
        </PageTransition>
      );
      rerender(<PageTransition>{null}</PageTransition>);
      await act(() => vi.advanceTimersByTimeAsync(20));
      rerender(
        <PageTransition>
          <Skeleton key="details" />
        </PageTransition>
      );
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(document.querySelector("[data-page-transition]")).toHaveStyle({
        visibility: "hidden",
      });
      rerender(
        <PageTransition>
          <div>Loaded content</div>
        </PageTransition>
      );
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(document.querySelector("[data-page-transition]")).toHaveStyle({
        visibility: "visible",
      });
    });

    it("lets the resolved page continue the loader of the route guard before it", async () => {
      vi.useFakeTimers();
      const { rerender } = render(
        <PageTransition key="guard">
          <Skeleton />
        </PageTransition>
      );
      await act(() => vi.advanceTimersByTimeAsync(600));
      expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();

      rerender(
        <PageTransition key="page">
          <Skeleton />
        </PageTransition>
      );
      expect(screen.getByRole("status", { name: "Loading" })).toBeInTheDocument();
    });
  });

  describe("entrance animation", () => {
    afterEach(() => {
      vi.useRealTimers();
      delete (HTMLElement.prototype as { animate?: unknown }).animate;
    });

    function recordAnimations() {
      const animated: string[] = [];
      (HTMLElement.prototype as { animate?: unknown }).animate = function (this: HTMLElement) {
        animated.push(this.textContent ?? "");
        return {} as Animation;
      };
      return animated;
    }

    it("does not replay a tab panel's entrance right after the page appeared", async () => {
      vi.useFakeTimers();
      const animated = recordAnimations();
      const page = (tabLoading: boolean) => (
        <PageTransition>
          <h1>Header</h1>
          <PageTransition>{tabLoading ? <Skeleton /> : <p>Tab body</p>}</PageTransition>
        </PageTransition>
      );
      const { rerender } = render(
        <PageTransition>
          <h1>Header</h1>
        </PageTransition>
      );
      await act(() => vi.advanceTimersByTimeAsync(10));
      rerender(page(true));
      await act(() => vi.advanceTimersByTimeAsync(200));
      rerender(page(false));
      await act(() => vi.advanceTimersByTimeAsync(200));
      expect(animated.filter((text) => text.includes("Tab body"))).toHaveLength(0);
    });

    it("does not animate a page again when it remounts at the same address", async () => {
      vi.useFakeTimers();
      const animated = recordAnimations();
      const { rerender } = render(
        <PageTransition key="a">
          <h1>Routes</h1>
          <p>List</p>
        </PageTransition>
      );
      await act(() => vi.advanceTimersByTimeAsync(10));
      const first = animated.length;
      expect(first).toBeGreaterThan(0);
      rerender(
        <PageTransition key="b">
          <h1>Routes</h1>
          <p>List</p>
        </PageTransition>
      );
      await act(() => vi.advanceTimersByTimeAsync(10));
      expect(animated.length).toBe(first);
    });
  });
});
