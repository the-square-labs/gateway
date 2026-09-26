// Prints what an exported screen contains: requests the fixtures did not answer
// and the visible text, to check a screen without a browser.
// Usage: node scripts/design-screens/inspect.mjs <screen-id> [--html]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const id = process.argv[2];
if (!id) {
  console.error("usage: node inspect.mjs <screen-id> [--html]");
  process.exit(1);
}
const screen = JSON.parse(fs.readFileSync(path.join(here, "out/dom", `${id}.json`), "utf8"));
console.log(`# ${screen.title} (${screen.route}) ${screen.width}x${screen.height}`);
console.log(`requests: ${screen.requests.length}, unanswered: ${screen.unmocked.length}`);
for (const entry of screen.unmocked) console.log(`  ${entry.status} ${entry.method} ${entry.path}`);
if (process.argv.includes("--html")) {
  console.log(screen.body);
} else {
  const text = screen.body
    .replace(/<svg[\s\S]*?<\/svg>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
  console.log(text);
}
const hidden = (screen.body.match(/visibility:\s*hidden/g) ?? []).length;
const transparent = (screen.body.match(/opacity:\s*0[;"]/g) ?? []).length;
console.log(`\nhidden gates left: ${hidden}, inline opacity:0: ${transparent}`);
