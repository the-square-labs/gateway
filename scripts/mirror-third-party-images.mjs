#!/usr/bin/env node
// Mirrors every digest-pinned third-party runtime image listed in config/third-party-images.json to GHCR so
// installs keep working when an upstream registry withdraws an image (MinIO did). `crane copy` pushes the
// upstream manifest bytes unchanged, so a multi-arch index keeps its digest and every platform.
//
// Idempotent and safe to re-run: an entry whose mirror tag already resolves to the pinned digest is skipped
// without contacting the upstream registry. A mirror tag that resolves to any other digest is an error, never
// overwritten. After each copy the mirror is re-read and its raw manifest hashed against the pin.
//
// Usage: node scripts/mirror-third-party-images.mjs [--validate | --check] [--list <path>]
//   (default)   mirror missing entries and verify them; needs `crane` and registry credentials
//               in ~/.docker/config.json (docker login ghcr.io)
//   --check     read-only: report entries whose mirror is missing or wrong; exit 1 if any
//   --validate  parse and validate the list only; no registry access
// Environment: CRANE (crane binary, default "crane"), MIRROR_REPOSITORY (overrides the list's mirrorRepository).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE_PATTERN =
  /^(?<registry>[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?)\/(?<path>[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@(?<digest>sha256:[0-9a-f]{64})$/;
const NAME_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TAG_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const MIRROR_PATTERN = /^ghcr\.io\/[a-z0-9-]+(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/;
// The override may name any registry (a fork's GHCR namespace, a local test registry).
const OVERRIDE_PATTERN = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*(?::\d+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

function parseArgs(argv) {
  const options = { mode: 'mirror', list: fileURLToPath(new URL('../config/third-party-images.json', import.meta.url)) };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--validate') options.mode = 'validate';
    else if (argv[i] === '--check') options.mode = 'check';
    else if (argv[i] === '--list' && argv[i + 1]) options.list = argv[++i];
    else throw new Error(`Unknown argument: ${argv[i]}`);
  }
  return options;
}

function validateImageList(document) {
  const problems = [];
  if (document?.schemaVersion !== 1) problems.push('schemaVersion must be 1');
  if (typeof document?.mirrorRepository !== 'string' || !MIRROR_PATTERN.test(document.mirrorRepository)) {
    problems.push('mirrorRepository must be a lowercase ghcr.io repository prefix');
  }
  if (!Array.isArray(document?.images) || document.images.length === 0) problems.push('images must be a non-empty array');
  const seenTargets = new Set();
  const seenSources = new Set();
  const images = [];
  for (const [index, entry] of (Array.isArray(document?.images) ? document.images : []).entries()) {
    const label = `images[${index}]`;
    const source = SOURCE_PATTERN.exec(typeof entry?.source === 'string' ? entry.source : '');
    if (!source) {
      problems.push(`${label}.source must be <registry>/<repository>@sha256:<64 hex> with an explicit registry and no tag`);
      continue;
    }
    if (typeof entry.name !== 'string' || !NAME_PATTERN.test(entry.name)) problems.push(`${label}.name is invalid`);
    else if (entry.name !== source.groups.path.split('/').pop()) {
      problems.push(`${label}.name must be the last path segment of the source repository`);
    }
    if (typeof entry.tag !== 'string' || !TAG_PATTERN.test(entry.tag) || entry.tag === 'latest') {
      problems.push(`${label}.tag must be an explicit version tag`);
    }
    if (typeof entry.usedBy !== 'string' || entry.usedBy.trim() === '') problems.push(`${label}.usedBy must say what pulls the image`);
    const target = `${entry.name}:${entry.tag}`;
    if (seenTargets.has(target)) problems.push(`${label} duplicates mirror ${target}`);
    if (seenSources.has(entry.source)) problems.push(`${label} duplicates source ${entry.source}`);
    seenTargets.add(target);
    seenSources.add(entry.source);
    images.push({ name: entry.name, tag: entry.tag, source: entry.source, digest: source.groups.digest });
  }
  if (problems.length > 0) throw new Error(`Invalid third-party image list:\n- ${problems.join('\n- ')}`);
  return { mirrorRepository: document.mirrorRepository, images };
}

function crane(args) {
  const result = spawnSync(process.env.CRANE || 'crane', args, { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  if (result.error) throw result.error;
  return result;
}

function firstLine(buffer) {
  return String(buffer ?? '').trim().split('\n')[0] || 'unknown error';
}

// Hash the raw manifest bytes ourselves instead of trusting a registry-reported digest.
function readManifest(ref) {
  const result = crane(['manifest', ref]);
  if (result.status !== 0) return { error: firstLine(result.stderr) };
  return { bytes: result.stdout, digest: `sha256:${createHash('sha256').update(result.stdout).digest('hex')}` };
}

function verifyMirror(mirror, image) {
  const tagged = readManifest(`${mirror}:${image.tag}`);
  if (tagged.error) throw new Error(`${mirror}:${image.tag} is unreadable after copy: ${tagged.error}`);
  if (tagged.digest !== image.digest) throw new Error(`${mirror}:${image.tag} has digest ${tagged.digest}, pin is ${image.digest}`);
  const pinned = readManifest(`${mirror}@${image.digest}`);
  if (pinned.digest !== image.digest) throw new Error(`${mirror}@${image.digest} is not pullable by digest: ${pinned.error ?? pinned.digest}`);
  // Identical index bytes list identical platforms; also prove every platform manifest was copied.
  const manifest = JSON.parse(tagged.bytes.toString('utf8'));
  if (!Array.isArray(manifest.manifests)) return 0;
  for (const child of manifest.manifests) {
    if (!DIGEST_PATTERN.test(child.digest ?? '')) throw new Error(`${mirror}@${image.digest} lists an invalid child digest`);
    const copied = readManifest(`${mirror}@${child.digest}`);
    if (copied.digest !== child.digest) throw new Error(`${mirror}@${child.digest} (child of ${image.tag}) is missing: ${copied.error ?? copied.digest}`);
  }
  return manifest.manifests.length;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const list = validateImageList(JSON.parse(readFileSync(options.list, 'utf8')));
  const mirrorRepository = process.env.MIRROR_REPOSITORY || list.mirrorRepository;
  if (!OVERRIDE_PATTERN.test(mirrorRepository)) throw new Error(`MIRROR_REPOSITORY is invalid: ${mirrorRepository}`);
  if (options.mode === 'validate') {
    for (const image of list.images) console.log(`${image.source} -> ${mirrorRepository}/${image.name}:${image.tag}`);
    console.log(`${list.images.length} third-party images are digest-pinned`);
    return;
  }
  const failures = [];
  let copied = 0;
  for (const image of list.images) {
    const mirror = `${mirrorRepository}/${image.name}`;
    const target = `${mirror}:${image.tag}`;
    const current = readManifest(target);
    if (current.digest === image.digest) {
      console.log(`ok       ${target} = ${image.digest}`);
      continue;
    }
    if (current.digest) {
      // Mirror tags are immutable: re-pointing one would silently change what existing installs pull.
      failures.push(`${target} points to ${current.digest}, pin is ${image.digest}; add a new tag instead`);
      continue;
    }
    if (options.mode === 'check') {
      failures.push(`${target} is missing (${current.error})`);
      continue;
    }
    console.log(`copy     ${image.source} -> ${target}`);
    const result = spawnSync(process.env.CRANE || 'crane', ['copy', image.source, target], { stdio: ['ignore', 'inherit', 'inherit'] });
    if (result.error || result.status !== 0) {
      failures.push(`copy ${image.source} -> ${target} failed${result.error ? `: ${result.error.message}` : ''}`);
      continue;
    }
    try {
      const children = verifyMirror(mirror, image);
      copied++;
      console.log(`mirrored ${target} = ${image.digest} (${children} child manifests)`);
    } catch (error) {
      failures.push(error.message);
    }
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`::error::${failure}`);
    process.exit(1);
  }
  console.log(`${list.images.length} third-party images mirrored to ${mirrorRepository} (${copied} copied this run)`);
}

try {
  main();
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exit(1);
}
