/**
 * jsdom has no layout, so every `clientWidth` is 0. HealthBars sizes its bar
 * count from its container width and would render a single bar; this gives
 * that one container (a `shrink-0` box whose first child is the `gap-[1px]`
 * bar row) the width it has on a 1440px desktop, and leaves every other
 * element untouched.
 */
export function giveHealthBarsDesktopWidth(width = 1130) {
  const original =
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth") ??
    Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      const first = this.firstElementChild;
      if (this.classList.contains("shrink-0") && first?.classList.contains("gap-[1px]")) {
        return width;
      }
      return original?.get?.call(this) ?? 0;
    },
  });
}
