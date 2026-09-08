import { createHash } from 'node:crypto';
import { type HostingHttp, HostingProviderError } from '../hosting-http.js';
import type {
  HostingConnection,
  HostingProviderOperation,
  HostingResourceSnapshot,
} from '../hosting-provider.types.js';
import type { HostingSnapshotAction, HostingSnapshotAdapter, HostingVmSnapshot } from '../hosting-snapshot.types.js';

type Json = Record<string, unknown>;
const object = (v: unknown): Json => {
  if (!v || typeof v !== 'object' || Array.isArray(v))
    throw new HostingProviderError(502, false, 'Invalid snapshot response');
  return v as Json;
};
const id = (v: unknown) => {
  if ((typeof v !== 'string' && typeof v !== 'number') || !String(v) || String(v).length > 200)
    throw new HostingProviderError(502, false, 'Invalid snapshot identity');
  return String(v);
};
const number = (v: unknown): number | null =>
  v != null && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
const part = encodeURIComponent;
export function snapshotStorageCost(size: number | null, rate: string, minimum = 0): string | null {
  if (size === null || !Number.isFinite(size) || size < 0 || !/^\d+(?:\.\d+)?$/.test(rate)) return null;
  const amount = size * Number(rate);
  return Number.isFinite(amount) ? Math.max(minimum, amount).toFixed(2) : null;
}
export function vmSnapshot(row: {
  id: string;
  name: string;
  createdAt: string | null;
  sizeGb?: number | null;
  minDiskGb?: number | null;
  ready?: boolean;
  includeRam?: boolean;
  providerId?: string;
}): HostingVmSnapshot {
  return {
    ...row,
    fingerprint: createHash('sha256')
      .update(JSON.stringify([row.id, row.name, row.createdAt, row.providerId ?? null]))
      .digest('hex'),
    sizeGb: row.sizeGb ?? null,
    minDiskGb: row.minDiskGb ?? null,
    ready: row.ready ?? true,
  };
}

/** Provider disk snapshots only. VM/account authorization and dispatch fences belong to the service. */
export class VmSnapshotAdapter implements HostingSnapshotAdapter {
  constructor(
    private readonly connection: HostingConnection,
    private readonly http: HostingHttp
  ) {}
  private base(resource: HostingResourceSnapshot) {
    return `/api2/json/nodes/${part(resource.location)}/${resource.kind === 'ct' ? 'lxc' : 'qemu'}/${part(resource.remoteId)}`;
  }
  async operation(
    taskId: string,
    resource: HostingResourceSnapshot,
    action: HostingSnapshotAction
  ): Promise<HostingProviderOperation> {
    if (this.connection.provider === 'proxmox') {
      const parts = taskId.split(':');
      if (parts[0] !== 'UPID' || parts[1] !== resource.location || parts[6] !== resource.remoteId)
        throw new HostingProviderError(502, true, 'Snapshot task belongs to a different VM');
      const root = object(await this.http.request(`/api2/json/nodes/${part(parts[1])}/tasks/${part(taskId)}/status`));
      const state = object(root.data);
      return {
        id: taskId,
        resourceId: resource.remoteId,
        status:
          state.status === 'running'
            ? 'running'
            : state.status === 'stopped'
              ? state.exitstatus === 'OK'
                ? 'succeeded'
                : 'failed'
              : 'unknown',
      };
    }
    const doProvider = this.connection.provider === 'digitalocean';
    const root = object(await this.http.request(`${doProvider ? '/v2' : '/v1'}/actions/${part(taskId)}`));
    const task = object(root.action);
    const source = doProvider
      ? task.resource_id
      : Array.isArray(task.resources)
        ? task.resources.map(object).find((r) => r.type === 'server')?.id
        : undefined;
    const expected =
      action === 'snapshot_create'
        ? doProvider
          ? 'snapshot'
          : 'create_image'
        : doProvider
          ? 'rebuild'
          : 'rebuild_server';
    if (
      String(task.id) !== taskId ||
      String(source) !== resource.remoteId ||
      (doProvider ? task.type : task.command) !== expected
    )
      throw new HostingProviderError(502, true, 'Snapshot task identity or action did not match the requested VM');
    return {
      id: taskId,
      resourceId: String(source),
      status: ['success', 'completed'].includes(String(task.status))
        ? 'succeeded'
        : ['error', 'errored'].includes(String(task.status))
          ? 'failed'
          : ['running', 'in-progress'].includes(String(task.status))
            ? 'running'
            : 'unknown',
    };
  }
  async list(resource: HostingResourceSnapshot): Promise<HostingVmSnapshot[]> {
    if (this.connection.provider === 'proxmox') {
      const root = object(await this.http.request(`${this.base(resource)}/snapshot`));
      if (!Array.isArray(root.data)) throw new HostingProviderError(502, false, 'Invalid Proxmox snapshot list');
      return root.data
        .map(object)
        .filter((row) => row.name !== 'current')
        .map((row) =>
          vmSnapshot({
            id: id(row.name),
            name: typeof row.description === 'string' && row.description ? row.description : id(row.name),
            createdAt: number(row.snaptime) != null ? new Date(Number(row.snaptime) * 1000).toISOString() : null,
            ready: !row.snapstate,
            includeRam: row.vmstate === 1 || row.vmstate === true,
          })
        );
    }
    const doProvider = this.connection.provider === 'digitalocean';
    if (!doProvider && this.connection.provider !== 'hetzner')
      throw new HostingProviderError(400, false, 'Snapshots are unavailable for this provider');
    const result: HostingVmSnapshot[] = [];
    let storageRate: HostingVmSnapshot['storageRate'] = doProvider
      ? // DigitalOcean publishes one Droplet snapshot rate, not a pricing API.
        // https://docs.digitalocean.com/products/snapshots/details/pricing/ (checked 2026-09-07)
        { amount: '0.06', currency: 'USD', unit: 'GB-month', source: 'published-rate' }
      : null;
    let tax: 'net' | 'gross' | 'unspecified' = 'unspecified';
    if (!doProvider) {
      try {
        const pricing = object(object(await this.http.request('/v1/pricing')).pricing);
        const price = object(object(pricing.image).price_per_gb_month);
        const amount = typeof price.gross === 'string' ? price.gross : price.net;
        if (
          typeof amount === 'string' &&
          /^\d+(?:\.\d+)?$/.test(amount) &&
          typeof pricing.currency === 'string' &&
          /^[A-Z]{3}$/.test(pricing.currency)
        ) {
          storageRate = { amount, currency: pricing.currency, unit: 'GB-month', source: 'provider-api' };
          tax = typeof price.gross === 'string' ? 'gross' : 'net';
        }
      } catch {
        // Billing permissions or a pricing outage must not hide snapshots or claim free storage.
      }
    }
    for (let page = 1; page <= 100; page++) {
      const root = object(
        await this.http.request(doProvider ? '/v2/snapshots' : '/v1/images', {
          query: doProvider
            ? { resource_type: 'droplet', page, per_page: 50 }
            : { type: 'snapshot', page, per_page: 50 },
        })
      );
      const rows = root[doProvider ? 'snapshots' : 'images'];
      if (!Array.isArray(rows)) throw new HostingProviderError(502, false, 'Invalid provider snapshot list');
      for (const value of rows) {
        const row = object(value);
        const source = doProvider ? row.resource_id : (row.created_from as Json | undefined)?.id;
        if (
          String(source) !== resource.remoteId ||
          (doProvider ? row.resource_type !== 'droplet' : row.type !== 'snapshot')
        )
          continue;
        const normalized = vmSnapshot({
          id: id(row.id),
          name:
            typeof row.description === 'string' && row.description
              ? row.description
              : typeof row.name === 'string'
                ? row.name
                : id(row.id),
          createdAt: typeof (row.created_at ?? row.created) === 'string' ? String(row.created_at ?? row.created) : null,
          sizeGb: number(row.size_gigabytes ?? row.image_size),
          minDiskGb: number(row.min_disk_size ?? row.disk_size),
          ready: doProvider || row.status === 'available',
        });
        const amount = storageRate
          ? snapshotStorageCost(normalized.sizeGb, storageRate.amount, doProvider ? 0.01 : 0)
          : null;
        result.push({
          ...normalized,
          storageRate,
          monthlyCost:
            amount !== null && storageRate ? { amount, currency: storageRate.currency, estimated: true, tax } : null,
        });
      }
      const next = doProvider
        ? (root.links as { pages?: { next?: unknown } } | undefined)?.pages?.next
        : (root.meta as { pagination?: { next_page?: unknown } } | undefined)?.pagination?.next_page;
      if (!next && rows.length < 50) return result;
      if (!next && ((doProvider && root.links) || (!doProvider && root.meta))) return result;
    }
    throw new HostingProviderError(502, false, 'Snapshot pagination was incomplete');
  }
  private async mutation(
    path: string,
    body: Json | undefined,
    method: 'POST' | 'DELETE' = 'POST'
  ): Promise<HostingProviderOperation> {
    const response = await this.http.request<unknown>(path, { method, ...(body ? { body } : {}) });
    if (method === 'DELETE' && this.connection.provider !== 'proxmox') return { id: null, status: 'succeeded' };
    try {
      const root = object(response);
      if (this.connection.provider === 'proxmox') return { id: id(root.data), status: 'running' };
      const action = object(root.action);
      const value = id(action.id);
      return {
        id: value,
        status:
          action.status === 'success' || action.status === 'completed'
            ? 'succeeded'
            : action.status === 'error' || action.status === 'errored'
              ? 'failed'
              : 'running',
      };
    } catch {
      throw new HostingProviderError(
        502,
        true,
        'Snapshot mutation response was not confirmed; it will not be repeated'
      );
    }
  }
  create(resource: HostingResourceSnapshot, name: string, marker: string, options?: { includeRam?: boolean }) {
    if (this.connection.provider === 'proxmox')
      return this.mutation(`${this.base(resource)}/snapshot`, {
        snapname: `gw${marker.replaceAll('-', '')}`,
        description: name,
        ...(resource.kind === 'vm' ? { vmstate: options?.includeRam ? 1 : 0 } : {}),
      });
    if (this.connection.provider === 'digitalocean')
      return this.mutation(`/v2/droplets/${part(resource.remoteId)}/actions`, { type: 'snapshot', name });
    return this.mutation(`/v1/servers/${part(resource.remoteId)}/actions/create_image`, {
      type: 'snapshot',
      description: name,
    });
  }
  remove(resource: HostingResourceSnapshot, snapshot: HostingVmSnapshot) {
    if (this.connection.provider === 'proxmox')
      return this.mutation(`${this.base(resource)}/snapshot/${part(snapshot.id)}`, undefined, 'DELETE');
    return this.mutation(
      this.connection.provider === 'digitalocean'
        ? `/v2/snapshots/${part(snapshot.id)}`
        : `/v1/images/${part(snapshot.id)}`,
      undefined,
      'DELETE'
    );
  }
  restore(resource: HostingResourceSnapshot, snapshot: HostingVmSnapshot) {
    if (this.connection.provider === 'proxmox')
      return this.mutation(`${this.base(resource)}/snapshot/${part(snapshot.id)}/rollback`, {
        start: resource.powerState === 'running' ? 1 : 0,
      });
    const image = Number(snapshot.id);
    if (!Number.isSafeInteger(image) || image <= 0)
      throw new HostingProviderError(400, false, 'Invalid snapshot image ID');
    if (this.connection.provider === 'digitalocean')
      return this.mutation(`/v2/droplets/${part(resource.remoteId)}/actions`, { type: 'rebuild', image });
    return this.mutation(`/v1/servers/${part(resource.remoteId)}/actions/rebuild`, { image });
  }
}
