import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBackupRunnerImage } from './backup-runner-image.js';

const image = `ghcr.io/the-square-labs/gateway/backup-runner@sha256:${'a'.repeat(64)}`;
const directories: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'backup-runner-bundle-'));
  directories.push(dir);
  return pathToFileURL(join(dir, 'backup-runner-image.json'));
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('release-bundled backup runner', () => {
  it.each([undefined, '', '   '])('uses the release default with override %j', (override) => {
    const url = fixture();
    writeFileSync(url, JSON.stringify({ schemaVersion: 1, image }));
    expect(resolveBackupRunnerImage(override, url)).toBe(image);
  });
  it('allows an explicit immutable override, but never silently falls back on a mutable one', () => {
    expect(resolveBackupRunnerImage(image, fixture())).toBe(image);
    expect(() => resolveBackupRunnerImage('runner:latest', fixture())).toThrow('immutable');
  });
  it('permits an unbundled development build and rejects a corrupted bundle', () => {
    const url = fixture();
    expect(resolveBackupRunnerImage(undefined, url)).toBeUndefined();
    writeFileSync(url, JSON.stringify({ schemaVersion: 1, image: 'runner:latest' }));
    expect(() => resolveBackupRunnerImage('', url)).toThrow('Invalid bundled');
  });
  it('creates the release file using the build script and refuses a release without a digest', () => {
    const url = fixture();
    const script = fileURLToPath(new URL('../../../../scripts/bundle-backup-runner.mjs', import.meta.url));
    const run = (version: string, ref: string) =>
      execFileSync(process.execPath, [script, version, ref, fileURLToPath(url)], { stdio: 'pipe' });
    expect(() => run('v2.10.2-rc.3', '')).toThrow();
    expect(() => run('v2.10.2', 'runner:latest')).toThrow();
    run('dev', '');
    run('v2.10.2-rc.3', image);
    expect(resolveBackupRunnerImage('', url)).toBe(image);
  });
  it('publishes and smoke-tests the runner inside the existing Gateway build, before signing', () => {
    const root = new URL('../../../../', import.meta.url);
    const workflow = readFileSync(new URL('.github/workflows/release.yml', root), 'utf8');
    const build = workflow.slice(workflow.indexOf('\n  build:'), workflow.indexOf('\n  sign:'));
    expect(build).toContain('--platform linux/amd64,linux/arm64');
    expect(build).toContain(`--tag "\${GATEWAY_IMAGE}/backup-runner:\${GITHUB_REF_NAME}"`);
    expect(build).toContain(`--build-arg "BACKUP_RUNNER_IMAGE=\${GATEWAY_IMAGE}/backup-runner@\${runner_digest}"`);
    expect(build.indexOf('test-backup-runner-release.mjs')).toBeLessThan(build.indexOf('push-image-with-digest.sh'));
    expect(workflow).not.toContain('refs/tags/backup');
    const runtime = readFileSync(new URL('packages/backend/src/modules/backups/backup-runtime.ts', root), 'utf8');
    expect(runtime).toContain('resolveBackupRunnerImage');
  });
});
