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
