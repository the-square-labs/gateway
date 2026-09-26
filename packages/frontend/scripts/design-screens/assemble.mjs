// Turns the exported DOM snapshots (out/dom/*.json) and the compiled stylesheet
// (out/gateway.css) into the Design canvas files under out/canvas/project/:
// one light and one dark artboard per screen, plus canvas.json.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, "out");
const domDir = path.join(outDir, "dom");
const projectDir = path.join(outDir, "canvas/project");
const config = JSON.parse(fs.readFileSync(path.join(here, "canvas.config.json"), "utf8"));

/** Canvas order; screens not listed follow alphabetically. */
const ORDER = [
  "dashboard",
  "routes-list",
  "route-detail-settings",
  "domains",
  "ssl-certificates",
  "docker-containers",
  "docker-container-detail",
  "docker-compose-project",
  "databases-list",
  "database-detail",
  "storage",
  "pages-project",
  "pages-project-tags",
  "nodes-list",
  "node-detail",
  "notifications-alerts",
  "logging-explorer",
  "settings",
  "admin-users",
  "admin-groups",
  "profile",
  "state-page-loader",
  "state-empty",
  "state-create-route-dialog",
  "state-deploy-dialog",
  "state-destructive-confirm",
  "state-button-pending",
  "state-ai-side-panel",
];

const GAP_PAIR = 80;
const GAP_COLUMN = 240;
const GAP_ROW = 160;
const PAIRS_PER_ROW = 2;
const PAGES = [
  { id: "screens", name: "Screens", group: "Screens" },
  { id: "states", name: "States", group: "States" },
];

const escapeAttr = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const escapeText = (value) =>
  String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function rewriteAssets(body) {
  let next = body;
  for (const [from, to] of Object.entries(config.assets ?? {})) {
    next = next.split(`src="${from}"`).join(`src="${to}"`);
  }
  return next;
}

/** One publish call carries at most 16 MB; inlined CSS falls back to one shared file past this. */
const INLINE_BUDGET_BYTES = 14 * 1024 * 1024;

function artboard(screen, theme, css) {
  const { width, height } = screen;
  const styles = Array.from(new Set(screen.styles.map((css) => css.trim()).filter(Boolean)))
    .join("\n")
    .replace(/\{\{/g, "{ {")
    .replace(/<\/style/gi, "<\\/style");
  const themeName = theme === "dark" ? "Dark" : "Light";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeText(screen.title)} · ${themeName}</title>
<script src="./support.js"></script>
${css.mode === "link" ? '<link rel="stylesheet" href="gateway.css">\n' : ""}</head>
<body>
<x-dc>
<helmet>
${css.mode === "inline" ? `<style data-source="gateway.css">\n${css.text}\n</style>\n` : ""}<style>
body{margin:0}
${styles}
</style>
</helmet>
<div class="${theme}" data-design-screen="${escapeAttr(screen.id)}" style="width: ${width}px; height: ${height}px; position: relative; overflow: hidden; contain: layout paint; isolation: isolate; background-color: var(--color-background); color: var(--color-foreground); color-scheme: ${theme}">${rewriteAssets(screen.body)}</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{"$preview":{"width":${width},"height":${height}}}'>
class Component extends DCLogic {
  renderVals() {
    return {};
  }
}
</script>
</body>
</html>
`;
}

function loadScreens() {
  const files = fs.readdirSync(domDir).filter((file) => file.endsWith(".json"));
  const screens = files.map((file) => JSON.parse(fs.readFileSync(path.join(domDir, file), "utf8")));
  const rank = (id) => {
    const index = ORDER.indexOf(id);
    return index === -1 ? ORDER.length : index;
  };
  return screens.sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/** The source the screens were rendered from: the commit, plus a mark for local changes. */
function sourceRevision() {
  try {
    const head = execSync("git rev-parse --short HEAD", { cwd: here }).toString().trim();
    const dirty = execSync("git status --porcelain -- ../../src", { cwd: here }).toString().trim();
    return dirty ? `${head} with uncommitted changes` : head;
  } catch {
    return "unknown";
  }
}

export function assemble({ css: requestedMode } = {}) {
  const screens = loadScreens();
  fs.rmSync(path.join(outDir, "canvas"), { recursive: true, force: true });
  fs.mkdirSync(projectDir, { recursive: true });
  const cssText = fs.readFileSync(path.join(outDir, "gateway.css"), "utf8").replace(/<\/style/gi, "<\\/style");
  const bodyBytes = screens.reduce((sum, screen) => sum + screen.body.length * 2, 0);
  const inlineBytes = bodyBytes + cssText.length * screens.length * 2;
  const mode = requestedMode ?? (inlineBytes <= INLINE_BUDGET_BYTES ? "inline" : "link");
  const css = { mode, text: cssText };
  if (mode === "link") {
    fs.copyFileSync(path.join(outDir, "gateway.css"), path.join(projectDir, "gateway.css"));
  }
  const warnings = [];
  for (const screen of screens) {
    if (screen.unmocked.length > 0) {
      warnings.push(`${screen.id}: ${screen.unmocked.length} requests had no fixture`);
    }
    if (screen.reparse && screen.reparse.original !== screen.reparse.reparsed) {
      warnings.push(
        `${screen.id}: markup re-parses to ${screen.reparse.reparsed} elements (rendered ${screen.reparse.original})`
      );
    }
  }

  const boards = {};
  const order = [];
  const notes = {};
  let first = true;
  for (const page of PAGES) {
    const pageScreens = screens.filter((screen) => screen.group === page.group);
    if (pageScreens.length === 0) continue;
    const pairWidth = (screen) => screen.width * 2 + GAP_PAIR;
    const columnWidth = Math.max(...pageScreens.map(pairWidth)) + GAP_COLUMN;
    let y = 0;
    for (let start = 0; start < pageScreens.length; start += PAIRS_PER_ROW) {
      const row = pageScreens.slice(start, start + PAIRS_PER_ROW);
      row.forEach((screen, column) => {
        const x = column * columnWidth;
        for (const theme of ["light", "dark"]) {
          const name = first ? "Main.dc.html" : `${screen.id}-${theme}.dc.html`;
          first = false;
          fs.writeFileSync(path.join(projectDir, name), artboard(screen, theme, css));
          boards[name] = {
            x: theme === "light" ? x : x + screen.width + GAP_PAIR,
            y,
            w: screen.width,
            h: screen.height,
            title: `${screen.title} · ${theme === "light" ? "Light" : "Dark"}`,
            page: page.id,
          };
          order.push(name);
        }
      });
      y += Math.max(...row.map((screen) => screen.height)) + GAP_ROW;
    }
    const rowWidth = columnWidth * PAIRS_PER_ROW - GAP_COLUMN;
    notes[`${page.id}-title`] = {
      x: 0,
      y: -320,
      text:
        page.id === "screens"
          ? "Good Gateway console: key screens, light and dark"
          : "Good Gateway console: key states, light and dark",
      kind: "title1",
      maxW: rowWidth,
      page: page.id,
    };
    notes[`${page.id}-source`] = {
      x: rowWidth + 200,
      y: 0,
      w: 520,
      maxH: 700,
      size: "m",
      fill: "gray",
      page: page.id,
      text:
        `Rendered from the real frontend code (${sourceRevision()}, ${new Date().toISOString().slice(0, 10)}) with fixture data only, ` +
        `by packages/frontend/scripts/design-screens. ` +
        (pageScreens.some((screen) => screen.placeholders.length > 0)
          ? "Hatched boxes mark parts the exporter cannot paint (charts, code editors, " +
            "terminals); their size and place are real. "
          : "") +
        `Regenerate: pnpm --filter frontend design-screens:export.`,
    };
  }

  const canvas = {
    v: 3,
    createdOnFiles: config.createdOnFiles,
    title: config.title,
    launch: { view: "canvas", page: "screens" },
    pages: PAGES.filter((page) => screens.some((screen) => screen.group === page.group)).map(
      ({ id, name }) => ({ id, name })
    ),
    boards,
    order,
    notes,
    designSystems: [],
  };
  fs.writeFileSync(path.join(projectDir, "canvas.json"), `${JSON.stringify(canvas, null, 2)}\n`);

  const files = fs.readdirSync(projectDir).filter((file) => file !== "canvas.json");
  const bytes = files.reduce((sum, file) => sum + fs.statSync(path.join(projectDir, file)).size, 0);
  const publishFiles = Object.fromEntries(
    files.map((file) => [`project/${file}`, `project/${file}`])
  );
  fs.writeFileSync(
    path.join(outDir, "canvas/publish.json"),
    `${JSON.stringify(
      {
        url: config.artifactUrl,
        root: path.join(outDir, "canvas"),
        file_path: path.join(projectDir, "canvas.json"),
        files: publishFiles,
      },
      null,
      2
    )}\n`
  );
  return { screens: screens.length, artboards: order.length, bytes, css: mode, warnings };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--css");
  const result = assemble({ css: index === -1 ? undefined : process.argv[index + 1] });
  console.log(
    `canvas: ${result.screens} screens → ${result.artboards} artboards, ${(result.bytes / 1024 / 1024).toFixed(2)} MiB, stylesheet ${result.css}`
  );
  for (const warning of result.warnings) console.warn(warning);
}
