// Copies the Agent Skills from the-square-labs/gateway-skills into skills/,
// which the MCP server serves as gateway://skills so a connected agent reads
// the version matching this Gateway release. Run before tagging a release:
//   node scripts/sync-agent-skills.mjs [path/to/gateway-skills]
import { cpSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const source = join(resolve(process.argv[2] ?? '../gateway-skills'), 'skills');
const target = resolve('skills');
if (!existsSync(source)) {
  console.error(`No skills folder at ${source}`);
  process.exit(1);
}

rmSync(target, { recursive: true, force: true });
const names = readdirSync(source)
  .sort()
  .filter((name) => statSync(join(source, name)).isDirectory() && existsSync(join(source, name, 'SKILL.md')));
for (const name of names) cpSync(join(source, name), join(target, name), { recursive: true });
writeFileSync(
  join(target, 'README.md'),
  '# Agent skills\n\nCopied from [the-square-labs/gateway-skills](https://github.com/the-square-labs/gateway-skills) by `scripts/sync-agent-skills.mjs`; edit them there. The MCP server serves them as `gateway://skills`.\n'
);
console.log(`${names.length} skills copied to ${target}`);
