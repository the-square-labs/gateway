import { describe, expect, it } from 'vitest';
import { type HostingHttp, HostingProviderError, type HostingRequestOptions } from '../hosting-http.js';
import { type HostingResourceSnapshot, hostingCapabilities } from '../hosting-provider.types.js';
import { CloudBlastApi } from './cloudblast-api.js';
import { CloudBlastBackupsAdapter } from './cloudblast-backups.js';
import { vmSnapshot } from './vm-snapshots.js';

class FakeHostingHttp implements HostingHttp {
  readonly calls: Array<{ path: string; options: HostingRequestOptions }> = [];
  constructor(private readonly handler: (path: string, options: HostingRequestOptions) => unknown) {}
  async request<T>(path: string, options: HostingRequestOptions = {}): Promise<T> {
    this.calls.push({ path, options });
    return this.handler(path, options) as T;
  }
}

const SERVER = '0a1b2c3d-1111-4222-8333-444455556666';
const BACKUP = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const PENDING = 'f47ac10b-58cc-4372-a567-0e02b2c3d480';
const GIB = 1024 ** 3;
const meta = { meta: { current_page: 1, last_page: 1 } };
const vm: HostingResourceSnapshot = {
  remoteId: SERVER,
  kind: 'vm',
  name: 'gateway-web',
  location: '',
  powerState: 'stopped',
  cpu: 2,
  memoryMb: 4096,
  diskGb: 80,
  sizeId: '7',
  addresses: [],
  incarnation: `uuid:${SERVER}`,
  capabilities: hostingCapabilities({ start: true }),
  observedAt: '2026-09-05T08:00:00Z',
};
const backups = [
  {
    uuid: BACKUP,
    name: 'before-upgrade',
    is_successful: true,
    is_locked: false,
    size: 2 * GIB,
    completed_at: '2026-09-05T10:35:00+00:00',
    created_at: '2026-09-05T10:30:00+00:00',
  },
  { uuid: PENDING, name: 'nightly', is_successful: false, size: 0, completed_at: null, created_at: null },
];

function adapter(handler: (path: string, options: HostingRequestOptions) => unknown) {
  const http = new FakeHostingHttp(handler);
  return { http, snapshots: new CloudBlastBackupsAdapter(new CloudBlastApi(http)) };
}

describe('CloudBlastBackupsAdapter', () => {
  it('lists server backups with readiness and the plan backup storage rate', async () => {
    const { snapshots } = adapter((path) => {
      if (path === `/api/v2/servers/${SERVER}/backups`) return { data: backups, ...meta };
      if (path === '/api/v2/plans') return { data: [{ id: 7, backup_price: 0.05 }], ...meta };
      throw new Error(`Unexpected ${path}`);
    });
    const listed = await snapshots.list(vm);
    expect(listed.map((item) => [item.id, item.ready])).toEqual([
      [BACKUP, true],
      [PENDING, false],
    ]);
    expect(listed[0]).toMatchObject({
      name: 'before-upgrade',
      sizeGb: 2,
      createdAt: '2026-09-05T10:30:00+00:00',
      storageRate: { amount: '0.05', currency: 'EUR', unit: 'GB-month', source: 'provider-api' },
      monthlyCost: { amount: '0.10', currency: 'EUR', estimated: true, tax: 'unspecified' },
    });
  });

  it('keeps backups visible without claiming free storage when pricing is unavailable', async () => {
    const { snapshots } = adapter((path) => {
      if (path === '/api/v2/plans') throw new HostingProviderError(500, false, 'down');
      return { data: backups, ...meta };
    });
    const listed = await snapshots.list(vm);
    expect(listed).toHaveLength(2);
    expect(listed[0]).toMatchObject({ storageRate: null, monthlyCost: null });
  });

  it('creates an online snapshot-mode backup and tracks it by its UUID', async () => {
    let listed = [{ ...backups[1], uuid: BACKUP }];
    const { http, snapshots } = adapter((_path, options) =>
      options.method === 'POST' ? { data: { ...backups[1], uuid: BACKUP } } : { data: listed, ...meta }
    );
    await expect(snapshots.create(vm, 'x'.repeat(41))).rejects.toMatchObject({ outcomeUnknown: false });
    expect(http.calls).toHaveLength(0);
    const task = await snapshots.create(vm, 'nightly');
    expect(task).toEqual({ id: `backup:${BACKUP}`, resourceId: SERVER, status: 'running' });
    expect(http.calls[0]).toMatchObject({
      path: `/api/v2/servers/${SERVER}/backups`,
      options: { method: 'POST', body: { name: 'nightly', mode: 'snapshot' } },
    });
    await expect(snapshots.operation(task.id!, vm, 'snapshot_create')).resolves.toMatchObject({ status: 'running' });
    listed = [{ ...backups[0], uuid: BACKUP }];
    await expect(snapshots.operation(task.id!, vm, 'snapshot_create')).resolves.toMatchObject({ status: 'succeeded' });
    listed = [{ ...backups[0], uuid: BACKUP, is_successful: false }];
    await expect(snapshots.operation(task.id!, vm, 'snapshot_create')).resolves.toMatchObject({ status: 'failed' });
    listed = [];
    await expect(snapshots.operation(task.id!, vm, 'snapshot_create')).resolves.toMatchObject({ status: 'failed' });
  });

  it('treats an unreadable create response as uncertain rather than rejected', async () => {
    const { snapshots } = adapter(() => ({ data: { uuid: 'not-a-uuid' } }));
    await expect(snapshots.create(vm, 'nightly')).rejects.toMatchObject({ outcomeUnknown: true });
  });

  it('restores and deletes only validated backup IDs of the same server', async () => {
    let status: string | null = 'restoring_backup';
    const { http, snapshots } = adapter((_path, options) =>
      options.method ? null : { data: { uuid: SERVER, status } }
    );
    const snapshot = vmSnapshot({ id: BACKUP, name: 'before-upgrade', createdAt: null });
    const task = await snapshots.restore(vm, snapshot);
    expect(task).toEqual({ id: `restore:${BACKUP}`, resourceId: SERVER, status: 'running' });
    expect(http.calls[0]).toMatchObject({
      path: `/api/v2/servers/${SERVER}/backups/${BACKUP}/restore`,
      options: { method: 'POST' },
    });
    await expect(snapshots.operation(task.id!, vm, 'snapshot_restore')).resolves.toMatchObject({ status: 'running' });
    status = null;
    await expect(snapshots.operation(task.id!, vm, 'snapshot_restore')).resolves.toMatchObject({
      status: 'succeeded',
    });
    await expect(snapshots.remove(vm, snapshot)).resolves.toEqual({
      id: null,
      resourceId: SERVER,
      status: 'succeeded',
    });
    expect(http.calls.at(-1)).toMatchObject({
      path: `/api/v2/servers/${SERVER}/backups/${BACKUP}`,
      options: { method: 'DELETE' },
    });
    const calls = http.calls.length;
    await expect(snapshots.remove(vm, { ...snapshot, id: '../../servers' })).rejects.toMatchObject({
      providerStatus: 400,
    });
    await expect(snapshots.operation(`backup:${BACKUP}`, vm, 'snapshot_restore')).rejects.toMatchObject({
      outcomeUnknown: true,
    });
    expect(http.calls).toHaveLength(calls);
  });
});
