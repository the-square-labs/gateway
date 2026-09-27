// What every design system specimen (.design/system/specimens, written by
// export.mjs) imports through the `@ds/` alias: the product kit as `G`,
// React's createElement as `h`, the icons as `I` and the layout helpers the
// catalog previews are written with.

import * as React from "react";
import { createRoot } from "react-dom/client";
import * as G from "./entry";

export { G, React };
export const h = React.createElement;
export const I = G.Icons;

export function mount(node: React.ReactNode) {
  createRoot(document.getElementById("root") as HTMLElement).render(node);
}

// Previews pass rows as arrays (`Object.keys(V).map(...)`); spreading them keeps React from
// asking for keys the catalog never needed.
const spread = (children: React.ReactNode[]) => children.flat(Number.POSITIVE_INFINITY) as React.ReactNode[];

export function stage(...children: React.ReactNode[]) {
  return h("div", { className: "space-y-4 p-4" }, ...spread(children));
}

export function row(label: string | null, ...children: React.ReactNode[]) {
  return h(
    "div",
    { className: "flex flex-wrap items-center gap-3" },
    label ? h("span", { className: "w-24 shrink-0 text-xs font-medium text-foreground" }, label) : null,
    ...spread(children)
  );
}

// The product picks its theme from a `.light` or `.dark` class on <html> and falls back to the
// system preference; the viewer only sets `dark` and `data-theme`. Mirror its light theme as
// `.light` so a dark OS does not paint light specimens dark.
const root = document.documentElement;
const syncTheme = () =>
  root.classList.toggle("light", root.dataset.theme !== "dark" && !root.classList.contains("dark"));
new MutationObserver(syncTheme).observe(root, { attributes: true, attributeFilter: ["class", "data-theme"] });
syncTheme();
