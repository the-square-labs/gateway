#!/usr/bin/env node
// Static check of the frontend UI rules (scripts/ui-rules/rules.mjs) over src/**/*.tsx.
// Usage: node scripts/ui-rules/check.mjs [--list]
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { ALLOWLIST } from "./allowlist.mjs";
import { RULES } from "./rules.mjs";

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const sourceRoot = join(frontendRoot, "src");

if (process.argv.includes("--list")) {
  for (const rule of RULES) console.log(`${rule.id}: ${rule.description} (from ${rule.source})`);
  process.exit(0);
}

function collectTsx(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return collectTsx(path);
    return entry.name.endsWith(".tsx") && !entry.name.includes(".test.") ? [path] : [];
  });
}

const allowed = new Map(ALLOWLIST.map((entry) => [`${entry.rule} ${entry.file}`, entry]));
const usedAllowances = new Set();
const violations = [];

for (const path of collectTsx(sourceRoot)) {
  const file = relative(frontendRoot, path);
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  for (const rule of RULES) {
    const key = `${rule.id} ${file}`;
    const report = (node, message) => {
      if (allowed.has(key)) {
        usedAllowances.add(key);
        return;
      }
      const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
      violations.push(`${file}:${line + 1}:${character + 1} ${rule.id}: ${message}`);
    };
    const visit = (node) => {
      rule.visit(node, report, source);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
}

for (const [key, entry] of allowed) {
  if (!usedAllowances.has(key)) {
    violations.push(
      `${entry.file} ${entry.rule}: allowlist entry no longer matches; remove it from scripts/ui-rules/allowlist.mjs`
    );
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  console.error(
    `\n${violations.length} UI rule violation(s). Rules: node scripts/ui-rules/check.mjs --list`
  );
  process.exit(1);
}
console.log(`UI rules: ${RULES.length} rules passed.`);
