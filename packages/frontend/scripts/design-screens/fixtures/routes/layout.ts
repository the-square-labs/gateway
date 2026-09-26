/**
 * jsdom has no layout, so `HealthBars` measures a 0px container and draws a
 * single bar. Report a desktop width for that one container (recognised by
 * its bar row) so the export shows the real bar count; every other element
 * keeps jsdom's value.
 */
export function measureHealthBars(width = 1136) {
  const original = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      if (this.firstElementChild?.classList.contains("gap-[1px]")) return width;
      return original?.get ? original.get.call(this) : 0;
    },
  });
}
