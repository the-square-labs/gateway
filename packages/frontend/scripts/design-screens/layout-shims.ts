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
 * - ResponsiveHeaderActions (src/components/common/ResponsiveHeaderActions.tsx)
 *   moves actions into its overflow menu from their measured widths; at 0 it shows
 *   them all and the page title is squeezed to one letter per line. Its header row
 *   gets the content width and each action an estimate from its label.
 *
 * Screens that know better (a narrow card) pass `healthBarsWidth`, or install
 * their own shim in `before`, which replaces this one.
 */
import { VIEWPORT } from "./setup";

const SIDEBAR_WIDTH = 260;
const PAGE_PADDING = 48;
const AI_PANEL_WIDTH = 410;
const DATA_TABLE_ROW_HEIGHT = 49;
/** An outline button: 16px padding each side, a 16px icon plus 8px gap, ~7.4px per text-sm character. */
const ICON_BUTTON_WIDTH = 36;
const BUTTON_PADDING = 32;
const BUTTON_ICON_WIDTH = 24;
const TEXT_SM_CHARACTER_WIDTH = 7.4;

function estimatedButtonWidth(item: Element) {
  const label = item.textContent?.trim() ?? "";
  if (!label) return ICON_BUTTON_WIDTH;
  const icon = item.querySelector("svg") ? BUTTON_ICON_WIDTH : 0;
  return Math.round(BUTTON_PADDING + icon + label.length * TEXT_SM_CHARACTER_WIDTH);
}

/** The header row of a ResponsiveHeaderActions: the parent of its root, which holds the overflow measure. */
function isHeaderActionsRow(element: Element) {
  return Array.from(element.children).some((child) =>
    child.lastElementChild?.hasAttribute("data-header-overflow-measure")
  );
}

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

  const getBoundingClientRect = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const rect = getBoundingClientRect.call(this);
    let width = 0;
    if (this.hasAttribute("data-header-action-item")) width = estimatedButtonWidth(this);
    else if (this.hasAttribute("data-header-overflow-measure")) width = ICON_BUTTON_WIDTH;
    else if (isHeaderActionsRow(this)) width = healthBarsWidth;
    return width > 0 ? new DOMRect(rect.x, rect.y, width, rect.height) : rect;
  };

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
