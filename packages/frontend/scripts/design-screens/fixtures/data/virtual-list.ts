/**
 * jsdom has no layout, so TanStack Virtual lists outside the shared DataTable
 * (the SQL explorer grid, the log viewport) measure a 0px window and render no
 * rows. This gives only the matching scroll box a height and its virtual rows
 * (`[data-index]` inside it) the row height the component itself estimates;
 * every other element keeps the value the harness shims report.
 */
export function installVirtualListLayout({
  container,
  rowHeight,
  height = 640,
}: {
  /** Selector of the list's scroll element. */
  container: string;
  rowHeight: number;
  height?: number;
}) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const original = descriptor?.get;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.matches(container)) return height;
      if (this.hasAttribute("data-index") && this.closest(container)) return rowHeight;
      return original ? original.call(this) : 0;
    },
  });
}
