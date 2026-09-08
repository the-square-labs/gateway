import { setTimeout as delay } from 'node:timers/promises';
import { HostingProviderError } from '../hosting-http.js';
import type { HostingProviderOperation, HostingResourceSnapshot } from '../hosting-provider.types.js';
import type { HostingSnapshotAction, HostingSnapshotAdapter, HostingVmSnapshot } from '../hosting-snapshot.types.js';
import { vmSnapshot } from './vm-snapshots.js';

type Json = Record<string, unknown>;
type Call = (
  module: string,
  action: string,
  parameters?: Record<string, string | number | boolean | undefined>,
  mutation?: boolean,
  allowNotReady?: boolean
) => Promise<Json>;
const object = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
export class HostkeySnapshotsAdapter implements HostingSnapshotAdapter {
  constructor(private readonly call: Call) {}
  async operation(
    id: string,
    resource: HostingResourceSnapshot,
    action: HostingSnapshotAction
  ): Promise<HostingProviderOperation> {
    const result = await this.call('eq_callback', 'check', { key: id }, false, true);
    if (['Not ready', 'Stage'].includes(String(result.result)))
      return { id, resourceId: resource.remoteId, status: 'running' };
    const context = object(result.context);
    const expected = {
      snapshot_create: 'create_snapshot',
      snapshot_delete: 'remove_snapshot',
      snapshot_restore: 'restore_snapshot',
    }[action];
    if (String(context.id) !== resource.remoteId || context.action !== expected)
      throw new HostingProviderError(
        502,
        true,
        'HOSTKEY snapshot task identity or action did not match the requested VM'
      );
    return {
      id,
      resourceId: String(context.id),
      status:
        result.result === 'OK'
          ? 'succeeded'
          : ['Fail', 'Error', '-1'].includes(String(result.result))
            ? 'failed'
            : 'unknown',
    };
  }
  private async supported(resource: HostingResourceSnapshot) {
    const detail = await this.call('eq', 'show', { id: resource.remoteId });
    const server = object(detail.server_data);
    const model = String(object(detail.ipmi ?? server.ipmi).model ?? '').toLowerCase();
    if (
      !['ovirt', 'openstack'].includes(model) ||
      /^vds/i.test(String(server.type ?? server.ref_tableName ?? '')) ||
      /^vds/i.test(String(server.preset ?? ''))
    )
      throw new HostingProviderError(
        409,
        false,
        'HOSTKEY snapshots require a supported oVirt or OpenStack VM, not VDS'
      );
  }
  private async listing(resource: HostingResourceSnapshot) {
    await this.supported(resource);
    const start = await this.call('vm', 'get_snapshot', { id: resource.remoteId, type: 'snapshot' });
    if (typeof start.callback !== 'string' || !start.callback)
      throw new HostingProviderError(502, false, 'HOSTKEY did not return a snapshot list task');
    for (let attempt = 0; attempt < 20; attempt++) {
      const result = await this.call('eq_callback', 'check', { key: start.callback }, false, true);
      if (result.result === 'OK') {
        const context = object(result.context);
        if (String(context.id) !== resource.remoteId || context.action !== 'get_snapshot')
          throw new HostingProviderError(502, false, 'HOSTKEY snapshot list belongs to a different VM');
        let payload: Json;
        try {
          payload = object(typeof result.scope === 'string' ? JSON.parse(result.scope) : result.scope);
        } catch {
          throw new HostingProviderError(502, false, 'Invalid HOSTKEY snapshot list');
        }
        if (!Array.isArray(payload.snapshots))
          throw new HostingProviderError(502, false, 'Incomplete HOSTKEY snapshot list');
        const rows = payload.snapshots.map((raw) => {
          const row = object(raw);
          const name = row.name;
          if (typeof name !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(name))
            throw new HostingProviderError(502, false, 'Invalid HOSTKEY snapshot name');
          const created = row.date ?? row.created_at;
          const size = Number(row.total_size ?? row.size);
          return {
            ...vmSnapshot({
              id: name,
              name,
              createdAt: typeof created === 'string' ? created : null,
              providerId: typeof row.openstack_image_id === 'string' ? row.openstack_image_id : undefined,
              sizeGb: Number.isFinite(size) ? size / 1024 ** 3 : null,
            }),
            ...(typeof row.openstack_image_id === 'string' ? { providerId: row.openstack_image_id } : {}),
          };
        });
        const settings = { ...object(start.settings), ...object(result.settings) };
        const max = Number(settings.num_max ?? 1);
        return { rows, max: Number.isInteger(max) && max > 0 ? max : 1 };
      }
      if (!['Not ready', 'Stage'].includes(String(result.result)))
        throw new HostingProviderError(502, false, 'HOSTKEY snapshot listing failed');
      await delay(500);
    }
    throw new HostingProviderError(503, false, 'HOSTKEY is still preparing the snapshot list. Refresh shortly');
  }
  async list(resource: HostingResourceSnapshot) {
    return (await this.listing(resource)).rows;
  }
  private async mutate(
    resource: HostingResourceSnapshot,
    action: string,
    name: string,
    providerId?: string
  ): Promise<HostingProviderOperation> {
    const result = await this.call(
      'vm',
      action,
      { id: resource.remoteId, name, type: 'snapshot', ...(providerId ? { openstack_id: providerId } : {}) },
      true
    );
    if (typeof result.callback !== 'string' || !result.callback)
      throw new HostingProviderError(502, true, 'HOSTKEY did not confirm the snapshot task; it will not be repeated');
    return { id: result.callback, status: 'running', resourceId: resource.remoteId };
  }
  async create(resource: HostingResourceSnapshot, name: string) {
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name))
      throw new HostingProviderError(
        400,
        false,
        'HOSTKEY snapshot names may contain only letters, digits, dots, underscores and hyphens'
      );
    const { rows, max } = await this.listing(resource);
    if (rows.length >= max)
      throw new HostingProviderError(
        409,
        false,
        'HOSTKEY snapshot limit reached. Delete an existing snapshot before creating another; automatic rotation is disabled'
      );
    if (rows.some((x) => x.name === name))
      throw new HostingProviderError(409, false, 'A snapshot with this name already exists');
    return this.mutate(resource, 'create_snapshot', name);
  }
  async remove(resource: HostingResourceSnapshot, snapshot: HostingVmSnapshot) {
    await this.supported(resource);
    return this.mutate(resource, 'remove_snapshot', snapshot.name, snapshot.providerId);
  }
  async restore(resource: HostingResourceSnapshot, snapshot: HostingVmSnapshot) {
    await this.supported(resource);
    return this.mutate(resource, 'restore_snapshot', snapshot.name, snapshot.providerId);
  }
}
