import { describe, expect, it, vi } from 'vitest';
import {
  assertFolderManage,
  assertFolderManageForFolder,
  assertFolderManageForFolders,
  assertFolderManageForResources,
  type FolderPlacementLookup,
} from './resource-folder-access.js';

const MANAGE = 'domains:folders:manage';
// Team (granted) holds Edge; Other is a top-level folder outside the grant.
const PARENTS = new Map<string, string | null>([
  ['team', null],
  ['edge', 'team'],
  ['other', null],
]);
const RESOURCE_FOLDERS = new Map<string, string | null>([
  ['in-edge', 'edge'],
  ['in-other', 'other'],
  ['ungrouped', null],
]);
// A grant on Team as folder-scopes.ts expands it: Team and its subfolders.
const SCOPED = [`${MANAGE}:folder/team`, `${MANAGE}:folder/edge`];

function lookup(): FolderPlacementLookup & { calls: number } {
  const state = {
    calls: 0,
    getFolderParentIds: vi.fn(async (ids: readonly string[]) => {
      state.calls += 1;
      return new Map(ids.map((id) => [id, PARENTS.get(id) ?? null]));
    }),
    getResourceFolderIds: vi.fn(async (ids: readonly string[]) => {
      state.calls += 1;
      return new Map(ids.map((id) => [id, RESOURCE_FOLDERS.get(id) ?? null]));
    }),
  };
  return state;
}

describe('folder-scoped folder management', () => {
  it('creates inside the granted subtree only', () => {
    expect(() => assertFolderManage(SCOPED, MANAGE, 'team')).not.toThrow();
    expect(() => assertFolderManage(SCOPED, MANAGE, 'edge')).not.toThrow();
    expect(() => assertFolderManage(SCOPED, MANAGE, null)).toThrow(/top-level/);
    expect(() => assertFolderManage(SCOPED, MANAGE, 'other')).toThrow(/Missing domains:folders:manage/);
    expect(() => assertFolderManage([MANAGE], MANAGE, null)).not.toThrow();
  });

  it('renames and deletes subfolders of the granted folder, never the folder itself', async () => {
    await expect(assertFolderManageForFolder(lookup(), SCOPED, MANAGE, 'edge')).resolves.toBeUndefined();
    await expect(assertFolderManageForFolder(lookup(), SCOPED, MANAGE, 'team')).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(assertFolderManageForFolder(lookup(), SCOPED, MANAGE, 'other')).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('reorders only folders whose parent is managed', async () => {
    await expect(assertFolderManageForFolders(lookup(), SCOPED, MANAGE, ['edge'])).resolves.toBeUndefined();
    await expect(assertFolderManageForFolders(lookup(), SCOPED, MANAGE, ['edge', 'team'])).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('moves resources only from and to managed folders', async () => {
    await expect(
      assertFolderManageForResources(lookup(), SCOPED, MANAGE, ['in-edge'], 'team')
    ).resolves.toBeUndefined();
    // Destination outside the grant, or the top level.
    await expect(assertFolderManageForResources(lookup(), SCOPED, MANAGE, ['in-edge'], 'other')).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(assertFolderManageForResources(lookup(), SCOPED, MANAGE, ['in-edge'], null)).rejects.toMatchObject({
      statusCode: 403,
    });
    // Source outside the grant (another folder, or ungrouped).
    await expect(assertFolderManageForResources(lookup(), SCOPED, MANAGE, ['in-other'], 'edge')).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      assertFolderManageForResources(lookup(), SCOPED, MANAGE, ['ungrouped'], undefined)
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      assertFolderManageForResources(lookup(), SCOPED, MANAGE, ['in-edge'], undefined)
    ).resolves.toBeUndefined();
  });

  it('keeps broad folder management unchanged and skips the lookups', async () => {
    const broad = lookup();
    await assertFolderManageForFolder(broad, [MANAGE], MANAGE, 'team');
    await assertFolderManageForFolders(broad, [MANAGE], MANAGE, ['team', 'other']);
    await assertFolderManageForResources(broad, [MANAGE], MANAGE, ['ungrouped'], null);
    expect(broad.calls).toBe(0);
  });
});
