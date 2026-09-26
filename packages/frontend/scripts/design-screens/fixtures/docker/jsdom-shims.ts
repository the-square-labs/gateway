import { act } from "@testing-library/react";

/**
 * jsdom has no layout, so `clientWidth` is 0 and HealthBars (which sizes its bar
 * count from its own width) draws a single bar. This gives only HealthBars'
 * outer box a width — recognised by its `flex gap-[1px]` bar row — so the strip
 * shows the full history like in a browser. Every other element keeps jsdom's 0.
 */
export function giveHealthBarsWidth(width: number) {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      const row = this.firstElementChild;
      if (row?.classList.contains("gap-[1px]") && row.classList.contains("flex")) return width;
      return original?.get ? original.get.call(this) : 0;
    },
  });
}

/**
 * AnimatedHeight measures its content with getBoundingClientRect (0 in jsdom) and
 * pins `height: 16px` on an `overflow-hidden` wrapper, which would clip the form on
 * the board. A browser settles that wrapper at its content height, i.e. `auto`.
 */
export async function releaseAnimatedHeights(root: ParentNode = document) {
  // Let the height animation (0.25s) finish first, or it writes the height back.
  await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
  for (const element of Array.from(
    root.querySelectorAll<HTMLElement>("div.overflow-hidden.-mx-2.-my-2")
  )) {
    if (element.style.height) element.style.height = "";
  }
}

const LOG_VIEWPORT_HEIGHT = 640;
const LOG_LINE_HEIGHT = 20;

/**
 * VirtualLogList (src/components/ui/virtual-log-list.tsx) windows its rows from
 * the scroll box's `offsetHeight`, read once when the box mounts, and measures
 * each row the same way; at 0 it renders no row. This gives the scroll boxes
 * `isViewport` recognises a viewport height and their rows a fixed row height.
 */
export function giveVirtualListHeight(
  isViewport: (element: HTMLElement) => boolean,
  viewportHeight: number,
  rowHeight: number
) {
  const matches = (element: Element | null | undefined) =>
    element instanceof HTMLElement && isViewport(element);
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (matches(this)) return viewportHeight;
      if (this.hasAttribute("data-index") && matches(this.parentElement?.parentElement)) {
        return rowHeight;
      }
      return original?.get ? original.get.call(this) : 0;
    },
  });
}

const hasClasses = (element: HTMLElement, names: string[]) =>
  names.every((name) => element.classList.contains(name));

/** Log lines of DockerLogViewport and of the logs popout window (`text-xs leading-5`). */
export function giveLogViewportHeight() {
  giveVirtualListHeight(
    (element) => hasClasses(element, ["overflow-auto", "bg-card", "py-4"]),
    LOG_VIEWPORT_HEIGHT,
    LOG_LINE_HEIGHT
  );
}

/** Rows of the node daemon log table (src/pages/node-detail/NodeLogsTab.tsx). */
export function giveDaemonLogListHeight() {
  giveVirtualListHeight(
    (element) => hasClasses(element, ["min-h-0", "flex-1", "overflow-y-auto"]),
    LOG_VIEWPORT_HEIGHT,
    45
  );
}
