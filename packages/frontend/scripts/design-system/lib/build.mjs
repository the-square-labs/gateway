// Builds the runnable parts of the design system from the product sources:
// React 19 as two classic scripts, the component bundle (window.GatewayUI)
// and the product stylesheet compiled by Tailwind exactly as the app build
// compiles src/index.css.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const NODE_ENV_DEFINE = {
  "process.env.NODE_ENV": '"production"',
  "import.meta.env.DEV": "false",
  "import.meta.env.PROD": "true",
  "import.meta.env.MODE": '"production"',
  "import.meta.env": '{"DEV":false,"PROD":true,"MODE":"production"}',
};

/** esbuild through Vite, and Tailwind's compiler through its Vite plugin: the product's own toolchain. */
export function loadToolchain(frontendDir) {
  const frontendRequire = createRequire(path.join(frontendDir, "package.json"));
  const viteRequire = createRequire(frontendRequire.resolve("vite"));
  const tailwindViteRequire = createRequire(frontendRequire.resolve("@tailwindcss/vite"));
  return {
    esbuild: viteRequire("esbuild"),
    tailwindNode: tailwindViteRequire("@tailwindcss/node"),
    oxide: tailwindViteRequire("@tailwindcss/oxide"),
    ts: frontendRequire("typescript"),
    tailwindThemePath: frontendRequire.resolve("tailwindcss/theme.css"),
    reactVersion: frontendRequire("react/package.json").version,
    reactDomVersion: frontendRequire("react-dom/package.json").version,
  };
}

/** Maps bare `react` / `react-dom` imports to the globals the libraries define. */
function globalsPlugin(map) {
  const filter = new RegExp(`^(${Object.keys(map).map((key) => key.replace(/[/-]/g, "\\$&")).join("|")})$`);
  return {
    name: "design-system-globals",
    setup(build) {
      build.onResolve({ filter }, (args) => ({ path: args.path, namespace: "ds-global" }));
      build.onLoad({ filter: /.*/, namespace: "ds-global" }, (args) => ({
        contents: `module.exports = ${map[args.path]};`,
        loader: "js",
      }));
    },
  };
}

/** A classic script must not end or escape the inline element a consumer puts it in. */
function makeInlineSafe(code) {
  return code.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "\\x3C!--");
}

function assertClassicSafe(name, code) {
  const problems = [];
  if (/<\/script/i.test(code)) problems.push("</script");
  if (/<!--/.test(code)) problems.push("<!--");
  if (/\beval\s*\(/.test(code)) problems.push("eval(");
  if (/\bnew Function\s*\(/.test(code)) problems.push("new Function(");
  if (/^\s*(import|export)\s/m.test(code)) problems.push("module syntax");
  if (problems.length > 0) throw new Error(`${name}: not a safe classic script (${problems.join(", ")})`);
}

async function buildScript(esbuild, options) {
  const result = await esbuild.build({
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    legalComments: "eof",
    charset: "utf8",
    logLevel: "silent",
    define: NODE_ENV_DEFINE,
    ...options,
  });
  if (result.warnings.length > 0) {
    for (const warning of result.warnings.slice(0, 5)) {
      console.warn(`  esbuild: ${warning.text}${warning.location ? ` (${warning.location.file})` : ""}`);
    }
  }
  return result.outputFiles[0].text;
}

export async function buildReactLibraries({ esbuild, frontendDir }) {
  const react = await buildScript(esbuild, {
    stdin: { contents: 'window.React = require("react");', resolveDir: frontendDir, loader: "js" },
  });
  const reactDom = await buildScript(esbuild, {
    stdin: {
      contents: 'window.ReactDOM = Object.assign({}, require("react-dom"), require("react-dom/client"));',
      resolveDir: frontendDir,
      loader: "js",
    },
    plugins: [globalsPlugin({ react: "window.React" })],
  });
  const out = { react: makeInlineSafe(react), reactDom: makeInlineSafe(reactDom) };
  assertClassicSafe("react", out.react);
  assertClassicSafe("react-dom", out.reactDom);
  return out;
}

/** The theme hand-off: the preview frame sets data-theme; the product themes by a class on <html>. */
const THEME_SYNC = `
if (typeof document !== "undefined") {
  const root = document.documentElement;
  const sync = () => {
    const theme = root.getAttribute("data-theme");
    if (theme !== "light" && theme !== "dark") return;
    if (!root.classList.contains(theme) || root.classList.contains(theme === "dark" ? "light" : "dark")) {
      root.classList.remove("light", "dark");
      root.classList.add(theme);
    }
    root.style.colorScheme = theme;
  };
  sync();
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
}
`;

export async function buildComponentBundle({ esbuild, frontendDir, entryFile, namespace, componentNames }) {
  const code = await buildScript(esbuild, {
    stdin: {
      contents: `import * as UI from ${JSON.stringify(`./${path.basename(entryFile)}`)};\nwindow.${namespace} = Object.assign(window.${namespace} || {}, UI);\n${THEME_SYNC}`,
      resolveDir: path.dirname(entryFile),
      loader: "tsx",
      sourcefile: "design-system-bundle.tsx",
    },
    tsconfig: path.join(frontendDir, "tsconfig.json"),
    jsx: "automatic",
    loader: { ".svg": "dataurl", ".png": "dataurl" },
    plugins: [
      globalsPlugin({
        react: "window.React",
        "react-dom": "window.ReactDOM",
        "react-dom/client": "window.ReactDOM",
      }),
    ],
  });
  const header = `/* @ds-bundle: ${JSON.stringify({ format: 4, namespace, components: componentNames.map((name) => ({ name })) })} */\n`;
  const out = header + makeInlineSafe(code);
  assertClassicSafe("bundle.js", out);
  return out;
}

/**
 * Compiles src/index.css the way @tailwindcss/vite does in the product build
 * (same input, same automatic source detection over the frontend package),
 * adding the preview documents as a source so their layout classes exist too.
 */
export async function buildProductCss({ tailwindNode, oxide, frontendDir, extraSources }) {
  const indexCss = path.join(frontendDir, "src/index.css");
  const compiler = await tailwindNode.compile(fs.readFileSync(indexCss, "utf8"), {
    base: path.dirname(indexCss),
    onDependency: () => {},
  });
  const roots =
    compiler.root === "none"
      ? []
      : compiler.root === null
        ? [{ base: frontendDir, pattern: "**/*", negated: false }]
        : [{ ...compiler.root, negated: false }];
  const sources = roots
    .concat(compiler.sources)
    .concat(extraSources.map((base) => ({ base, pattern: "**/*.html", negated: false })));
  const scanner = new oxide.Scanner({ sources });
  const candidates = scanner.scan();
  const css = compiler.build(candidates);
  const optimized = tailwindNode.optimize(css, { minify: true }).code;
  if (/<\/style/i.test(optimized)) throw new Error("bundle.css contains </style");
  return { css: optimized, candidates: new Set(candidates) };
}
