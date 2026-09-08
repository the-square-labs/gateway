import { expect, it, vi } from 'vitest';
import type { HostingResourceSnapshot } from '../hosting-provider.types.js';
import { HostkeySnapshotsAdapter } from './hostkey-snapshots.js';

const vm = { remoteId: '42', kind: 'vm', powerState: 'stopped' } as HostingResourceSnapshot;
const supported = { server_data: { id: 42, type: 'VPS' }, ipmi: { model: 'openstack' } };
it.each([
  { id: 43, action: 'restore_snapshot' },
  { id: 42, action: 'create_snapshot' },
])('rejects a foreign HOSTKEY task context %j', async (context) => {
  const call = vi.fn().mockResolvedValue({ result: 'OK', context });
  await expect(new HostkeySnapshotsAdapter(call).operation('task', vm, 'snapshot_restore')).rejects.toMatchObject({
    outcomeUnknown: true,
  });
});
it('decodes the asynchronous HOSTKEY list and preserves its provider snapshot identity', async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce(supported)
    .mockResolvedValueOnce({ result: 'OK', callback: 'list', settings: { num_max: 1 } })
    .mockResolvedValueOnce({
      result: 'OK',
      context: { id: 42, action: 'get_snapshot' },
      scope: JSON.stringify({
        snapshots: [
          { name: 'before', created_at: '2026-09-07', total_size: 1073741824, openstack_image_id: 'image-id' },
        ],
      }),
    });
  const list = await new HostkeySnapshotsAdapter(call).list(vm);
  expect(list).toEqual([expect.objectContaining({ id: 'before', sizeGb: 1, providerId: 'image-id' })]);
  expect(call.mock.calls.every((c) => !c[3])).toBe(true);
});
it('refuses VDS and never rotates away an existing snapshot to make room', async () => {
  const vds = vi.fn().mockResolvedValue({ server_data: { type: 'VDS' }, ipmi: { model: 'ovirt' } });
  await expect(new HostkeySnapshotsAdapter(vds).list(vm)).rejects.toThrow('not VDS');
  const call = vi
    .fn()
    .mockResolvedValueOnce(supported)
    .mockResolvedValueOnce({ callback: 'list' })
    .mockResolvedValueOnce({
      result: 'OK',
      context: { id: 42, action: 'get_snapshot' },
      scope: { snapshots: [{ name: 'old', date: '2026-09-07' }] },
    });
  await expect(new HostkeySnapshotsAdapter(call).create(vm, 'new')).rejects.toThrow('limit');
  expect(call.mock.calls.some((c) => c[3] === true)).toBe(false);
});
it('rejects a callback list belonging to another VM', async () => {
  const call = vi
    .fn()
    .mockResolvedValueOnce(supported)
    .mockResolvedValueOnce({ callback: 'list' })
    .mockResolvedValueOnce({ result: 'OK', context: { id: 43, action: 'get_snapshot' }, scope: { snapshots: [] } });
  await expect(new HostkeySnapshotsAdapter(call).list(vm)).rejects.toThrow('different VM');
});
