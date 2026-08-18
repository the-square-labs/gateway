import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PageArtifactStore } from './page-artifact-store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('PageArtifactStore', () => {
  it('appends resumable chunks without allowing offset replay or root escape', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-pages-store-'));
    tempDirs.push(root);
    const store = new PageArtifactStore(root);
    await store.initialize();
    const uploadKey = store.uploadKey('11111111-1111-4111-8111-111111111111');

    expect(await store.appendChunk(uploadKey, 0, Buffer.from('hello'))).toBe(5);
    expect(await store.appendChunk(uploadKey, 5, Buffer.from(' world'))).toBe(11);
    await expect(store.appendChunk(uploadKey, 0, Buffer.from('overwrite'))).rejects.toMatchObject({
      code: 'PAGES_UPLOAD_OFFSET_MISMATCH',
    });
    expect(await store.size(uploadKey)).toBe(11);
    expect(await store.sha256(uploadKey)).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
    expect(() => store.resolveKey('../outside')).toThrow('Invalid Pages storage key');
  });

  it('atomically promotes an upload into the canonical Project artifact path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-pages-store-'));
    tempDirs.push(root);
    const store = new PageArtifactStore(root);
    await store.initialize();
    const uploadKey = store.uploadKey('11111111-1111-4111-8111-111111111111');
    const artifactKey = store.artifactKey(
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333'
    );
    await writeFile(store.resolveKey(uploadKey), 'artifact');

    await store.commitUpload(uploadKey, artifactKey);

    expect(await readFile(store.resolveKey(artifactKey), 'utf8')).toBe('artifact');
    expect(await store.size(uploadKey)).toBe(0);
  });

  it('serializes concurrent appends so the same offset cannot win twice', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-pages-store-'));
    tempDirs.push(root);
    const store = new PageArtifactStore(root);
    await store.initialize();
    const uploadKey = store.uploadKey('11111111-1111-4111-8111-111111111111');

    const results = await Promise.allSettled([
      store.appendChunk(uploadKey, 0, Buffer.from('first')),
      store.appendChunk(uploadKey, 0, Buffer.from('second')),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(['first', 'second']).toContain(await readFile(store.resolveKey(uploadKey), 'utf8'));
  });

  it('rolls back only the exact chunk whose database offset was not committed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'gateway-pages-store-'));
    tempDirs.push(root);
    const store = new PageArtifactStore(root);
    await store.initialize();
    const uploadKey = store.uploadKey('11111111-1111-4111-8111-111111111111');
    await store.appendChunk(uploadKey, 0, Buffer.from('first'));
    await store.appendChunk(uploadKey, 5, Buffer.from('second'));

    await store.rollbackChunk(uploadKey, 5, 11);
    await store.appendChunk(uploadKey, 5, Buffer.from('third'));
    await store.rollbackChunk(uploadKey, 0, 5);

    expect(await readFile(store.resolveKey(uploadKey), 'utf8')).toBe('firstthird');
  });
});
