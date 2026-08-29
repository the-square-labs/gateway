import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useScrollToNavigationTarget } from "../../src/hooks/use-scroll-to-navigation-target";

describe("useScrollToNavigationTarget", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.documentElement.style.removeProperty("--color-border");
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
  });

  it("waits for rendered content, then starts scrolling after the short post-render delay", () => {
    vi.useFakeTimers();
    const scrollIntoView = vi.fn();
    const target = document.createElement("div");
    target.id = "housekeeping";
    target.scrollIntoView = scrollIntoView;
    document.body.append(target);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            {
              pathname: "/settings/features",
              state: { scrollTarget: "housekeeping" },
            },
          ],
        },
        children
      );

    const { rerender } = renderHook(
      ({ ready }) => useScrollToNavigationTarget("housekeeping", ready),
      {
        initialProps: { ready: false },
        wrapper,
      }
    );

    expect(scrollIntoView).not.toHaveBeenCalled();
    rerender({ ready: true });
    act(() => vi.advanceTimersByTime(119));
    expect(scrollIntoView).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "start" });
  });

  it("scrolls as soon as a late-mounted target appears", async () => {
    const scrollIntoView = vi.fn();
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            {
              pathname: "/settings/features",
              state: { scrollTarget: "housekeeping" },
            },
          ],
        },
        children
      );

    renderHook(() => useScrollToNavigationTarget("housekeeping", true, { delayMs: 0 }), {
      wrapper,
    });
    expect(scrollIntoView).not.toHaveBeenCalled();

    const target = document.createElement("div");
    target.id = "housekeeping";
    target.scrollIntoView = scrollIntoView;
    act(() => document.body.append(target));

    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledTimes(1));
  });

  it("scrolls the route container directly even while the page is not visible", () => {
    const scrollTo = vi.fn();
    const scroller = document.createElement("div");
    scroller.className = "overflow-y-auto";
    Object.defineProperties(scroller, {
      clientHeight: { value: 600 },
      scrollHeight: { value: 2400 },
      scrollTop: { value: 100, writable: true },
    });
    scroller.scrollTo = scrollTo;
    scroller.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 }) as DOMRect;
    const target = document.createElement("div");
    target.id = "pages";
    target.getBoundingClientRect = () => ({ top: 900, bottom: 1100, height: 200 }) as DOMRect;
    target.scrollIntoView = vi.fn();
    scroller.append(target);
    document.body.append(scroller);
    vi.spyOn(window, "getComputedStyle").mockImplementation(
      (element) =>
        ({
          overflowY: element === scroller ? "auto" : "visible",
          borderTopColor: "",
          borderTopStyle: "none",
          borderTopWidth: "0px",
        }) as CSSStyleDeclaration
    );
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            {
              pathname: "/settings/features",
              state: { scrollTarget: "pages" },
            },
          ],
        },
        children
      );

    renderHook(() => useScrollToNavigationTarget("pages", true, { block: "center", delayMs: 0 }), {
      wrapper,
    });

    expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: "smooth" });
    expect(target.scrollIntoView).not.toHaveBeenCalled();
  });

  it("reacts on an already mounted settings tab without changing the URL", () => {
    const scrollIntoView = vi.fn();
    const target = document.createElement("div");
    target.id = "system-updates";
    target.scrollIntoView = scrollIntoView;
    document.body.append(target);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(MemoryRouter, { initialEntries: ["/settings/general"] }, children);

    const { result } = renderHook(
      () => {
        useScrollToNavigationTarget("system-updates", true, { delayMs: 0 });
        return { location: useLocation(), navigate: useNavigate() };
      },
      { wrapper }
    );

    act(() =>
      result.current.navigate("/settings/general", {
        state: { scrollTarget: "system-updates" },
      })
    );

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(result.current.location.pathname).toBe("/settings/general");
    expect(result.current.location.hash).toBe("");
    expect(result.current.location.state).toEqual({});
  });

  it("removes the consumed target from browser history so reload cannot replay it", () => {
    const target = document.createElement("div");
    target.id = "pages";
    target.scrollIntoView = vi.fn();
    document.body.append(target);
    window.history.replaceState(
      { idx: 1, usr: { scrollTarget: "pages", returnTo: "/pages" } },
      "",
      "/settings/features"
    );
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            {
              pathname: "/settings/features",
              state: { scrollTarget: "pages", returnTo: "/pages" },
            },
          ],
        },
        children
      );

    renderHook(() => useScrollToNavigationTarget("pages", true, { delayMs: 0 }), { wrapper });

    expect(window.history.state).toEqual({ idx: 1, usr: { returnTo: "/pages" } });
  });

  it("scrolls on every repeated transition from another page", () => {
    const scrollIntoView = vi.fn();
    const target = document.createElement("div");
    target.id = "system-updates";
    target.scrollIntoView = scrollIntoView;
    document.body.append(target);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(MemoryRouter, { initialEntries: ["/docker"] }, children);

    const { result } = renderHook(
      () => {
        useScrollToNavigationTarget("system-updates", true, { delayMs: 0 });
        return { location: useLocation(), navigate: useNavigate() };
      },
      { wrapper }
    );

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      act(() =>
        result.current.navigate("/settings/general", {
          state: { scrollTarget: "system-updates" },
        })
      );
      expect(scrollIntoView).toHaveBeenCalledTimes(attempt);
      expect(result.current.location.hash).toBe("");
      act(() => result.current.navigate("/docker"));
    }
  });

  it("ignores a different navigation target", () => {
    const scrollIntoView = vi.fn();
    const target = document.createElement("div");
    target.id = "housekeeping";
    target.scrollIntoView = scrollIntoView;
    document.body.append(target);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            {
              pathname: "/settings/features",
              state: { scrollTarget: "other" },
            },
          ],
        },
        children
      );

    renderHook(() => useScrollToNavigationTarget("housekeeping", true, { delayMs: 0 }), {
      wrapper,
    });

    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("can center and temporarily highlight a navigation target", () => {
    vi.useFakeTimers();
    const scrollIntoView = vi.fn();
    const target = document.createElement("div");
    target.id = "pages";
    target.scrollIntoView = scrollIntoView;
    target.style.border = "1px solid rgb(234, 179, 8)";
    document.body.append(target);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            {
              pathname: "/settings/features",
              state: { scrollTarget: "pages" },
            },
          ],
        },
        children
      );

    const { result } = renderHook(
      () =>
        useScrollToNavigationTarget("pages", true, {
          block: "center",
          delayMs: 0,
          highlightDurationMs: 1500,
        }),
      { wrapper }
    );

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: "smooth", block: "center" });
    expect(result.current).toBe(true);
    expect(target.style.getPropertyValue("--navigation-target-ripple-color")).toBe(
      "rgb(234, 179, 8)"
    );
    act(() => vi.advanceTimersByTime(1500));
    expect(result.current).toBe(false);
    expect(target.style.getPropertyValue("--navigation-target-ripple-color")).toBe("");
  });

  it("uses white ripple color for the standard gray border", () => {
    document.documentElement.style.setProperty("--color-border", "#2a2a2a");
    const target = document.createElement("div");
    target.id = "pages";
    target.scrollIntoView = vi.fn();
    target.style.border = "1px solid rgb(42, 42, 42)";
    document.body.append(target);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        MemoryRouter,
        {
          initialEntries: [
            {
              pathname: "/settings/features",
              state: { scrollTarget: "pages" },
            },
          ],
        },
        children
      );

    const { result } = renderHook(
      () =>
        useScrollToNavigationTarget("pages", true, {
          delayMs: 0,
          highlightDurationMs: 2000,
        }),
      { wrapper }
    );

    expect(result.current).toBe(true);
    expect(target.style.getPropertyValue("--navigation-target-ripple-color")).toBe("#fff");
  });
});
