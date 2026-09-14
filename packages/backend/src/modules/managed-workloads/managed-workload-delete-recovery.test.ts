import { describe, expect, it, vi } from 'vitest';
import { ManagedWorkloadLifecycle } from './managed-workload-lifecycle.js';

const row = { id: 'storage', nodeId: 'node', pendingOperation: { id: 'op', action: 'delete' }, status: 'deleting' };
function setup() {
  const beforeDelete = vi.fn(),
    disposeCanonicalClient = vi.fn(),
    deleteCanonicalConnection = vi.fn(),
    remove = vi.fn();
  const dispatch = {
    beforeDelete,
    disposeCanonicalClient,
    deleteCanonicalConnection,
    auditLifecycle: vi.fn(),
    emit: vi.fn(),
    sendCommand: vi.fn().mockResolvedValue({ success: true, detail: '{}' }),
    parseDaemonState: vi.fn().mockReturnValue({ status: 'missing' }),
  };
  const store = { delete: remove };
  const lifecycle = new ManagedWorkloadLifecycle(store as never, dispatch as never, {} as never);
  return { lifecycle, dispatch, remove };
}
describe('storage deletion recovery', () => {
  it('preserves ownership when cleanup fails even if daemon reports workload missing', async () => {
    const { lifecycle, dispatch, remove } = setup();
    dispatch.beforeDelete.mockRejectedValueOnce(new Error('target offline'));
    await lifecycle.reconcilePendingRow(row as never);
    expect(dispatch.beforeDelete).toHaveBeenCalledWith(row, null);
    expect(remove).not.toHaveBeenCalled();
    expect(dispatch.deleteCanonicalConnection).not.toHaveBeenCalled();
  });
  it('retries cleanup before committing recovered deletion', async () => {
    const { lifecycle, dispatch, remove } = setup();
    await lifecycle.reconcilePendingRow(row as never);
    expect(dispatch.beforeDelete).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledWith('storage');
    expect(dispatch.deleteCanonicalConnection).toHaveBeenCalledWith(row);
  });
});
