import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { AvatarStorageService, MAX_AVATAR_UPLOAD_BYTES, resolveAvatarStorageDir } from '@/modules/auth/avatar-storage.service.js';

const roots: string[] = [];

async function createStore() {
  const root = await mkdtemp(join(os.tmpdir(), 'gateway-avatar-test-'));
  roots.push(root);
  const store = new AvatarStorageService(root);
  await store.initialize();
  return { root, store };
}

function pngBytes() {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x00, 0x00, 0x01, 0x49, 0x45, 0x4e, 0x44,
  ]);
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('AvatarStorageService', () => {
  it('uses persistent production storage and temporary development storage', () => {
    expect(resolveAvatarStorageDir('production', '/tmp/runtime')).toBe('/var/lib/gateway/avatars');
    expect(resolveAvatarStorageDir('development', '/tmp/runtime')).toBe('/tmp/runtime/gateway-avatars');
  });

  it('stores, reads, and removes an uploaded image file', async () => {
    const { root, store } = await createStore();
    const source = pngBytes();
    const url = await store.store(new File([source], 'avatar.png', { type: 'image/png' }));
    expect(url).toMatch(/^\/auth\/avatars\/[0-9a-f-]{36}\.png$/);

    const filename = url.split('/').at(-1)!;
    const asset = await store.read(filename);
    expect(asset.mediaType).toBe('image/png');
    expect(asset.bytes).toEqual(source);
    expect(await readFile(join(root, filename))).toEqual(source);

    await store.removeByUrl(url);
    await expect(store.read(filename)).rejects.toMatchObject({ code: 'AVATAR_NOT_FOUND' });
  });

  it('rejects files above the final avatar limit', async () => {
    const { store } = await createStore();
    const bytes = Buffer.concat([pngBytes(), Buffer.alloc(MAX_AVATAR_UPLOAD_BYTES)]);
    await expect(store.store(new File([bytes], 'avatar.png', { type: 'image/png' }))).rejects.toMatchObject({
      code: 'AVATAR_TOO_LARGE',
    });
  });

  it('rejects a declared media type that does not match the contents', async () => {
    const { store } = await createStore();
    await expect(store.store(new File([pngBytes()], 'avatar.jpg', { type: 'image/jpeg' }))).rejects.toMatchObject({
      code: 'AVATAR_MEDIA_TYPE_MISMATCH',
    });
  });

  it('migrates legacy data URLs into file-backed avatar URLs', async () => {
    const { store } = await createStore();
    const legacyUrl = `data:image/png;base64,${pngBytes().toString('base64')}`;
    const set = vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 'user-1' }]) }),
    });
    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ id: 'user-1', avatarUrl: legacyUrl }]),
        }),
      }),
      update: vi.fn().mockReturnValue({ set }),
    } as unknown as DrizzleClient;

    await expect(store.migrateLegacyDataUrls(db)).resolves.toBe(1);
    const nextUrl = set.mock.calls[0]?.[0]?.avatarUrl as string;
    expect(nextUrl).toMatch(/^\/auth\/avatars\/[0-9a-f-]{36}\.png$/);
    await expect(store.read(nextUrl.split('/').at(-1)!)).resolves.toMatchObject({ mediaType: 'image/png' });
  });
});
