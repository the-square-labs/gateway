import { describe, expect, it, vi } from 'vitest';
import { findFrozenManagedStorage, storageWritesFrozenError } from './storage-write-freeze.js';

function db(rows: unknown[]) {
  const forShare = vi.fn(async () => rows);
  const where = vi.fn(() => Object.assign(Promise.resolve(rows), { for: forShare }));
  const select = vi.fn(() => ({ from: vi.fn(() => ({ where })) }));
  return { select, forShare };
}

describe('storage write freeze helpers', () => {
  it('looks up only the storages a write touches and reports the frozen one', async () => {
    const none = db([]);
    await expect(findFrozenManagedStorage(none as never, [null, undefined])).resolves.toBeNull();
    expect(none.select).not.toHaveBeenCalled();

    const frozen = db([
      { name: 'other', objectStorageConnectionId: 'connection-2', writesFrozenAt: null },
      { name: 'legacy', objectStorageConnectionId: 'connection-1', writesFrozenAt: new Date() },
    ]);
    await expect(
      findFrozenManagedStorage(frozen as never, ['connection-1', null, 'connection-2', 'connection-1'])
    ).resolves.toEqual({ name: 'legacy', objectStorageConnectionId: 'connection-1' });
    expect(frozen.forShare).not.toHaveBeenCalled();

    // A writer that must not race a freeze waits on the cluster rows.
    await findFrozenManagedStorage(frozen as never, ['connection-2'], { lock: true });
    expect(frozen.forShare).toHaveBeenCalledWith('share');
    const unfrozen = db([{ name: 'other', objectStorageConnectionId: 'connection-2', writesFrozenAt: null }]);
    await expect(findFrozenManagedStorage(unfrozen as never, ['connection-2'])).resolves.toBeNull();
  });

  it('explains the refusal and how to continue', () => {
    expect(storageWritesFrozenError('legacy', 'Backup')).toMatchObject({
      statusCode: 409,
      code: 'STORAGE_WRITES_FROZEN',
      message: expect.stringContaining('Backup refused: writes to managed storage "legacy" are frozen for a migration'),
    });
  });
});
