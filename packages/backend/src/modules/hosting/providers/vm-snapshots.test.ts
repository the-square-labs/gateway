import { describe, expect, it, vi } from 'vitest';
import { HostingSettingsSchema } from '../hosting.schemas.js';
import type { HostingResourceSnapshot } from '../hosting-provider.types.js';
import { snapshotStorageCost, VmSnapshotAdapter } from './vm-snapshots.js';

const vm = {
  remoteId: '42',
  location: 'pve',
  kind: 'vm',
  powerState: 'stopped',
  diskGb: 40,
} as HostingResourceSnapshot;
const snap = {
  id: '100',
  name: 'before',
  createdAt: '2026-09-07T12:00:00Z',
  fingerprint: 'a'.repeat(64),
  sizeGb: 2,
  minDiskGb: 20,
  ready: true,
};
function fixture(provider: 'proxmox' | 'digitalocean' | 'hetzner', ...responses: unknown[]) {
  const request = vi.fn();
  if (provider === 'hetzner' && responses[0] && typeof responses[0] === 'object' && 'images' in responses[0])
    request.mockResolvedValueOnce({
      pricing: { currency: 'EUR', image: { price_per_gb_month: { gross: '0.0119000000', net: '0.0100' } } },
    });
  for (const response of responses) request.mockResolvedValueOnce(response);
  return {
    request,
    adapter: new VmSnapshotAdapter(
      { provider, baseUrl: 'https://provider.test', token: 'private', settings: HostingSettingsSchema.parse({}) },
      { request }
    ),
  };
}
describe('VM snapshot provider contracts', () => {
  it.each([true, false, undefined])('maps optional includeRam=%s to Proxmox vmstate', async (includeRam) => {
    const { adapter, request } = fixture('proxmox', { data: 'UPID:pve:task' });
    await adapter.create(
      { ...vm, powerState: 'running' },
      'Memory test',
      'marker',
      includeRam === undefined ? undefined : { includeRam }
    );
    expect(request).toHaveBeenCalledWith('/api2/json/nodes/pve/qemu/42/snapshot', {
      method: 'POST',
      body: { snapname: 'gwmarker', description: 'Memory test', vmstate: includeRam ? 1 : 0 },
    });
  });
  it.each([
    ['running', 1],
    ['stopped', 0],
  ] as const)('requests Proxmox rollback with start=%s mapped to %s', async (powerState, start) => {
    const { adapter, request } = fixture('proxmox', { data: 'UPID:pve:task' });
    await adapter.restore({ ...vm, powerState }, snap);
    expect(request).toHaveBeenCalledExactlyOnceWith('/api2/json/nodes/pve/qemu/42/snapshot/100/rollback', {
      method: 'POST',
      body: { start },
    });
  });
  it('estimates storage from actual snapshot size, including DO minimum charges', () => {
    expect(snapshotStorageCost(20, '0.06', 0.01)).toBe('1.20');
    expect(snapshotStorageCost(0.01, '0.06', 0.01)).toBe('0.01');
    expect(snapshotStorageCost(null, '0.06')).toBeNull();
    expect(snapshotStorageCost(20, 'invalid')).toBeNull();
  });
  it.each(['digitalocean', 'hetzner'] as const)('rejects a foreign %s task even if completed', async (provider) => {
    const task =
      provider === 'digitalocean'
        ? { id: 9, status: 'completed', resource_id: 43, type: 'rebuild' }
        : { id: 9, status: 'success', resources: [{ id: 43, type: 'server' }], command: 'rebuild_server' };
    const { adapter } = fixture(provider, { action: task });
    await expect(adapter.operation('9', vm, 'snapshot_restore')).rejects.toMatchObject({ outcomeUnknown: true });
  });
  it.each(['digitalocean', 'hetzner'] as const)('confirms an owned %s snapshot task', async (provider) => {
    const task =
      provider === 'digitalocean'
        ? { id: 9, status: 'completed', resource_id: 42, type: 'rebuild' }
        : { id: 9, status: 'success', resources: [{ id: 42, type: 'server' }], command: 'rebuild_server' };
    const { adapter } = fixture(provider, { action: task });
    expect(await adapter.operation('9', vm, 'snapshot_restore')).toMatchObject({
      resourceId: '42',
      status: 'succeeded',
    });
  });
  it.each([
    'rebuild',
    'create_image',
    'reboot_server',
  ])('rejects unrelated Hetzner command %s for restore', async (command) => {
    const { adapter } = fixture('hetzner', {
      action: { id: 9, status: 'success', resources: [{ id: 42, type: 'server' }], command },
    });
    await expect(adapter.operation('9', vm, 'snapshot_restore')).rejects.toMatchObject({ outcomeUnknown: true });
  });
  it('requires the Proxmox task VM identity before polling', async () => {
    const { adapter, request } = fixture('proxmox');
    await expect(
      adapter.operation('UPID:pve:0001:0002:0003:qmrollback:43:root@pam:', vm, 'snapshot_restore')
    ).rejects.toMatchObject({ outcomeUnknown: true });
    expect(request).not.toHaveBeenCalled();
  });
  it('lists only snapshots of this DO droplet and does not admit volume or foreign snapshots', async () => {
    const { adapter } = fixture('digitalocean', {
      snapshots: [
        {
          id: '100',
          name: 'before',
          resource_id: '42',
          resource_type: 'droplet',
          created_at: snap.createdAt,
          min_disk_size: 20,
          size_gigabytes: 2,
        },
        { id: '101', resource_id: '43', resource_type: 'droplet' },
        { id: '102', resource_id: '42', resource_type: 'volume' },
      ],
      links: { pages: {} },
    });
    expect(await adapter.list(vm)).toEqual([
      expect.objectContaining({
        id: '100',
        name: 'before',
        minDiskGb: 20,
        monthlyCost: { amount: '0.12', currency: 'USD', tax: 'unspecified', estimated: true },
      }),
    ]);
  });
  it('lists only Hetzner snapshot images created from the same server', async () => {
    const { adapter } = fixture('hetzner', {
      images: [
        {
          id: 100,
          type: 'snapshot',
          description: 'before',
          created_from: { id: 42 },
          created: snap.createdAt,
          status: 'available',
          disk_size: 20,
          image_size: 2,
        },
        { id: 101, type: 'backup', created_from: { id: 42 } },
        { id: 102, type: 'snapshot', created_from: { id: 43 } },
      ],
      meta: { pagination: { next_page: null } },
    });
    expect(await adapter.list(vm)).toEqual([
      expect.objectContaining({
        id: '100',
        name: 'before',
        ready: true,
        monthlyCost: { amount: '0.02', currency: 'EUR', tax: 'gross', estimated: true },
      }),
    ]);
  });
  it('omits the synthetic current Proxmox snapshot', async () => {
    const { adapter } = fixture('proxmox', {
      data: [{ name: 'current' }, { name: 'before', description: 'Before deploy', snaptime: 1000 }],
    });
    expect(await adapter.list(vm)).toEqual([
      expect.objectContaining({ id: 'before', name: 'Before deploy', createdAt: '1970-01-01T00:16:40.000Z' }),
    ]);
  });
  it.each([
    'digitalocean',
    'hetzner',
    'proxmox',
  ] as const)('creates and restores through %s tasks', async (provider) => {
    const response = provider === 'proxmox' ? { data: 'UPID:pve:task' } : { action: { id: 9, status: 'running' } };
    const { adapter, request } = fixture(provider, response, response);
    expect((await adapter.create(vm, 'Before deploy', '11111111-1111-4111-8111-111111111111')).status).toBe('running');
    await adapter.restore(vm, snap);
    const calls = request.mock.calls;
    if (provider === 'proxmox') {
      expect(calls[0][0]).toBe('/api2/json/nodes/pve/qemu/42/snapshot');
      expect(calls[0][1].body).toMatchObject({ vmstate: 0, description: 'Before deploy' });
      expect(calls[1][0]).toBe('/api2/json/nodes/pve/qemu/42/snapshot/100/rollback');
    } else if (provider === 'hetzner') {
      expect(calls[0][1].body).toEqual({ type: 'snapshot', description: 'Before deploy' });
      expect(calls[1]).toEqual(['/v1/servers/42/actions/rebuild', { method: 'POST', body: { image: 100 } }]);
    } else {
      expect(calls[0][1].body).toEqual({ type: 'snapshot', name: 'Before deploy' });
      expect(calls[1][1].body).toEqual({ type: 'rebuild', image: 100 });
    }
  });
  it('never treats malformed mutation receipt as a definite rejection', async () => {
    const { adapter } = fixture('proxmox', {});
    await expect(adapter.create(vm, 'name', 'id')).rejects.toMatchObject({ outcomeUnknown: true });
  });
  it('deletes a snapshot, not the VM', async () => {
    const { adapter, request } = fixture('hetzner', null);
    expect(await adapter.remove(vm, snap)).toEqual({ id: null, status: 'succeeded' });
    expect(request).toHaveBeenCalledWith('/v1/images/100', { method: 'DELETE' });
  });
});
