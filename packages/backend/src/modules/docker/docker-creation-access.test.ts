import { describe, expect, it, vi } from 'vitest';
import { assertDockerCreationAccess, placeCreatedDockerResource } from './docker-creation-access.js';

function folderDb(rows: unknown[] = [{ id: 'f1', isSystem: false }]) {
  const limit = vi.fn().mockResolvedValue(rows);
  return { select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit })) })) })) };
}

describe('Docker destination authorization', () => {
  it('accepts an authorized destination without requiring global create', async () => {
    await expect(
      assertDockerCreationAccess(
        folderDb() as never,
        ['docker:containers:create:folder/f1'],
        'docker:containers:create',
        'n1',
        'f1'
      )
    ).resolves.toBeUndefined();
  });
  it.each([
    null,
    undefined,
    'f2',
  ])('rejects unauthorized destination %s before querying or mutating', async (folderId) => {
    const db = folderDb();
    await expect(
      assertDockerCreationAccess(
        db as never,
        ['docker:containers:create:folder/f1'],
        'docker:containers:create',
        'n1',
        folderId
      )
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(db.select).not.toHaveBeenCalled();
  });
  it('refuses a missing or protected folder even for broad creators', async () => {
    for (const rows of [[], [{ id: 'f1', isSystem: true }]]) {
      await expect(
        assertDockerCreationAccess(
          folderDb(rows) as never,
          ['docker:containers:create'],
          'docker:containers:create',
          'n1',
          'f1'
        )
      ).rejects.toMatchObject({ code: 'FOLDER_FORBIDDEN' });
    }
  });
  it('preserves legacy node grants and does not treat a child as creation authority', async () => {
    await expect(
      assertDockerCreationAccess(
        folderDb() as never,
        ['docker:containers:create:n1'],
        'docker:containers:create',
        'n1',
        null
      )
    ).resolves.toBeUndefined();
    await expect(
      assertDockerCreationAccess(
        folderDb() as never,
        ['docker:containers:create:n1/c1'],
        'docker:containers:create',
        'n1',
        null
      )
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
  it('persists authorized placement by canonical resource key', async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    await placeCreatedDockerResource({ insert: vi.fn(() => ({ values })) } as never, 'n1', 'container', 'app', 'f1');
    expect(values).toHaveBeenCalledWith({
      nodeId: 'n1',
      resourceType: 'container',
      resourceKey: 'app',
      folderId: 'f1',
    });
  });
});
