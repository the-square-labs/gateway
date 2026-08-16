import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InitialPageReadyContext } from "@/components/common/PageTransition";
import { useScrollToNavigationTarget } from "./use-scroll-to-navigation-target";

describe("useScrollToNavigationTarget", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("waits for both the target and the surrounding page content before scrolling", () => {
    const scrollIntoView = vi.fn();
    const target = document.createElement("div");
    target.id = "housekeeping";
    target.scrollIntoView = scrollIntoView;
    document.body.append(target);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    let pageReady = false;
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
        createElement(InitialPageReadyContext.Provider, { value: pageReady }, children)
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
    expect(scrollIntoView).not.toHaveBeenCalled();

    pageReady = true;
    rerender({ ready: true });

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "start",
    });
  });

  it("reacts on an already mounted settings tab without changing the URL", () => {
    const scrollIntoView = vi.fn();
    const target = document.createElement("div");
    target.id = "system-updates";
    target.scrollIntoView = scrollIntoView;
    document.body.append(target);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(MemoryRouter, { initialEntries: ["/settings/general"] }, children);

    const { result } = renderHook(
      () => {
        useScrollToNavigationTarget("system-updates");
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
  });

  it("scrolls on every repeated transition from another page", () => {
    const scrollIntoView = vi.fn();
    const target = document.createElement("div");
    target.id = "system-updates";
    target.scrollIntoView = scrollIntoView;
    document.body.append(target);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(MemoryRouter, { initialEntries: ["/docker"] }, children);

    const { result } = renderHook(
      () => {
        useScrollToNavigationTarget("system-updates");
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
    vi.spyOn(window, "requestAnimationFrame");
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

    renderHook(() => useScrollToNavigationTarget("housekeeping"), { wrapper });

    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });
});
