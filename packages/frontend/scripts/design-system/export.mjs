#!/usr/bin/env node
// Exports the Good Gateway design system from the frontend sources as the
// `project/` tree of a claude.ai Design System artifact:
//
//   project/design-system.json      the index (written for the publish step)
//   project/tokens.json             colours (light + dark), type, spacing, radius, shadow, size
//   project/README.md               the brand book
//   project/components/<Name>/      README.md + preview.html per component
//   project/components/Cover/       the cover
//   project/components/bundle.js    the real components as window.GatewayUI (IIFE)
//   project/components/bundle.css   the product stylesheet, compiled by Tailwind
//   project/components/index.d.ts   the props, read with the TypeScript compiler
//   project/components/lib/         React and ReactDOM as classic scripts
//   project/assets/<Group>/         logos, favicons and edition badges (uploads)
//
// Usage (from packages/frontend):
//   pnpm design-system:export [--out <dir>] [--index <current design-system.json>]
//                             [--uploaded <uploads.json>] [--at <ISO time>] [--check]
//
// --index keeps an existing system's index keys and asset records; --uploaded
// merges { "<Group>/<file>": "/_blob/<id>" } after uploading new assets; --at
// sets lastChange.at (default: the HEAD commit time, so reruns are identical);
// --check mounts every preview in jsdom and fails on runtime errors.
// Nothing in the repository is written.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderBrandBook } from "./brand-book.mjs";
import { actionsAndForms } from "./catalog/actions-forms.mjs";
import { layoutAndData } from "./catalog/layout-data.mjs";
import { overlays } from "./catalog/overlays.mjs";
import { statusAndLoading } from "./catalog/status-loading.mjs";
import { renderCover } from "./cover.mjs";
import { buildComponentBundle, buildProductCss, buildReactLibraries, loadToolchain } from "./lib/build.mjs";
import { composite, contrastRatio, formatRatio, parseColor, withAlpha } from "./lib/color.mjs";
import { buildTokens, loadSources, readProductCss, readTailwindTheme } from "./lib/css-tokens.mjs";
import { createProgram, readCva, readExports, renderDts } from "./lib/source-meta.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "../..");
const REPO = path.resolve(FRONTEND, "../..");
const DOCS_REPO = path.resolve(REPO, "../gateway-docs");
const NAMESPACE = "GatewayUI";
const TITLE = "Good Gateway";

const CATALOG = [...actionsAndForms, ...statusAndLoading, ...overlays, ...layoutAndData];

/** Components the export deliberately leaves out, and why (README "Not synced"). */
const NOT_CARDED = [
  ["CommandPalette", "src/components/common/CommandPalette.tsx", "app-level: reads the API, auth and navigation stores"],
  ["AppStatusGate", "src/components/common/AppStatusGate.tsx", "app-level: polls the backend status"],
  ["ScopeList", "src/components/common/ScopeList.tsx", "reads the API and auth stores"],
  ["FolderedResourceList", "src/components/common/FolderedResourceList.tsx", "reads folder stores and realtime; ResourceListForm shows its UI"],
  ["RequireScope", "src/components/common/RequireScope.tsx", "a route guard with no UI of its own"],
  ["LiteModeBackButton", "src/components/common/LiteModeBackButton.tsx", "PageBackButton in AI lite mode only"],
  ["GitScopeRestriction", "src/components/common/GitScopeRestriction.tsx", "part of ScopeList: searches Git providers through the API"],
];

/** Timing constants the guides quote; a change in the source is reported. */
const EXPECTED_TIMINGS = {
  PAGE_LOADER_DELAY_MS: 500,
  PAGE_LOADER_MIN_MS: 500,
  SETTLE_MS: 50,
  REVEAL_STEP_MS: 35,
  REVEAL_DURATION_MS: 220,
  REVEAL_MAX_STAGGERED: 10,
  DIALOG_WAIT_INDICATOR_DELAY_MS: 250,
  DIALOG_WAIT_INDICATOR_MIN_MS: 300,
  DIALOG_MAX_WAIT_MS: 10_000,
};

const ASSETS = [
  { group: "Logos", tile: "l", files: [
    [path.join(DOCS_REPO, "public/brand/good-gateway-lockup-light.png"), "good-gateway-lockup-light.png", "Lockup for light grounds: the mark and the ink wordmark \"Good Gateway\". 1968 × 584."],
    [path.join(DOCS_REPO, "public/brand/good-gateway-lockup-dark.png"), "good-gateway-lockup-dark.png", "Lockup for dark grounds: white wordmark on a rounded black plate. 1932 × 512."],
    [path.join(FRONTEND, "public/android-chrome-512x512.png"), "good-gateway-mark-512.png", "The mark on its tile, 512px (the product's android-chrome-512, og-image and the docs logo are this same file)."],
    [path.join(FRONTEND, "public/android-chrome-192x192.png"), "good-gateway-mark-192.png", "The mark, 192px: what the sidebar shows at 20px."],
  ] },
  { group: "Favicons", tile: "s", files: [
    [path.join(FRONTEND, "public/favicon-48x48.png"), "favicon-48x48.png", "Browser favicon, 48px."],
    [path.join(FRONTEND, "public/favicon-32x32.png"), "favicon-32x32.png", "Browser favicon, 32px."],
    [path.join(FRONTEND, "public/favicon-16x16.png"), "favicon-16x16.png", "Browser favicon, 16px."],
    [path.join(FRONTEND, "public/apple-touch-icon.png"), "apple-touch-icon.png", "iOS home screen icon, 180px."],
    [path.join(FRONTEND, "public/mstile-310x310.png"), "mstile-310x310.png", "Windows tile, 310px (tile colour theme-color)."],
    [path.join(FRONTEND, "public/mstile-150x150.png"), "mstile-150x150.png", "Windows tile, 150px."],
    [path.join(FRONTEND, "public/mstile-70x70.png"), "mstile-70x70.png", "Windows tile, 70px."],
  ] },
  { group: "Editions", tile: "m", files: [
    [path.join(FRONTEND, "public/license/wiolett-gw-personal.png"), "wiolett-gw-personal.png", "Personal edition badge, 128px (licence settings)."],
    [path.join(FRONTEND, "public/license/wiolett-gw-community.png"), "wiolett-gw-community.png", "Community edition badge, 128px."],
    [path.join(FRONTEND, "public/license/wiolett-gw-business.png"), "wiolett-gw-business.png", "Business edition badge, 128px."],
    [path.join(FRONTEND, "public/license/wiolett-gw-enterprise.png"), "wiolett-gw-enterprise.png", "Enterprise edition badge, 128px."],
  ] },
];

const PRELUDE = `var G = window.${NAMESPACE}, h = React.createElement, I = G.Icons;
function mount(node) { ReactDOM.createRoot(document.getElementById("root")).render(node); }
function stage() { return h.apply(null, ["div", { className: "space-y-4 p-4" }].concat(Array.prototype.slice.call(arguments))); }
function row(label) { return h.apply(null, ["div", { className: "flex flex-wrap items-center gap-3" }, label ? h("span", { className: "w-24 shrink-0 text-xs font-medium text-foreground" }, label) : null].concat(Array.prototype.slice.call(arguments, 1))); }`;

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { out: path.join(process.env.TMPDIR || os.tmpdir(), "gateway-design-system") };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${key} needs a value`);
      return argv[i];
    };
    if (key === "--out") args.out = path.resolve(next());
    else if (key === "--index") args.index = path.resolve(next());
    else if (key === "--uploaded") args.uploaded = path.resolve(next());
    else if (key === "--at") args.at = next();
    else if (key === "--by") args.by = next();
    else if (key === "--via") args.via = next();
    else if (key === "--note") args.note = next();
    else if (key === "--check") args.check = true;
    else if (key === "--harness") args.harness = true;
    else if (key === "--help" || key === "-h") args.help = true;
    else throw new Error(`Unknown option ${key}`);
  }
  return args;
}

function git(...args) {
  try {
    return execFileSync("git", ["-C", REPO, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function writeFile(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function mdCell(text) {
  return String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function stateClasses(text, prefix) {
  const re = new RegExp(`(?<![\\w:-])${prefix}:([^\\s"'\`]+)`, "g");
  const out = new Set();
  for (const match of text.matchAll(re)) out.add(match[1]);
  return [...out].join(" ");
}

function readTimings() {
  const text = ["src/components/common/reveal-gate.tsx", "src/components/ui/dialog.tsx"]
    .map((rel) => fs.readFileSync(path.join(FRONTEND, rel), "utf8"))
    .join("\n");
  const timings = {};
  const drift = [];
  for (const [name, expected] of Object.entries(EXPECTED_TIMINGS)) {
    const match = new RegExp(`const ${name} = ([\\d_]+);`).exec(text);
    const value = match ? Number(match[1].replaceAll("_", "")) : expected;
    timings[name] = value;
    if (!match) drift.push(`${name} not found in the source`);
    else if (value !== expected) drift.push(`${name} is ${value} in the source, the guides say ${expected}`);
  }
  return { timings, drift };
}

function brandColor() {
  const html = fs.readFileSync(path.join(FRONTEND, "index.html"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(FRONTEND, "public/site.webmanifest"), "utf8"));
  const meta = /<meta name="theme-color" content="([^"]+)"/.exec(html)?.[1];
  const sources = [];
  if (meta) sources.push("index.html theme-color");
  if (manifest.theme_color) sources.push("site.webmanifest theme_color");
  const findings = [];
  if (meta && manifest.theme_color && meta.toLowerCase() !== manifest.theme_color.toLowerCase()) {
    findings.push(`theme-color differs: index.html ${meta}, site.webmanifest ${manifest.theme_color}.`);
  }
  if (manifest.background_color) {
    findings.push(`site.webmanifest background_color is ${manifest.background_color}, not a theme token (dark background is #0e0e0e).`);
  }
  return { value: meta ?? manifest.theme_color, sources, findings, tagline: manifest.description ?? "" };
}

// --- contrast of cva variants (Button, Badge) ------------------------------

const TEXT_SIZE = /^text-(xs|sm|base|lg|xl|[2-9]xl|left|right|center|ellipsis|wrap|nowrap|\[\d)/;

function resolveColorName(name, themeValues, tailwindTheme) {
  const cssVar = /^\[color:var\(--([\w-]+)\)\]$/.exec(name);
  if (cssVar) return themeValues.get(cssVar[1]) ?? null;
  const [base, alphaText] = name.split("/");
  let color = null;
  if (themeValues.has(`color-${base}`)) color = themeValues.get(`color-${base}`);
  else if (tailwindTheme.has(`color-${base}`)) color = parseColor(tailwindTheme.get(`color-${base}`));
  if (!color) return null;
  return alphaText ? withAlpha(color, Number(alphaText) / 100) : color;
}

function variantPaint(classes, theme, themeValues, tailwindTheme) {
  const tokens = classes.split(/\s+/);
  const pick = (prefix) => {
    const plain = tokens.filter((c) => c.startsWith(`${prefix}-`) && !(prefix === "text" && TEXT_SIZE.test(c)));
    const dark = tokens.filter((c) => c.startsWith(`dark:${prefix}-`)).map((c) => c.slice(5));
    const chosen = theme === "dark" && dark.length ? dark : plain;
    for (const cls of chosen) {
      const color = resolveColorName(cls.slice(prefix.length + 1), themeValues, tailwindTheme);
      if (color) return color;
    }
    return null;
  };
  return { bg: pick("bg"), text: pick("text") };
}

function cvaContrast(cva, themes, tailwindTheme) {
  const rows = [];
  for (const [variant, classes] of Object.entries(cva.variants.variant)) {
    const cells = [];
    for (const theme of themes) {
      const values = new Map([...theme.values].map(([name, value]) => [name, parseColor(value)]));
      const paint = variantPaint(classes, theme.id, values, tailwindTheme);
      for (const groundName of ["color-background", "color-card"]) {
        const ground = values.get(groundName);
        const fill = paint.bg ? composite(paint.bg, ground) : ground;
        const text = paint.text ?? values.get("color-foreground");
        const ratio = contrastRatio(composite(text, fill), fill);
        cells.push({ theme: theme.id, ground: groundName.replace("color-", ""), ratio });
      }
    }
    rows.push({ variant, cells });
  }
  return rows;
}

// --- files ---------------------------------------------------------------------

function renderPreview(entry, facts) {
  const script = entry.preview(facts).trim();
  const attrs = [`group="${entry.group}"`, `height=${entry.height}`];
  if (entry.width) attrs.push(`width=${entry.width}`);
  const doc = `<!-- @dsCard ${attrs.join(" ")} -->
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${entry.name}</title></head>
<body>
<div id="root"></div>
<script>
${PRELUDE}
${script}
</script>
</body>
</html>
`;
  if (/<\/script/i.test(script) || /<!--/.test(script)) throw new Error(`${entry.name}: preview script would end its element`);
  return doc;
}

function renderComponentReadme(entry, facts, exportsMeta, contrastRows) {
  const lines = [`# ${entry.name}`, "", entry.summary, "", entry.guide.trim(), ""];
  if (facts.cva) {
    lines.push("## Variants", "");
    for (const [group, options] of Object.entries(facts.cva.variants)) {
      lines.push(`**${group}** (default \`${facts.cva.defaults[group] ?? "none"}\`)`, "", "| Option | Classes |", "| --- | --- |");
      for (const [option, classes] of Object.entries(options)) lines.push(`| \`${option}\` | \`${mdCell(classes)}\` |`);
      lines.push("");
    }
    lines.push(`Base classes: \`${mdCell(facts.cva.base)}\``, "");
    const undescribed = Object.entries(facts.cva.variants).flatMap(([group, options]) =>
      Object.keys(options)
        .filter((option) => !entry.guide.includes(`\`${option}\``))
        .map((option) => `\`${option}\` (${group}: \`${mdCell(options[option])}\`)`)
    );
    if (undescribed.length) lines.push(`In the source but not yet described in these guidelines: ${undescribed.join(", ")}.`, "");
  }
  if (contrastRows) {
    lines.push("## Contrast", "", "Label text on the variant's fill, over the page (`background`) and a card (`card`); 4.5:1 needed.", "", "| Variant | Light · background | Light · card | Dark · background | Dark · card |", "| --- | --- | --- | --- | --- |");
    for (const row of contrastRows) {
      const cell = (theme, ground) => {
        const c = row.cells.find((x) => x.theme === theme && x.ground === ground);
        return `${formatRatio(c.ratio)}${c.ratio < 4.5 ? " ✗" : ""}`;
      };
      lines.push(`| \`${row.variant}\` | ${cell("light", "background")} | ${cell("light", "card")} | ${cell("dark", "background")} | ${cell("dark", "card")} |`);
    }
    lines.push("");
  }
  lines.push("## Props", "");
  for (const name of entry.exports) {
    const meta = exportsMeta.get(name);
    if (!meta) {
      lines.push(`- \`${name}\`: not found in the bundle entry.`);
      continue;
    }
    if (meta.kind === "value") {
      lines.push(`**\`${name}\`**: \`${mdCell(meta.type)}\``, "");
      continue;
    }
    const generics = meta.typeParams.length ? `<${meta.typeParams.join(", ")}>` : "";
    lines.push(`**\`${name}${generics}\`**${meta.doc ? `: ${meta.doc}` : ""}`, "");
    if (meta.own.length) {
      lines.push("| Prop | Type | Notes |", "| --- | --- | --- |");
      for (const prop of meta.own) lines.push(`| \`${prop.name}${prop.optional ? "?" : ""}\` | \`${mdCell(prop.type)}\` | ${mdCell(prop.doc)} |`);
      lines.push("");
    }
    if (meta.inherited.length) {
      const parts = meta.inherited.map(([pkg, count, names]) =>
        pkg === "@types/react"
          ? `${count} HTML attributes and event handlers (\`@types/react\`)`
          : count <= 16
            ? `from \`${pkg}\`: ${names.map((n) => `\`${n}\``).join(", ")}`
            : `${count} props from \`${pkg}\``
      );
      lines.push(`Also accepts ${parts.join("; ")}.`, "");
    }
    if (!meta.own.length && !meta.inherited.length) lines.push("No props.", "");
  }
  const sources = [entry.source, ...(entry.extraSources ?? [])];
  lines.push("## Source", "", sources.map((source) => `\`packages/frontend/${source}\``).join(", "), "");
  return lines.join("\n");
}

function sizeTokens(cva) {
  const rem = (cls) => {
    const match = /^(?:h|w|min-h)-(\d+(?:\.\d+)?)$/.exec(cls);
    return match ? `${Number(match[1]) * 4}px` : null;
  };
  const tokens = [];
  for (const [size, classes] of Object.entries(cva.button.variants.size)) {
    const height = classes.split(" ").map(rem).find(Boolean);
    const icon = size.startsWith("icon");
    if (!height) {
      tokens.push({ name: `button-${size}`, value: "auto", usage: `Button size \`${size}\` has no box of its own (${classes}).` });
      continue;
    }
    tokens.push({ name: `button-${size}`, value: height, usage: icon ? `Square icon button, ${height} (Button size \`${size}\`).` : `Button size \`${size}\`: ${height} high, text stays 14px.` });
  }
  for (const [size, classes] of Object.entries(cva.badge.variants.size)) {
    const height = classes.split(" ").map(rem).find(Boolean);
    tokens.push({ name: `badge-${size}`, value: height, usage: `Badge size \`${size}\`.` });
  }
  tokens.push({ name: "control", value: "36px", usage: "Input, Select trigger, NumericInput, CopyValueField (h-9): every single-line control." });
  const dataTable = fs.readFileSync(path.join(FRONTEND, "src/components/ui/data-table.tsx"), "utf8");
  const rowHeight = /const ROW_HEIGHT = (\d+);/.exec(dataTable)?.[1];
  if (rowHeight) tokens.push({ name: "datatable-row", value: `${rowHeight}px`, usage: "DataTable row height used for virtualisation (px-4 py-3 cells)." });
  tokens.push({ name: "resource-row", value: "52px", usage: "Resource list rows (ResourceListCell min-h-[52px])." });
  return { note: "Heights of controls and rows, read from the component sources.", tokens };
}

function buildIndex({ existing, at, by, via, note, assetRecords, reactVersion, reactDomVersion }) {
  const libraries = [
    { name: "react", version: reactVersion, global: "React", file: "components/lib/react.production.min.js" },
    { name: "react-dom", version: reactDomVersion, global: "ReactDOM", file: "components/lib/react-dom.production.min.js" },
  ];
  const assetGroups = {};
  for (const group of ASSETS) {
    const previous = existing?.assetGroups?.[group.group];
    assetGroups[group.group] = {
      ...(previous ?? {}),
      name: group.group,
      tile: previous?.tile ?? group.tile,
      order: group.files.map(([, name]) => name),
      files: { ...(previous?.files ?? {}), ...(assetRecords[group.group] ?? {}) },
    };
  }
  const base = existing ?? {
    v: 3,
    layout: "files",
    createdOnFiles: { v: 1, at },
    sections: {},
    blobs: {},
    docs: { readme: "project/README.md", sections: [] },
  };
  return {
    ...base,
    title: existing?.title ?? TITLE,
    namespace: NAMESPACE,
    libraries,
    groups: ASSETS.map((group) => group.group),
    assetGroups: { ...(existing?.assetGroups ?? {}), ...assetGroups },
    lastChange: { by, at, via, note },
  };
}

// --- local harness --------------------------------------------------------------------

/** The CSS custom properties the artifact page compiles from tokens.json (approximation for local viewing). */
function tokensCss(tokens) {
  const themeIds = tokens.color.themes.map((theme) => theme.id);
  const first = themeIds[0];
  const decl = (name, value) => `  --${name}: ${value};`;
  const colorValue = (token, theme) => {
    const value = typeof token.value === "string" ? token.value : (token.value[theme] ?? token.value[first]);
    return value.replace(/^\{(.+)\}$/, "var(--$1)");
  };
  const blocks = themeIds.map((theme, index) => {
    const selector = index === 0 ? `:root, [data-theme="${theme}"]` : `[data-theme="${theme}"]`;
    const lines = [...tokens.color.tokens, ...tokens.shadow.tokens].map((token) => decl(token.name, colorValue(token, theme)));
    return `${selector} {\n${lines.join("\n")}\n}`;
  });
  const other = [tokens.spacing, tokens.radius, tokens.size].flatMap((family) => family.tokens.map((token) => decl(token.name, token.value)));
  other.push(...Object.entries(tokens.type.families).map(([key, stack]) => decl(`font-${key}`, stack)));
  blocks.push(`:root {\n${other.join("\n")}\n}`);
  return blocks.join("\n");
}

/** harness/<Name>.html: each preview in a page like the artifact's frame, for a local look (?theme=dark). */
function writeHarness(out, projectDir, tokens, entries) {
  const css = tokensCss(tokens);
  writeFile(out, "harness/tokens.css", css);
  const names = [];
  for (const entry of entries) {
    const html = fs.readFileSync(path.join(projectDir, `components/${entry.name}/preview.html`), "utf8");
    const width = entry.width ?? 720;
    const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? "";
    const body = /<body>([\s\S]*)<\/body>/.exec(html)[1];
    const page = `<!doctype html>
<html data-theme="light">
<head>
<meta charset="utf-8">
<script>document.documentElement.setAttribute("data-theme", new URLSearchParams(location.search).get("theme") || "light");</script>
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="../project/components/bundle.css">
<script src="../project/components/lib/react.production.min.js"></script>
<script src="../project/components/lib/react-dom.production.min.js"></script>
<script src="../project/components/bundle.js"></script>
${head.replace(/<meta charset="utf-8">/, "")}
<style>html, body { margin: 0; } body { width: ${width}px; min-height: ${entry.height ?? 120}px; }</style>
</head>
<body>${body}</body>
</html>
`;
    writeFile(out, `harness/${entry.name}.html`, page);
    names.push(entry.name);
  }
  const links = names.map((name) => `<li><a href="${name}.html">${name}</a> · <a href="${name}.html?theme=dark">dark</a></li>`).join("\n");
  writeFile(out, "harness/index.html", `<!doctype html><meta charset="utf-8"><title>Good Gateway previews</title><ul>\n${links}\n</ul>\n`);
}

// --- jsdom check -------------------------------------------------------------------

async function checkPreviews(projectDir, entries) {
  const frontendRequire = createRequire(path.join(FRONTEND, "package.json"));
  const { JSDOM, VirtualConsole } = frontendRequire("jsdom");
  const scripts = ["components/lib/react.production.min.js", "components/lib/react-dom.production.min.js", "components/bundle.js"].map((rel) => fs.readFileSync(path.join(projectDir, rel), "utf8"));
  const failures = [];
  for (const entry of entries) {
    const html = fs.readFileSync(path.join(projectDir, `components/${entry.name}/preview.html`), "utf8");
    const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
    const errors = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("jsdomError", (error) => errors.push(error.message));
    virtualConsole.on("error", (...args) => errors.push(args.map(String).join(" ").slice(0, 300)));
    const dom = new JSDOM('<!doctype html><html data-theme="light"><body><div id="root"></div></body></html>', { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole, url: "https://preview.local/" });
    const { window } = dom;
    window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
    window.matchMedia = (query) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent() { return false; } });
    if (!window.PointerEvent) {
      window.PointerEvent = class PointerEvent extends window.MouseEvent {
        constructor(type, init = {}) {
          super(type, init);
          this.pointerType = init.pointerType ?? "mouse";
          this.pointerId = init.pointerId ?? 1;
        }
      };
    }
    window.HTMLElement.prototype.scrollIntoView = () => {};
    window.HTMLElement.prototype.hasPointerCapture = () => false;
    window.HTMLElement.prototype.releasePointerCapture = () => {};
    window.Element.prototype.scrollTo = () => {};
    window.URL.createObjectURL = () => "blob:preview";
    window.URL.revokeObjectURL = () => {};
    window.addEventListener("error", (event) => errors.push(event.message));
    try {
      for (const code of scripts) window.eval(code);
      window.eval(script);
      await new Promise((resolve) => setTimeout(resolve, entry.checkWaitMs ?? 150));
    } catch (error) {
      errors.push(error.message);
    }
    const rendered = window.document.body.textContent.trim().length > 0 || window.document.body.querySelectorAll("svg,input,button").length > 0;
    const unexpected = entry.expectErrors ? [] : errors.filter((message) => !/Not implemented|getComputedStyle|scrollTo|canvas/i.test(message));
    if ((!rendered && !entry.layoutDependent) || unexpected.length) failures.push({ name: entry.name, rendered, errors: unexpected.slice(0, 3) });
    window.close();
  }
  return failures;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), "utf8").split("\n").slice(1, 25).join("\n"));
    return;
  }
  const out = args.out;
  const projectDir = path.join(out, "project");
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.mkdirSync(projectDir, { recursive: true });

  const tool = loadToolchain(FRONTEND);
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  const sha = git("rev-parse", "--short", "HEAD");
  const dirty = git("status", "--porcelain", "--", "packages/frontend/src", "packages/frontend/public", "packages/frontend/index.html").length > 0;
  const at = args.at ?? (git("log", "-1", "--format=%cI") || new Date(0).toISOString());
  const atIso = new Date(at).toISOString();
  const remote = git("remote", "get-url", "github") || git("remote", "get-url", "origin");
  const repo = /github\.com[/:]([^/]+\/[^/.]+)/.exec(remote)?.[1] ?? "the-square-labs/gateway";

  console.log(`Good Gateway design system → ${projectDir}`);
  console.log(`  source ${repo} ${branch}@${sha}${dirty ? " (+ uncommitted frontend changes)" : ""}`);

  // Sources ---------------------------------------------------------------------
  const sources = loadSources(FRONTEND);
  const product = readProductCss(FRONTEND);
  const tailwindTheme = readTailwindTheme(tool.tailwindThemePath);
  const brand = brandColor();
  const { timings, drift } = readTimings();

  const entryFile = path.join(HERE, "entry.tsx");
  const program = createProgram(tool.ts, FRONTEND, entryFile);
  const exportsMeta = readExports(tool.ts, program, entryFile, FRONTEND);
  const cvaOf = (rel) => readCva(tool.ts, program, path.join(FRONTEND, rel));
  const cva = { button: cvaOf("src/components/ui/button.tsx"), badge: cvaOf("src/components/ui/badge.tsx") };

  const kitSources = CATALOG.flatMap((entry) => [entry.source, ...(entry.extraSources ?? [])]);
  const meta = {
    source: "github",
    repo,
    ref: `${branch}@${sha}`,
    package: "packages/frontend",
    paths: {
      tokens: ["packages/frontend/src/index.css", "packages/frontend/src/css/base.css", "tailwindcss/theme.css (default theme)", "packages/frontend/index.html (theme-color)"],
      fonts: [],
      assets: ASSETS.flatMap((group) => group.files.map(([file]) => path.relative(path.dirname(REPO), file))),
      docs: ["packages/frontend/src/components/ui", "packages/frontend/src/components/common", "rc.10 frontend guide"],
    },
    components: Object.fromEntries(CATALOG.map((entry) => [entry.name, `packages/frontend/${entry.source}`])),
    synced: atIso,
    ...(dirty ? { workingTree: "includes uncommitted frontend changes" } : {}),
  };

  const tokenResult = buildTokens({ frontendDir: FRONTEND, tailwindTheme, product, sources, brandColor: brand, kitSources, meta });
  const tokens = tokenResult.tokens;
  tokens.size = sizeTokens(cva);

  const lightValues = new Map(tokens.color.tokens.filter((t) => typeof t.value === "object").map((t) => [t.name, t.value.light]));
  const darkValues = new Map(tokens.color.tokens.filter((t) => typeof t.value === "object").map((t) => [t.name, t.value.dark]));
  lightValues.set("theme-color", brand.value);
  darkValues.set("theme-color", brand.value);
  const themes = [{ id: "light", values: lightValues }, { id: "dark", values: darkValues }];
  const contrastByComponent = {
    Button: cvaContrast(cva.button, themes, tailwindTheme),
    Badge: cvaContrast(cva.badge, themes, tailwindTheme),
  };

  // Components ----------------------------------------------------------------------
  const summaries = new Map();
  for (const entry of CATALOG) {
    const text = [entry.source, ...(entry.extraSources ?? [])].map((rel) => fs.readFileSync(path.join(FRONTEND, rel), "utf8")).join("\n");
    const entryCva = /\bcva\(/.test(text) ? cvaOf(entry.source) : null;
    const hover = entryCva?.variants.variant
      ? Object.fromEntries(Object.entries(entryCva.variants.variant).map(([name, classes]) => [name, stateClasses(classes, "hover")]))
      : stateClasses(text, "hover");
    const focus = stateClasses(entryCva ? entryCva.base : text, "focus-visible");
    const facts = { cva: entryCva, hover, focus };
    for (const name of entry.exports) if (!summaries.has(name)) summaries.set(name, name === entry.exports[0] ? entry.summary : "");
    writeFile(projectDir, `components/${entry.name}/preview.html`, renderPreview(entry, facts));
    const contrastRows = entry.contrastFromCva || entry.name === "Button" ? contrastByComponent[entry.name] : null;
    writeFile(projectDir, `components/${entry.name}/README.md`, renderComponentReadme(entry, facts, exportsMeta, contrastRows));
  }
  writeFile(projectDir, "components/Cover/preview.html", renderCover({ tokens, tagline: brand.tagline }));

  // Runnable bundle --------------------------------------------------------------------
  const libs = await buildReactLibraries({ esbuild: tool.esbuild, frontendDir: FRONTEND });
  writeFile(projectDir, "components/lib/react.production.min.js", libs.react);
  writeFile(projectDir, "components/lib/react-dom.production.min.js", libs.reactDom);
  const bundle = await buildComponentBundle({ esbuild: tool.esbuild, frontendDir: FRONTEND, entryFile, namespace: NAMESPACE, componentNames: CATALOG.map((entry) => entry.name) });
  writeFile(projectDir, "components/bundle.js", bundle);
  const css = await buildProductCss({ tailwindNode: tool.tailwindNode, oxide: tool.oxide, frontendDir: FRONTEND, extraSources: [path.join(projectDir, "components")] });
  writeFile(projectDir, "components/bundle.css", css.css);
  writeFile(projectDir, "components/index.d.ts", renderDts(exportsMeta, { namespace: NAMESPACE, summaries }));

  // Compiled-theme check: which theme :root carries once Tailwind has compiled index.css.
  const rootBackground = /:root,:host\{[^}]*?--color-background:([^;}]+)/.exec(css.css)?.[1];
  const extraFindings = [];
  for (const [component, rows] of Object.entries(contrastByComponent)) {
    const low = rows.flatMap((row) => row.cells.filter((cell) => cell.ratio < 4.5).map((cell) => ({ variant: row.variant, ...cell })));
    if (!low.length) continue;
    const byVariant = new Map();
    for (const cell of low) {
      const list = byVariant.get(cell.variant) ?? [];
      list.push(`${formatRatio(cell.ratio)} on ${cell.ground} in ${cell.theme}`);
      byVariant.set(cell.variant, list);
    }
    extraFindings.push(`${component} labels below 4.5:1: ${[...byVariant].map(([variant, list]) => `\`${variant}\` (${list.join(", ")})`).join("; ")}. See the ${component} card.`);
  }
  if (rootBackground && rootBackground.toLowerCase() === product.darkClass.get("color-background")?.toLowerCase() && product.theme.get("color-background")?.toLowerCase() !== rootBackground.toLowerCase()) {
    extraFindings.push("The compiled stylesheet's `:root` carries the **dark** values: Tailwind hoists the `@theme` inside `@media (prefers-color-scheme: dark)` in `src/index.css` into the global theme, so the media query never reaches the output. Themes only work through the `.light` / `.dark` class the app sets on `<html>`; before it runs, a light-mode page paints dark.");
  }

  // Tokens, README, assets ----------------------------------------------------------------
  writeFile(projectDir, "tokens.json", `${JSON.stringify(tokens, null, 2)}\n`);

  const assetRecords = {};
  const uploads = [];
  const uploaded = args.uploaded ? JSON.parse(fs.readFileSync(args.uploaded, "utf8")) : {};
  const existing = args.index ? JSON.parse(fs.readFileSync(args.index, "utf8")) : null;
  for (const group of ASSETS) {
    const readme = [`# ${group.group}`, "", ...group.files.map(([, name, usage]) => `- \`${name}\`: ${usage}`), ""];
    if (group.group === "Logos") readme.push("Full-colour raster marks: use them as they are on light or dark grounds as named; never recolour. No vector (SVG) version of the mark exists in the product or the docs.", "");
    writeFile(projectDir, `assets/${group.group}/README.md`, readme.join("\n"));
    for (const [file, name] of group.files) {
      if (!fs.existsSync(file)) {
        console.warn(`  asset missing: ${file}`);
        continue;
      }
      const bytes = fs.readFileSync(file);
      writeFile(projectDir, `assets/${group.group}/${name}`, bytes);
      const key = `${group.group}/${name}`;
      const previous = existing?.assetGroups?.[group.group]?.files?.[name];
      const record = { name, size: bytes.length, type: "image/png" };
      if (uploaded[key]) {
        assetRecords[group.group] = { ...(assetRecords[group.group] ?? {}), [name]: { ...record, blob: String(uploaded[key]).replace(/^\/_blob\//, "") } };
      } else if (previous?.blob && previous.size === bytes.length) {
        assetRecords[group.group] = { ...(assetRecords[group.group] ?? {}), [name]: previous };
      } else {
        uploads.push({ key, path: `project/assets/${group.group}/${name}`, sha256: crypto.createHash("sha256").update(bytes).digest("hex") });
      }
    }
  }

  // Kit and shared files the catalog does not cover yet (new since it was written).
  const covered = new Set([...kitSources, ...NOT_CARDED.map(([, source]) => source)]);
  const uncovered = ["src/components/ui", "src/components/common"].flatMap((dir) =>
    fs
      .readdirSync(path.join(FRONTEND, dir))
      .filter((file) => /\.tsx$/.test(file) && !/\.test\.tsx$/.test(file))
      .map((file) => `${dir}/${file}`)
      .filter((rel) => !covered.has(rel))
  );
  const notSynced = [
    ...(uncovered.length ? [`Not yet in the catalog (no card): ${uncovered.map((rel) => `\`${rel.replace("src/components/", "")}\``).join(", ")}.`] : []),
    `Components without a card: ${NOT_CARDED.map(([name, , why]) => `${name} (${why})`).join("; ")}.`,
    "Fonts: no font files. The product uses the system UI stack; nothing to copy.",
    "`src/index.css`: the `@keyframes` inside `@theme` (accordion, collapsible) and the animation variables have no token family; their durations are under Motion.",
    "Previews run the real components with sample data.",
    ...drift.map((line) => `Timing drift: ${line}.`),
  ];
  const readme = renderBrandBook({ tokens, contrast: tokenResult.contrast, timings, cva, components: CATALOG, reactVersion: tool.reactVersion, notSynced, extraFindings });
  writeFile(projectDir, "README.md", readme);

  const index = buildIndex({
    existing,
    at: atIso,
    by: args.by ?? "Claude",
    via: args.via ?? "Claude Code",
    note: args.note ?? `Generated from ${repo}@${sha}${dirty ? " + working tree" : ""}: ${tokens.color.tokens.length} colours, ${CATALOG.length} components.`,
    assetRecords,
    reactVersion: tool.reactVersion,
    reactDomVersion: tool.reactDomVersion,
  });
  writeFile(projectDir, "design-system.json", `${JSON.stringify(index, null, 2)}\n`);

  // Publish plan and findings, beside project/ -------------------------------------------
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(out, full));
    }
  };
  walk(projectDir);
  files.sort();
  const publishFiles = files.filter((rel) => rel !== "project/design-system.json" && !/\/assets\/[^/]+\/[^/]+\.png$/.test(rel));
  writeFile(out, "publish-plan.json", `${JSON.stringify({ root: out, file_path: path.join(out, "project/design-system.json"), files: Object.fromEntries(publishFiles.map((rel) => [rel, rel])), uploads }, null, 2)}\n`);
  const failing = tokenResult.contrast.filter((row) => !row.pass).map((row) => ({ ...row, ratio: Math.floor(row.ratio * 100) / 100 }));
  const findings = {
    contrast: failing,
    buttonContrast: contrastByComponent.Button.flatMap((row) => row.cells.filter((c) => c.ratio < 4.5).map((c) => ({ variant: row.variant, ...c, ratio: Math.floor(c.ratio * 100) / 100 }))),
    badgeContrast: contrastByComponent.Badge.flatMap((row) => row.cells.filter((c) => c.ratio < 4.5).map((c) => ({ variant: row.variant, ...c, ratio: Math.floor(c.ratio * 100) / 100 }))),
    themeConsistency: tokenResult.consistency,
    compiledTheme: extraFindings,
    brand: brand.findings,
    rawPalette: Object.fromEntries([...tokenResult.palette].map(([shade, entry]) => [shade, { count: entry.count, files: [...entry.files] }])),
    timingDrift: drift,
  };
  writeFile(out, "findings.json", `${JSON.stringify(findings, null, 2)}\n`);

  console.log(`  tokens: ${tokens.color.tokens.length} colours × 2 themes, ${tokens.type.groups.flatMap((g) => g.styles).length} type styles, ${tokens.spacing.tokens.length} spacing, ${tokens.radius.tokens.length} radius, ${tokens.shadow.tokens.length} shadow, ${tokens.size.tokens.length} size`);
  console.log(`  components: ${CATALOG.length} (+ cover); bundle.js ${(bundle.length / 1024).toFixed(0)} KB, bundle.css ${(css.css.length / 1024).toFixed(0)} KB`);
  console.log(`  contrast: ${failing.length} token pairs below their floor`);
  console.log(`  files: ${files.length}; uploads needed: ${uploads.length}`);

  if (args.harness) {
    writeHarness(out, projectDir, tokens, [...CATALOG, { name: "Cover", width: 960, height: 288 }]);
    console.log(`  harness: ${path.join(out, "harness/index.html")}`);
  }

  if (args.check) {
    const failures = await checkPreviews(projectDir, CATALOG);
    if (failures.length) {
      console.error("  preview check failed:");
      for (const failure of failures) console.error(`   - ${failure.name}: ${failure.rendered ? "" : "rendered nothing; "}${failure.errors.join(" | ")}`);
      process.exitCode = 1;
    } else {
      console.log(`  preview check: ${CATALOG.length} previews mounted without errors (jsdom)`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
