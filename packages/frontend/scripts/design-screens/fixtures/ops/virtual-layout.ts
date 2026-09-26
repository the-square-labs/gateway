/**
 * jsdom has no layout: every `offsetHeight` is 0. TanStack Virtual sizes its
 * window from the scroll element's `offsetHeight` and measures rendered rows the
 * same way, so the shared `DataTable` (src/components/ui/data-table.tsx) renders
 * no rows at all in the exporter.
 *
 * This gives only the DataTable's own boxes a height: its scroll container
 * (`[data-route-scroll-container]`) reports the viewport height, and its virtual
 * rows (`[data-index]` inside it) report the table's fixed 49px row estimate, so
 * rows keep the offsets the component itself would compute. Everything else
 * keeps jsdom's value. Returns a function that restores the original getter.
 */
import { VIEWPORT } from "../../setup";

const DATA_TABLE_ROW_HEIGHT = 49;

export function installVirtualTableLayout(containerHeight = VIEWPORT.height) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const original = descriptor?.get;
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute("data-route-scroll-container")) return containerHeight;
      if (this.hasAttribute("data-index") && this.closest("[data-route-scroll-container]")) {
        return DATA_TABLE_ROW_HEIGHT;
      }
      return original ? original.call(this) : 0;
    },
  });
  return () => {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, "offsetHeight", descriptor);
  };
}
