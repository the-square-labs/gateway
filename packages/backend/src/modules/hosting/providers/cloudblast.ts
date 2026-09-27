import { normalizeIp } from '@/lib/ip-cidr.js';
import { AppError } from '@/middleware/error-handler.js';
import { monthlyVmExpenses } from '../hosting-account-summary.js';
import { type HostingHttp, HostingHttpClient, HostingProviderError } from '../hosting-http.js';
import { hostingOsIdentity } from '../hosting-image-policy.js';
import { hostingLocationLabel } from '../hosting-location.js';
import {
  type HostingAccount,
  type HostingAccountSummary,
  type HostingActionRequest,
  type HostingAddress,
  type HostingCapabilities,
  type HostingCatalog,
  type HostingCatalogOption,
  type HostingConnection,
  type HostingFinance,
  type HostingInventory,
  type HostingInvoice,
  type HostingMoney,
  type HostingPowerState,
  type HostingProviderAdapter,
  type HostingProviderOperation,
  type HostingResourceSnapshot,
  hostingCapabilities,
} from '../hosting-provider.types.js';
import {
  bytesTo,
  CLOUDBLAST_API_PREFIX,
  CLOUDBLAST_CURRENCY,
  CloudBlastApi,
  id,
  input,
  invalid,
  type Json,
  mutationResponse,
  number,
  optionalRecord,
  optionalString,
  record,
  string,
  unsafe,
  uuid,
  values,
} from './cloudblast-api.js';
import { CloudBlastBackupsAdapter } from './cloudblast-backups.js';
import { CloudBlastFirewallAdapter } from './cloudblast-firewall.js';

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const POWER_PREFIX = 'power:';
/** Gateway installs roles through user data; CloudBlast's create API accepts no user data or cloud-init input. */
export const CLOUDBLAST_CREATE_UNSUPPORTED =
  'CloudBlast cannot pass the Gateway installer to a new server: its API has no user data or cloud-init input. Create the server in CloudBlast, then install Gateway on it over a trusted SSH connection.';
const RESIZE_UNSUPPORTED = 'CloudBlast does not expose plan changes through its API';
const POWER_ACTIONS = { start: 'start', shutdown: 'shutdown', reboot: 'restart' } as const;

type CbServer = {
  uuid: string;
  name: string;
  status: string | null;
  cpu: number | null;
  memoryMb: number | null;
  diskGb: number | null;
  location: string;
  addresses: HostingAddress[];
  plan: { id: string; price: HostingMoney | null } | null;
};
type CbStatus = { state: string | null; task: Json | null; serverStatus: string | null };
type CbLocation = { id: string; label: string };
type CbPlan = HostingCatalogOption & { available: boolean };

function amount(value: unknown): HostingMoney | null {
  const parsed = number(value);
  return parsed === null ? null : { amount: String(parsed), currency: CLOUDBLAST_CURRENCY, estimated: false };
}
function price(value: unknown, period: 'hour' | 'month'): HostingMoney | null {
  const parsed = amount(value);
  return parsed && Number(parsed.amount) >= 0 ? { ...parsed, estimated: true, period } : null;
}
function planPrice(object: Json): HostingMoney | null {
  return price(object.monthly_price, 'month') ?? price(object.hourly_price, 'hour');
}
function capabilities(finance: boolean): HostingCapabilities {
  const result = hostingCapabilities({ start: true, shutdown: true, reboot: true, delete: true, finance });
  result.create = { available: false, reasonCode: 'unsupported', reason: CLOUDBLAST_CREATE_UNSUPPORTED };
  result.resize = { available: false, reasonCode: 'unsupported', reason: RESIZE_UNSUPPORTED };
  return result;
}
function parseAddress(value: unknown): HostingAddress {
  const object = record(value);
  const ip = normalizeIp(string(object.address));
  return ip ? { ip, network: 'public', direct: true } : unsafe();
}
function locationOf(object: Json): string {
  const location = optionalRecord(object.location);
  if (location && location.id !== undefined && location.id !== null) return id(location.id);
  return object.location_id === undefined || object.location_id === null ? '' : id(object.location_id);
}
function parseServer(value: unknown): CbServer {
  const object = record(value);
  const serverUuid = uuid(object.uuid);
  const plan = optionalRecord(object.plan);
  return {
    uuid: serverUuid,
    name: optionalString(object.name) ?? optionalString(object.hostname) ?? serverUuid,
    status: optionalString(object.status),
    cpu: number(object.cpu),
    memoryMb: bytesTo(object.memory, MIB),
    diskGb: bytesTo(object.disk, GIB),
    location: locationOf(object),
    addresses: values(object.ip_addresses).map(parseAddress),
    plan: plan ? { id: id(plan.id), price: planPrice(plan) } : null,
  };
}
function parseStatus(value: unknown): CbStatus {
  const object = record(value);
  return {
    state: optionalString(object.state)?.toLowerCase() ?? null,
    task: optionalRecord(object.power_task),
    serverStatus: optionalString(object.server_status),
  };
}
function powerState(status: CbStatus): HostingPowerState {
  if (status.serverStatus === 'deleting') return 'stopping';
  if (status.task?.status === 'pending') {
    const transition = `${optionalString(status.task.action) ?? ''} ${optionalString(status.task.state) ?? ''}`;
    if (/shut|stop|kill|suspend/i.test(transition)) return 'stopping';
    if (/start|boot|reset|resume/i.test(transition)) return 'starting';
  }
  if (status.state === 'running') return 'running';
  if (status.state === 'stopped') return 'stopped';
  return 'unknown';
}
function parseLocation(value: unknown): CbLocation {
  const object = record(value);
  const locationId = id(object.id);
  const code = optionalString(object.short_code) ?? locationId;
  return { id: locationId, label: hostingLocationLabel(code, optionalString(object.description) ?? undefined) };
}
function parsePlan(value: unknown): CbPlan {
  const object = record(value);
  const price = planPrice(object);
  return {
    id: id(object.id),
    name: string(object.name),
    cpu: number(object.cpu) ?? undefined,
    memoryMb: bytesTo(object.memory, MIB) ?? undefined,
    diskGb: bytesTo(object.disk, GIB) ?? undefined,
    ...(price ? { price } : {}),
    // Only listed with location_id; stock can run out between catalog refreshes.
    available: object.available !== false,
  };
}
function parseTemplate(value: unknown): HostingCatalogOption {
  const object = record(value);
  const name = optionalString(object.name) ?? string(object.slug);
  const identity = /^(ubuntu|debian|fedora)\s+(\d+(?:\.\d+)?)(?:\s+lts)?$/i.exec(name.trim());
  const operatingSystem = identity ? hostingOsIdentity(identity[1]!, identity[2]!) : undefined;
  // Templates carry no architecture metadata, so the admission policy keeps them closed.
  return { id: string(object.slug), name, ...(operatingSystem ? { operatingSystem } : {}) };
}
function parseInvoice(value: unknown): HostingInvoice {
  const object = record(value);
  return {
    id: id(object.id),
    status: optionalString(object.status)?.toLowerCase() ?? 'unknown',
    total: amount(object.total),
    date: optionalString(object.created_at),
  };
}
function unsupported(): never {
  throw new AppError(409, 'HOSTING_ACTION_UNSUPPORTED', 'This operation is not available through the CloudBlast API');
}

export class CloudBlastHostingAdapter implements HostingProviderAdapter {
  readonly provider = 'cloudblast' as const;
  readonly firewall: CloudBlastFirewallAdapter;
  private readonly api: CloudBlastApi;
  constructor(
    private readonly connection: HostingConnection,
    http: HostingHttp = new HostingHttpClient(connection)
  ) {
    this.api = new CloudBlastApi(http);
    this.firewall = new CloudBlastFirewallAdapter(this.api, (remoteId) => this.getResource(remoteId));
  }
  snapshots() {
    return new CloudBlastBackupsAdapter(this.api);
  }

  async test(): Promise<HostingAccount> {
    const account = record(await this.api.data('/account'));
    const inventory = record(await this.api.request('/servers', { query: { page: 1 } }));
    if (!Array.isArray(inventory.data)) return unsafe();
    const holder = [optionalString(account.name), optionalString(account.surname)].filter(Boolean).join(' ');
    return {
      // The numeric account ID survives token rotation; never derive ownership from the token.
      authority: `cloudblast:${id(account.id)}`,
      name: optionalString(account.email) ?? (holder || 'CloudBlast'),
      capabilities: capabilities(number(account.credit) !== null),
    };
  }

  async catalog(): Promise<HostingCatalog> {
    const locations = await this.api.array('/locations', parseLocation);
    const sizes = new Map<string, HostingCatalogOption & { locations: string[] }>();
    const images = new Map<string, HostingCatalogOption & { locations: string[] }>();
    for (const location of locations) {
      const plans = await this.api.pages('/plans', parsePlan, { location_id: Number(location.id) });
      for (const { available, ...plan } of plans) {
        if (!available) continue;
        const size = sizes.get(plan.id) ?? { ...plan, locations: [], locationPrices: {} };
        size.locations.push(location.id);
        if (plan.price) size.locationPrices![location.id] = plan.price;
        sizes.set(plan.id, size);
      }
      const templates = await this.api.array(`/locations/${encodeURIComponent(location.id)}/templates`, parseTemplate);
      for (const template of templates) {
        const image = images.get(template.id) ?? { ...template, locations: [] };
        image.locations.push(location.id);
        images.set(template.id, image);
      }
    }
    return {
      locations: locations.map((location) => ({ id: location.id, name: location.label })),
      sizes: [...sizes.values()],
      images: [...images.values()],
    };
  }

  private async status(remoteId: string): Promise<CbStatus> {
    return parseStatus(await this.api.data(`${this.api.server(remoteId)}/status`));
  }

  private normalize(server: CbServer, status: CbStatus): HostingResourceSnapshot {
    return {
      remoteId: server.uuid,
      kind: 'vm',
      name: server.name,
      location: server.location,
      powerState: powerState(status),
      cpu: server.cpu,
      memoryMb: server.memoryMb,
      diskGb: server.diskGb,
      sizeId: server.plan?.id,
      addresses: server.addresses,
      incarnation: `uuid:${server.uuid}`,
      providerUrl: new URL(
        `${CLOUDBLAST_API_PREFIX}/servers/${encodeURIComponent(server.uuid)}`,
        this.connection.baseUrl
      ).toString(),
      ...(server.plan?.price ? { price: server.plan.price } : {}),
      capabilities: capabilities(false),
      observedAt: new Date().toISOString(),
    };
  }

  /** Details carry the plan price; only whitelisted fields are parsed (never the root password). */
  private async server(remoteId: string): Promise<HostingResourceSnapshot> {
    const server = parseServer(await this.api.data(this.api.server(remoteId)));
    if (server.uuid !== remoteId.toLowerCase()) return unsafe();
    return this.normalize(server, await this.status(server.uuid));
  }

  async listResources(): Promise<HostingInventory> {
    const servers = await this.api.pages('/servers', parseServer);
    const resources: HostingResourceSnapshot[] = [];
    for (const server of servers) resources.push(await this.server(server.uuid));
    return { resources, complete: true, observedAt: new Date().toISOString() };
  }

  async getResource(remoteId: string): Promise<HostingResourceSnapshot | null> {
    try {
      return await this.server(input(remoteId));
    } catch (error) {
      if (error instanceof HostingProviderError && !error.outcomeUnknown && error.providerStatus === 404) return null;
      throw error;
    }
  }

  /** Rejected before any node reservation or dispatch; see CLOUDBLAST_CREATE_UNSUPPORTED. */
  async validateCreate(): Promise<void> {
    throw new AppError(409, 'HOSTING_ACTION_UNSUPPORTED', CLOUDBLAST_CREATE_UNSUPPORTED);
  }

  async create(): Promise<HostingProviderOperation> {
    throw new AppError(409, 'HOSTING_ACTION_UNSUPPORTED', CLOUDBLAST_CREATE_UNSUPPORTED);
  }

  async action(resource: HostingResourceSnapshot, request: HostingActionRequest): Promise<HostingProviderOperation> {
    const resourceId = input(resource.remoteId);
    if (request.action === 'delete') {
      // Without keep_ips CloudBlast keeps only addresses that were already reserved.
      await this.api.request(this.api.server(resourceId), { method: 'DELETE' });
      return { id: null, resourceId, status: 'succeeded' };
    }
    if (request.action === 'resize' || request.action === 'recover') return unsupported();
    const action = POWER_ACTIONS[request.action];
    if (!action) return invalid();
    const payload = await this.api.request(`${this.api.server(resourceId)}/actions`, {
      method: 'POST',
      body: { action },
    });
    return mutationResponse(() => {
      const task = optionalRecord(record(record(payload).data).task);
      if (task?.status === 'failed')
        return { id: null, resourceId, status: 'failed', error: 'CloudBlast rejected the power action' };
      const upid = task ? (optionalString(task.upid) ?? '') : '';
      return { id: `${POWER_PREFIX}${action}:${upid}`, resourceId, status: 'running' };
    });
  }

  /** Power tasks are polled through the real-time status of the same server; never re-sent. */
  async operation(operationId: string, resourceId?: string): Promise<HostingProviderOperation> {
    const match = /^power:(start|shutdown|restart):(.*)$/.exec(operationId);
    if (!match || !resourceId) return invalid();
    const [, action, upid] = match;
    const status = await this.status(resourceId);
    const task = status.task;
    const result = { id: operationId, resourceId };
    if (task) {
      const sameTask = upid ? optionalString(task.upid) === upid : optionalString(task.action) === action;
      if (!sameTask) return { ...result, status: 'unknown' };
      if (task.status === 'pending') return { ...result, status: 'running' };
      if (task.status === 'failed')
        return { ...result, status: 'failed', error: 'CloudBlast reported that the power action failed' };
      return { ...result, status: 'unknown' };
    }
    const expected = action === 'shutdown' ? 'stopped' : 'running';
    return { ...result, status: status.state === expected ? 'succeeded' : 'unknown' };
  }

  async accountSummary(resources: HostingResourceSnapshot[]): Promise<HostingAccountSummary> {
    let balance: HostingMoney | null = null;
    try {
      balance = amount(record(await this.api.data('/account')).credit);
    } catch {
      // Monthly VM prices remain useful when the account endpoint is briefly unavailable.
    }
    return {
      balance,
      monthlyExpenses: monthlyVmExpenses(resources, CLOUDBLAST_CURRENCY),
      observedAt: new Date().toISOString(),
    };
  }

  async finance(cursor?: string): Promise<HostingFinance> {
    const page = cursor === undefined ? 1 : Number(cursor);
    if (!Number.isSafeInteger(page) || page < 1) return invalid();
    const account = record(await this.api.data('/account'));
    const root = record(await this.api.request('/account/invoices', { query: { page } }));
    const meta = record(root.meta);
    const last = number(meta.last_page);
    const result: HostingFinance = {
      balance: amount(account.credit),
      // Account usage reports allocated resources, not money.
      usage: null,
      invoices: values(root.data).map(parseInvoice),
      transactions: [],
      observedAt: new Date().toISOString(),
    };
    if (last !== null && page < last) result.nextCursor = String(page + 1);
    return result;
  }
}
