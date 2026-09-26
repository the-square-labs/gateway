/**
 * jsdom has no layout engine: every width and height reads 0. A few components
 * size their content from a measurement, so without help they render a
 * degenerate version of themselves. These shims give only those components'
 * own boxes a plausible desktop size; every other element keeps jsdom's value.
 *
 * - HealthBars (src/components/ui/health-bars.tsx) derives its bar count from
 *   its `clientWidth`; at 0 it draws one bar. Recognised by its `flex gap-[1px]` row.
 * - DataTable (src/components/ui/data-table.tsx) virtualizes rows from its scroll
 *   container's `offsetHeight`; at 0 it renders no rows. Recognised by
 *   `[data-route-scroll-container]`; rows get the table's own 49px estimate.
 *
 * Screens that know better (a narrow card) pass `healthBarsWidth`, or install
 * their own shim in `before`, which replaces this one.
 */
import { VIEWPORT } from "./setup";

const SIDEBAR_WIDTH = 260;
const PAGE_PADDING = 48;
const AI_PANEL_WIDTH = 410;
const DATA_TABLE_ROW_HEIGHT = 49;

export function defaultHealthBarsWidth(aiPanelOpen: boolean) {
  return VIEWPORT.width - SIDEBAR_WIDTH - PAGE_PADDING - (aiPanelOpen ? AI_PANEL_WIDTH : 0);
}

export function installLayoutShims({ healthBarsWidth }: { healthBarsWidth: number }) {
  const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      const row = this.firstElementChild;
      if (row?.classList.contains("flex") && row.classList.contains("gap-[1px]")) {
        return healthBarsWidth;
      }
      return clientWidth?.get ? clientWidth.get.call(this) : 0;
    },
  });

  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.hasAttribute("data-route-scroll-container")) return VIEWPORT.height;
      if (this.hasAttribute("data-index") && this.closest("[data-route-scroll-container]")) {
        return DATA_TABLE_ROW_HEIGHT;
      }
      return offsetHeight?.get ? offsetHeight.get.call(this) : 0;
    },
  });
}
