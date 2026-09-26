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
  ])('rejects unauthorized destination %s before touching it, naming the folders it may use', async (folderId) => {
    // Read-only: the denial may look folder names up for its message, but nothing is written.
    const db = folderDb();
    const denial = assertDockerCreationAccess(
      db as never,
      ['docker:containers:create:folder/f1'],
      'docker:containers:create',
      'n1',
      folderId
    );
    await expect(denial).rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    const message = ((await denial.catch((error: Error) => error)) as Error).message;
    expect(message).toContain(folderId ? `docker:containers:create:folder/${folderId}` : 'at the root (no folder)');
    expect(message).toContain('f1');
    expect(message).toContain('pass folderId');
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
  it.each([
    null,
    undefined,
  ])('drops a stale placement of the name when the resource is created at the root (%s)', async (folderId) => {
    const where = vi.fn().mockResolvedValue(undefined);
    const db = { insert: vi.fn(), delete: vi.fn(() => ({ where })) };
    await placeCreatedDockerResource(db as never, 'n1', 'container', 'app', folderId);
    // A row left by an earlier container named "app" would otherwise pull the new root container into that
    // folder, where the folder's grants (API tokens, MCP grants) could read and manage it.
    expect(db.delete).toHaveBeenCalledOnce();
    expect(where).toHaveBeenCalledOnce();
    expect(db.insert).not.toHaveBeenCalled();
  });
});
