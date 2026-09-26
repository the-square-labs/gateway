/**
 * CodeMirror paints nothing useful in jsdom, so editors become labelled
 * placeholders. The placeholder keeps the box it replaces; `.cm-editor` itself
 * has no size of its own outside a browser, while its wrapper is the flex box
 * that fills the panel. This marks each wrapper so the placeholder can take it.
 */
export const EDITOR_SELECTOR = "[data-design-editor]";

export function markEditors() {
  for (const editor of Array.from(document.querySelectorAll(".cm-editor"))) {
    editor.parentElement?.setAttribute("data-design-editor", "");
  }
}
