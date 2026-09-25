import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const listPath = join(repoRoot, 'config/third-party-images.json');
const mirrorScript = join(repoRoot, 'scripts/mirror-third-party-images.mjs');
const releaseWorkflow = join(repoRoot, '.github/workflows/release.yml');

const SOURCE =
  /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?\/[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[0-9a-f]{64}$/;
const FIRST_PARTY_IMAGES = ['backup-runner', 'relay', 'secure-link-connector'];
// Withdrawn upstream (anonymous pulls are denied), so it can no longer be mirrored; rc.8 replaces it with SeaweedFS.
const UNMIRRORABLE = new Set(['quay.io/minio/minio']);

interface ImageEntry {
  name: string;
  tag: string;
  source: string;
  usedBy: string;
}
const list = JSON.parse(readFileSync(listPath, 'utf8')) as {
  schemaVersion: number;
  mirrorRepository: string;
  images: ImageEntry[];
};

function validate(document: unknown) {
  const dir = mkdtempSync(join(tmpdir(), 'third-party-images-'));
  try {
    const path = join(dir, 'list.json');
    writeFileSync(path, JSON.stringify(document));
    return spawnSync(process.execPath, [mirrorScript, '--validate', '--list', path], { encoding: 'utf8' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('third-party runtime image mirror list', () => {
  it('pins every entry by digest and mirrors it under the Gateway GHCR namespace', () => {
    expect(list.schemaVersion).toBe(1);
    expect(list.mirrorRepository).toBe('ghcr.io/the-square-labs/gateway');
    expect(list.images.length).toBeGreaterThan(0);
    const targets = new Set<string>();
    for (const image of list.images) {
      expect(image.source, image.source).toMatch(SOURCE);
      expect(image.name).toBe(image.source.split('@')[0].split('/').pop());
      expect(FIRST_PARTY_IMAGES).not.toContain(image.name);
      expect(image.tag).toMatch(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
      expect(image.tag).not.toBe('latest');
      expect(image.usedBy.trim()).not.toBe('');
      targets.add(`${image.name}:${image.tag}`);
    }
    expect(targets.size).toBe(list.images.length);
    expect(list.images).toContainEqual(
      expect.objectContaining({
        name: 'seaweedfs',
        tag: '4.47',
        source: 'docker.io/chrislusf/seaweedfs@sha256:ce9e796f1fe6f06968f4c04bdaf8f678dad9c8acdfef3d244133d71bfa6bf882',
      })
    );
  });

  it('covers every digest-pinned third-party image that Gateway or its daemons pull at runtime', () => {
    const pinned = new Set(list.images.map((image) => image.source));
    const missing: string[] = [];
    for (const root of ['packages/daemons', 'packages/backend/src', 'scripts']) {
      for (const file of readdirSync(join(repoRoot, root), { recursive: true }) as string[]) {
        if (
          !/\.(go|ts|mjs|sh|ya?ml)$/.test(file) ||
          /(_test\.go|\.test\.[a-z]+|(^|\/)(testdata|fixtures|node_modules)\/|(^|\/)test-[^/]*$)/.test(file)
        )
          continue;
        const source = readFileSync(join(repoRoot, root, file), 'utf8');
        for (const [, repository, digest] of source.matchAll(
          /([a-z0-9.-]+\.[a-z]+(?::\d+)?\/[a-z0-9._/-]+?)(?::[\w.-]+)?@(sha256:[0-9a-f]{64})/g
        )) {
          if (repository.startsWith('ghcr.io/the-square-labs/') || UNMIRRORABLE.has(repository)) continue;
          if (!pinned.has(`${repository}@${digest}`)) missing.push(`${root}/${file}: ${repository}@${digest}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('is accepted by the mirror script, which rejects tag-only and duplicate entries', () => {
    const accepted = validate(list);
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain(`${list.images.length} third-party images are digest-pinned`);

    const [first] = list.images;
    const tagOnly = validate({ ...list, images: [{ ...first, source: `${first.source.split('@')[0]}:4.47` }] });
    expect(tagOnly.status).toBe(1);
    expect(tagOnly.stderr).toContain('@sha256:<64 hex>');
    const duplicate = validate({ ...list, images: [first, { ...first }] });
    expect(duplicate.status).toBe(1);
    expect(duplicate.stderr).toContain(`duplicates mirror ${first.name}:${first.tag}`);
  });

  it('mirrors with a checksum-pinned crane before the release build needs the images', () => {
    const workflow = readFileSync(releaseWorkflow, 'utf8');
    const mirrorJob = workflow.slice(workflow.indexOf('\n  mirror:\n'), workflow.indexOf('\n  build:\n'));
    const gatewayOnly = 'if: $' + "{{ needs.verify.outputs.release_kind == 'gateway' }}";
    expect(mirrorJob).toContain(gatewayOnly);
    expect(mirrorJob).toMatch(/CRANE_LINUX_AMD64_SHA256: [0-9a-f]{64}\n/);
    expect(mirrorJob).toContain('sha256sum --check --strict');
    expect(mirrorJob).toContain('run: node scripts/mirror-third-party-images.mjs');
    expect(workflow).toContain(`  build:\n    name: Build\n    ${gatewayOnly}\n    needs: [verify, mirror]\n`);
  });
});
