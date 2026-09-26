/**
 * Serializes the rendered jsdom document to static markup that the canvas
 * runtime can mount as-is:
 * - every element is closed explicitly and every attribute is quoted;
 * - boolean attributes carry their name as value (an empty value reads as false);
 * - live form state (input values, checked boxes, textarea text) becomes markup;
 * - reveal gates show their settled content (their `visibility:hidden` is dropped);
 * - `{{` never survives, since the canvas treats it as a template hole.
 */

const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const BOOLEAN_ATTRIBUTES = new Set([
  "allowfullscreen",
  "async",
  "autofocus",
  "autoplay",
  "checked",
  "controls",
  "default",
  "defer",
  "disabled",
  "formnovalidate",
  "hidden",
  "inert",
  "ismap",
  "loop",
  "multiple",
  "muted",
  "nomodule",
  "novalidate",
  "open",
  "playsinline",
  "readonly",
  "required",
  "reversed",
  "selected",
]);

// Elements that close an open <p> when an HTML parser meets them. React can nest
// them in a <p> through the DOM API, but markup would not survive a re-parse.
const CLOSES_PARAGRAPH = new Set([
  "address", "article", "aside", "blockquote", "details", "dialog", "div", "dl", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul",
]);

const DROPPED_ELEMENTS = new Set(["script", "noscript", "template", "iframe", "object", "embed"]);

export interface SerializeOptions {
  /** Keep reveal gates hidden (the page loader state). */
  keepGateHidden: boolean;
  /** Boxes jsdom cannot paint: their content is replaced by a labelled placeholder. */
  placeholders: Array<{ selector: string; label: string }>;
}

export interface SerializedDocument {
  body: string;
  styles: string[];
  /** Element counts before and after an HTML re-parse; a mismatch means broken nesting. */
  reparse: { original: number; reparsed: number };
}

function breakHoles(value: string) {
  // A zero-width space between braces keeps `{{` visible but inert.
  return value.replace(/\{\{/g, "{​{").replace(/\}\}/g, "}​}");
}

function escapeText(value: string) {
  return breakHoles(value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"));
}

function escapeAttribute(value: string) {
  return breakHoles(
    value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  );
}

function cleanStyle(element: Element, style: string, options: SerializeOptions) {
  let next = style;
  const isGate = element.hasAttribute("data-reveal-phase");
  if (isGate && !options.keepGateHidden) {
    next = next.replace(/visibility:\s*hidden;?/g, "");
  }
  // AnimatedHeight (src/components/common/AnimatedHeight.tsx) measures 0 in jsdom and
  // pins its overflow-hidden wrapper at 16px; a browser settles it at content height.
  if (element.matches("div.overflow-hidden.-mx-2.-my-2")) {
    next = next.replace(/(^|;)\s*height:\s*[^;]+;?/g, "$1");
  }
  // Pointer-events locks from open modal layers do not matter on a static board.
  if (element.tagName === "BODY") next = next.replace(/pointer-events:\s*none;?/g, "");
  return next.trim();
}

function placeholderMarkup(label: string, element: Element) {
  const className = element.getAttribute("class") ?? "";
  const style = element.getAttribute("style") ?? "";
  return (
    `<div class="${escapeAttribute(className)}" style="${escapeAttribute(style)}"` +
    ` data-design-placeholder="${escapeAttribute(label)}">` +
    `<div style="box-sizing: border-box; width: 100%; height: 100%; min-height: 96px; display: flex; align-items: center; justify-content: center; padding: 12px; border: 1px dashed var(--color-border); background: repeating-linear-gradient(135deg, transparent 0 10px, color-mix(in srgb, var(--color-muted) 60%, transparent) 10px 20px); color: var(--color-muted-foreground); font-size: 12px; font-weight: 500; text-align: center">` +
    `${escapeText(label)}</div></div>`
  );
}

const counter = { elements: 0 };

function serializeNode(
  node: Node,
  options: SerializeOptions,
  replaced: Map<Element, string>,
  styles: string[]
): string {
  if (node.nodeType === node.TEXT_NODE) {
    const parent = node.parentElement;
    if (parent && parent.tagName === "TEXTAREA") return "";
    return escapeText(node.textContent ?? "");
  }
  if (node.nodeType !== node.ELEMENT_NODE) return "";
  const element = node as Element;
  const label = replaced.get(element);
  if (label !== undefined) {
    counter.elements += 2;
    return placeholderMarkup(label, element);
  }

  const isSvg = element.namespaceURI === "http://www.w3.org/2000/svg";
  let tag = isSvg ? element.localName : element.localName.toLowerCase();
  // Preflight zeroes paragraph margins, so a <div> looks the same and parses back intact.
  if (
    tag === "p" &&
    Array.from(element.querySelectorAll("*")).some((child) =>
      CLOSES_PARAGRAPH.has(child.localName.toLowerCase())
    )
  ) {
    tag = "div";
  }
  counter.elements += 1;
  if (DROPPED_ELEMENTS.has(tag) || tag === "link" || tag === "meta" || tag === "base") {
    counter.elements -= 1;
    return "";
  }
  if (tag === "style") {
    counter.elements -= 1;
    styles.push(element.textContent ?? "");
    return "";
  }

  const attributes: string[] = [];
  const seen = new Set<string>();
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name;
    const lower = name.toLowerCase();
    if (lower.startsWith("on")) continue;
    if (lower === "value" && (tag === "input" || tag === "textarea" || tag === "select")) continue;
    if (lower === "checked" && tag === "input") continue;
    if (lower === "selected" && tag === "option") continue;
    let value = attribute.value;
    if (lower === "style") {
      value = cleanStyle(element, value, options);
      if (!value) continue;
    }
    if (BOOLEAN_ATTRIBUTES.has(lower) && !isSvg) value = lower;
    seen.add(lower);
    attributes.push(`${name}="${escapeAttribute(value)}"`);
  }

  if (tag === "input") {
    const input = element as HTMLInputElement;
    const type = (input.getAttribute("type") ?? "text").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      if (input.checked) attributes.push('checked="checked"');
    } else if (type !== "file" && input.value) {
      attributes.push(`value="${escapeAttribute(input.value)}"`);
    }
  }
  if (tag === "option" && (element as HTMLOptionElement).selected) {
    attributes.push('selected="selected"');
  }

  const open = `<${tag}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
  if (!isSvg && VOID_ELEMENTS.has(tag)) return open;

  let inner = "";
  if (tag === "textarea") {
    inner = escapeText((element as HTMLTextAreaElement).value);
  } else {
    for (const child of Array.from(element.childNodes)) {
      inner += serializeNode(child, options, replaced, styles);
    }
  }
  return `${open}${inner}</${tag}>`;
}

/** Serializes everything React rendered into the body, portals included. */
export function serializeDocument(document: Document, options: SerializeOptions) {
  const replaced = new Map<Element, string>();
  for (const { selector, label } of options.placeholders) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      replaced.set(element, label);
    }
  }
  const styles: string[] = [];
  let body = "";
  counter.elements = 0;
  for (const child of Array.from(document.body.childNodes)) {
    body += serializeNode(child, options, replaced, styles);
  }
  const template = document.createElement("template");
  template.innerHTML = body;
  const reparse = {
    original: counter.elements,
    reparsed: template.content.querySelectorAll("*").length,
  };
  return { body, styles, reparse } satisfies SerializedDocument;
}
