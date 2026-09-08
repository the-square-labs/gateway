import { monthlyVmExpenses } from '../hosting-account-summary.js';
import {
  type HostingHttp,
  HostingHttpClient,
  HostingProviderError,
  type HostingRequestOptions,
} from '../hosting-http.js';
import { hostingOsIdentity } from '../hosting-image-policy.js';
import { hostingLocationLabel } from '../hosting-location.js';
import {
  type HostingAccount,
  type HostingAccountSummary,
  type HostingActionRequest,
  type HostingCapabilities,
  type HostingCapability,
  type HostingCatalog,
  type HostingCatalogOption,
  type HostingConnection,
  type HostingCreateRequest,
  type HostingFinance,
  type HostingInventory,
  type HostingInvoice,
  type HostingMoney,
  type HostingPowerState,
  type HostingProviderAdapter,
  type HostingProviderOperation,
  type HostingResourceSnapshot,
  type HostingTransaction,
  hostingCapabilities,
} from '../hosting-provider.types.js';
import { DigitalOceanFirewallAdapter } from './digitalocean-firewall.js';

const DO_ORIGIN = 'https://api.digitalocean.com';
const PAGE_SIZE = 200;
const MAX_PAGES = 100;
const MARKER_PATTERN = /^gw-[0-9a-f-]{36}$/;
const TOKEN_INFO_PATH = '/v1/oauth/token/info';
const INVENTORY_SCOPES = ['account:read', 'droplet:read'];
const CATALOG_SCOPES = ['regions:read', 'sizes:read', 'image:read'];
const CREATE_SCOPES = [
  'droplet:create',
  'tag:create',
  'droplet:read',
  'tag:read',
  'regions:read',
  'sizes:read',
  'actions:read',
  'image:read',
  'snapshot:read',
  'vpc:read',
];
const UPDATE_SCOPES = ['droplet:update', 'droplet:read', 'actions:read'];

function scopeCapability(scopes: Set<string>, required: string[]): HostingCapability {
  const missing = required.filter(
    (scope) =>
      !(
        scopes.has(scope) ||
        scopes.has('api:write') ||
        scopes.has('write') ||
        (scope.endsWith(':read') && (scopes.has('api:read') || scopes.has('read')))
      )
  );
  return missing.length === 0
    ? { available: true }
    : {
        available: false,
        reasonCode: 'permission_denied',
        reason: `DigitalOcean token is missing required scopes: ${missing.join(', ')}.`,
      };
}

function requireCapability(capability: HostingCapability): void {
  if (!capability.available)
    throw new HostingProviderError(403, false, capability.reason ?? 'DigitalOcean permission denied');
}
type Json = Record<string, unknown>;
type DOAddress = { ip: string; type: string; mac?: string };
type DODroplet = {
  id: string;
  name: string;
  status: string;
  createdAt: string | null;
  region: { slug: string | null; name: string | null } | null;
  size: {
    slug: string | null;
    vcpus: number | null;
    memory: number | null;
    disk: number | null;
    hourly: number | null;
    monthly: number | null;
  } | null;
  sizeId: string | null;
  image: { id: string | null; slug: string | null } | null;
  networks: DOAddress[];
  tags: string[];
};
type DOAction = { id: string; status: string; resourceId: string | null; failed: boolean };

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function unsafe(): never {
  throw new HostingProviderError(502, false, 'Provider returned an unsafe response');
}
function mutationResponse<T>(parse: () => T): T {
  try {
    return parse();
  } catch (error) {
    if (error instanceof HostingProviderError) {
      throw new HostingProviderError(error.providerStatus, true, 'Provider returned an invalid mutation response');
    }
    throw new HostingProviderError(502, true, 'Provider returned an invalid mutation response');
  }
}
function invalid(): never {
  throw new HostingProviderError(400, false, 'Invalid provider request');
}
function record(value: unknown): Json {
  return isRecord(value) ? value : unsafe();
}
function optionalRecord(value: unknown): Json | null {
  return value === undefined || value === null ? null : record(value);
}
function string(value: unknown): string {
  return typeof value === 'string' && value.trim() !== '' ? value : unsafe();
}
function optionalString(value: unknown): string | null {
  return value === undefined || value === null ? null : string(value);
}
function id(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return string(value);
}
function input(value: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : invalid();
}
function text(value: string): string {
  return typeof value === 'string' ? value : invalid();
}
function number(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return unsafe();
}
function values(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : unsafe();
}
function strings(value: unknown): string[] {
  return values(value).map((entry) => string(entry));
}

function nextPage(root: Json, path: string, page: number, collected: number, pageCount: number): number | null {
  const pages = optionalRecord(optionalRecord(root.links)?.pages);
  if (pages && Object.hasOwn(pages, 'next')) {
    const next = pages.next;
    if (next === null) return null;
    if (typeof next !== 'string' || next.trim() === '') return unsafe();
    let url: URL;
    try {
      url = new URL(next, DO_ORIGIN);
    } catch {
      return unsafe();
    }
    const nextPageValue = Number(url.searchParams.get('page'));
    if (url.origin !== DO_ORIGIN || url.pathname !== path || !Number.isSafeInteger(nextPageValue) || nextPageValue < 1)
      return unsafe();
    return nextPageValue;
  }
  const total = number(optionalRecord(root.meta)?.total);
  if (total !== null) return collected < total ? page + 1 : null;
  return pageCount === PAGE_SIZE ? page + 1 : null;
}

function parseAddress(value: unknown): DOAddress {
  const object = record(value);
  const mac = optionalString(object.mac_address);
  return mac
    ? { ip: string(object.ip_address), type: optionalString(object.type) ?? 'unknown', mac }
    : { ip: string(object.ip_address), type: optionalString(object.type) ?? 'unknown' };
}
function parseDroplet(value: unknown): DODroplet {
  const object = record(value);
  const regionObject = optionalRecord(object.region);
  const sizeObject = optionalRecord(object.size);
  const imageObject = optionalRecord(object.image);
  const networksObject = optionalRecord(object.networks);
  return {
    id: id(object.id),
    name: string(object.name),
    status: string(object.status),
    createdAt: optionalString(object.created_at),
    region: regionObject ? { slug: optionalString(regionObject.slug), name: optionalString(regionObject.name) } : null,
    size: sizeObject
      ? {
          slug: optionalString(sizeObject.slug),
          vcpus: number(sizeObject.vcpus),
          memory: number(sizeObject.memory),
          disk: number(sizeObject.disk),
          hourly: number(sizeObject.price_hourly),
          monthly: number(sizeObject.price_monthly),
        }
      : null,
    sizeId: optionalString(object.size_slug) ?? (sizeObject ? optionalString(sizeObject.slug) : null),
    image: imageObject
      ? {
          id: imageObject.id === undefined || imageObject.id === null ? null : id(imageObject.id),
          slug: optionalString(imageObject.slug),
        }
      : null,
    networks: [...values(networksObject?.v4), ...values(networksObject?.v6)].map(parseAddress),
    tags: strings(object.tags),
  };
}
function parseAction(value: unknown): DOAction {
  const object = record(value);
  const status = string(object.status).toLowerCase();
  const resourceId =
    object.resource_id === undefined || object.resource_id === null
      ? object.droplet_id === undefined || object.droplet_id === null
        ? null
        : id(object.droplet_id)
      : id(object.resource_id);
  return {
    id: id(object.id),
    status,
    resourceId,
    failed: status === 'errored' || (object.error !== undefined && object.error !== null),
  };
}
function actionStatus(action: DOAction): HostingProviderOperation['status'] {
  if (action.failed || action.status === 'errored') return 'failed';
  if (action.status === 'completed') return 'succeeded';
  if (action.status === 'in-progress') return 'running';
  return 'unknown';
}
function operation(action: DOAction, resourceId?: string): HostingProviderOperation {
  const result: HostingProviderOperation = { id: action.id, status: actionStatus(action) };
  const resolvedId = resourceId ?? action.resourceId;
  if (resolvedId) result.resourceId = resolvedId;
  if (result.status === 'failed') result.error = 'Provider action failed';
  return result;
}
function powerState(status: string): HostingPowerState {
  if (status === 'active') return 'running';
  if (status === 'off' || status === 'archive') return 'stopped';
  if (status === 'new') return 'starting';
  return 'unknown';
}
function marker(tags: string[]): string | undefined {
  const markers = tags.filter((tag) => MARKER_PATTERN.test(tag));
  if (markers.length > 1) return unsafe();
  return markers[0];
}
function money(value: number, period: 'hour' | 'month'): HostingMoney {
  return { amount: String(value), currency: 'USD', estimated: true, period };
}
function normalize(
  droplet: DODroplet,
  observedAt: string,
  baseUrl: string,
  capabilities: HostingCapabilities
): HostingResourceSnapshot {
  const result: HostingResourceSnapshot = {
    remoteId: droplet.id,
    kind: 'vm',
    name: droplet.name,
    location: droplet.region?.slug ?? droplet.region?.name ?? '',
    powerState: powerState(droplet.status.toLowerCase()),
    cpu: droplet.size?.vcpus ?? null,
    memoryMb: droplet.size?.memory ?? null,
    diskGb: droplet.size?.disk ?? null,
    sizeId: droplet.sizeId ?? undefined,
    imageId: droplet.image?.slug ?? droplet.image?.id ?? undefined,
    addresses: droplet.networks.map((address) => ({
      ip: address.ip,
      mac: address.mac,
      network: address.type,
      direct: true,
    })),
    incarnation: droplet.createdAt,
    marker: marker(droplet.tags),
    providerUrl: new URL(`/v2/droplets/${encodeURIComponent(droplet.id)}`, baseUrl).toString(),
    price:
      droplet.size?.monthly !== null && droplet.size?.monthly !== undefined
        ? money(droplet.size.monthly, 'month')
        : droplet.size?.hourly === null || droplet.size?.hourly === undefined
          ? undefined
          : money(droplet.size.hourly, 'hour'),
    capabilities: { ...capabilities, create: { available: false, reason: 'Provisioning is an account action' } },
    observedAt,
  };
  return result;
}
// Country metadata missing from /regions: official DigitalOcean regional availability.
const REGION_COUNTRIES: Record<string, string> = {
  nyc: 'US',
  sfo: 'US',
  atl: 'US',
  ric: 'US',
  mkc: 'US',
  mem: 'US',
  ams: 'NL',
  sgp: 'SG',
  lon: 'GB',
  fra: 'DE',
  tor: 'CA',
  blr: 'IN',
  syd: 'AU',
};
function parseRegion(value: unknown): HostingCatalogOption {
  const object = record(value);
  const idValue = string(object.slug);
  const country = REGION_COUNTRIES[idValue.replace(/\d+$/, '')];
  const name = optionalString(object.name);
  const city = name && country ? name.replace(/\s+\d+$/, '') : (name ?? undefined);
  return { id: idValue, name: hostingLocationLabel(idValue, city, country) };
}
function parseSize(value: unknown): HostingCatalogOption {
  const object = record(value);
  const result: HostingCatalogOption = {
    id: string(object.slug),
    name: optionalString(object.description) ?? string(object.slug),
    cpu: number(object.vcpus) ?? undefined,
    memoryMb: number(object.memory) ?? undefined,
    diskGb: number(object.disk) ?? undefined,
    locations: strings(object.regions),
  };
  const monthly = number(object.price_monthly);
  const hourly = number(object.price_hourly);
  if (monthly !== null) result.price = money(monthly, 'month');
  else if (hourly !== null) result.price = money(hourly, 'hour');
  return result;
}
/** DO's documented Ubuntu 24.04 GPU builds as of 2026-09-05; pin IDs, not mutable GPU aliases.
 * Source: docs.digitalocean.com/products/droplets/details/images/ and recommended-gpu-setup/.
 */
const GPU_IMAGES: Record<string, { id: number; sizes: RegExp }> = {
  'gpu-h100x1-base': { id: 236925144, sizes: /^gpu-(?:4000ada|6000ada|l40s|h100|h200|b300)x1-/ },
  'gpu-h100x8-base': { id: 241105730, sizes: /^gpu-(?:h100|h200|b300)x8-/ },
  'gpu-amd-base': { id: 240977387, sizes: /^gpu-mi(?:300|325|350|355)x(?:1|8)-/ },
};

function parseImage(value: unknown): HostingCatalogOption {
  const object = record(value);
  const imageId = object.slug === undefined || object.slug === null ? id(object.id) : string(object.slug);
  const name = optionalString(object.name)?.trim();
  const distribution = optionalString(object.distribution)?.trim();
  const label =
    distribution && name && !name.toLowerCase().startsWith(distribution.toLowerCase())
      ? `${distribution} ${name}`
      : name || distribution || imageId;
  const osSlug = /^(ubuntu)-(\d{2})-(\d{2})-x64$/.exec(imageId) ?? /^(debian|fedora)-(\d+)-x64$/.exec(imageId);
  const operatingSystem =
    object.public === true && osSlug && distribution?.toLowerCase() === osSlug[1]
      ? hostingOsIdentity(osSlug[1]!, osSlug[3] ? `${osSlug[2]}.${osSlug[3]}` : osSlug[2]!)
      : undefined;
  const gpu =
    object.public === true && distribution?.toLowerCase() === 'ubuntu' && GPU_IMAGES[imageId]?.id === object.id
      ? GPU_IMAGES[imageId]
      : undefined;
  return {
    id: gpu ? String(gpu.id) : imageId,
    name: label,
    ...(operatingSystem || gpu
      ? {
          operatingSystem: operatingSystem ?? { distribution: 'ubuntu' as const, version: '24.04' },
          architecture: 'x64' as const,
        }
      : {}),
    locations: strings(object.regions),
  };
}
function amount(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string' && value.trim() !== '') return value;
  return unsafe();
}
function amountMoney(value: unknown): HostingMoney | null {
  const normalized = amount(value);
  return normalized === null ? null : { amount: normalized, currency: 'USD', estimated: false };
}
function invoice(value: unknown): HostingInvoice {
  const object = record(value);
  const result: HostingInvoice = {
    id: id(object.invoice_uuid ?? object.invoice_id ?? object.id),
    status: optionalString(object.status) ?? 'unknown',
    total: amountMoney(object.amount ?? object.total ?? object.total_amount),
    date: optionalString(object.date),
  };
  const dueDate = optionalString(object.due_date);
  const url = optionalString(object.invoice_url ?? object.url);
  const resourceId = object.resource_id === undefined || object.resource_id === null ? null : id(object.resource_id);
  if (dueDate) result.dueDate = dueDate;
  if (url) result.url = url;
  if (resourceId) result.resourceIds = [resourceId];
  return result;
}
function transaction(value: unknown, index: number, page: number): HostingTransaction {
  const object = record(value);
  return {
    id:
      object.id === undefined &&
      object.transaction_id === undefined &&
      object.invoice_id === undefined &&
      object.invoice_uuid === undefined
        ? `billing-${page}-${index}`
        : id(object.id ?? object.transaction_id ?? object.invoice_id ?? object.invoice_uuid),
    date: optionalString(object.date),
    description: optionalString(object.description) ?? 'Billing transaction',
    amount: amountMoney(object.amount),
  };
}

export class DigitalOceanHostingAdapter implements HostingProviderAdapter {
  snapshots() {
    return new VmSnapshotAdapter(this.connection, this.http);
  }
  readonly provider = 'digitalocean' as const;
  readonly firewall: DigitalOceanFirewallAdapter;
  private tokenScopes?: Set<string>;
  constructor(
    private readonly connection: HostingConnection,
    private readonly http: HostingHttp = new HostingHttpClient(connection)
  ) {
    this.firewall = new DigitalOceanFirewallAdapter({
      request: this.request.bind(this),
      getResource: this.getResource.bind(this),
      scopes: () => this.scopes(true),
    });
  }
  private async request<T>(path: string, options: HostingRequestOptions = {}): Promise<T> {
    try {
      return await this.http.request<T>(path, options);
    } catch (error) {
      if (error instanceof HostingProviderError) {
        // The HTTP boundary already limits and sanitizes provider error messages.
        throw error;
      }
      throw new HostingProviderError(502, (options.method ?? 'GET') !== 'GET', 'Provider request failed');
    }
  }
  private async scopes(fresh = false): Promise<Set<string>> {
    if (!fresh && this.tokenScopes) return this.tokenScopes;
    const root = record(await this.request<unknown>(TOKEN_INFO_PATH));
    if (
      !Array.isArray(root.scopes) ||
      root.scopes.length > 4096 ||
      root.scopes.some((scope) => typeof scope !== 'string' || !/^[a-z][a-z0-9_:.-]{0,127}$/.test(scope))
    )
      throw new HostingProviderError(
        502,
        false,
        'DigitalOcean returned invalid token scopes; permissions could not be verified'
      );
    this.tokenScopes = new Set(root.scopes as string[]);
    return this.tokenScopes;
  }
  private capabilities(scopes: Set<string>) {
    const capabilities = hostingCapabilities({});
    capabilities.create = scopeCapability(scopes, CREATE_SCOPES);
    for (const action of ['start', 'shutdown', 'reboot'] as const)
      capabilities[action] = scopeCapability(scopes, UPDATE_SCOPES);
    capabilities.resize = scopeCapability(scopes, [...UPDATE_SCOPES, 'droplet:create']);
    capabilities.delete = scopeCapability(scopes, ['droplet:delete', 'droplet:read']);
    capabilities.finance = scopeCapability(scopes, ['billing:read']);
    return capabilities;
  }
  private async canReadFinance(): Promise<boolean> {
    try {
      await this.request<unknown>('/v2/customers/my/balance');
      return true;
    } catch (error) {
      if (error instanceof HostingProviderError && error.providerStatus === 403) return false;
      throw error;
    }
  }
  private async listPage<T>(
    path: string,
    key: string,
    parse: (value: unknown) => T,
    query: HostingRequestOptions['query'] = {}
  ): Promise<T[]> {
    const result: T[] = [];
    let page = 1;
    for (let count = 0; count < MAX_PAGES; count += 1) {
      const root = record(await this.request<unknown>(path, { query: { ...query, page, per_page: PAGE_SIZE } }));
      const pageValues = root[key];
      if (!Array.isArray(pageValues)) return unsafe();
      result.push(...pageValues.map((value) => parse(value)));
      const next = nextPage(root, path, page, result.length, pageValues.length);
      if (next === null) return result;
      if (next <= page) return unsafe();
      page = next;
    }
    throw new HostingProviderError(502, false, 'Provider pagination was incomplete');
  }
  async test(): Promise<HostingAccount> {
    const scopes = await this.scopes(true);
    requireCapability(scopeCapability(scopes, INVENTORY_SCOPES));
    const capabilities = this.capabilities(scopes);
    const account = record(record(await this.request<unknown>('/v2/account')).account);
    if (capabilities.finance.available && !(await this.canReadFinance())) {
      capabilities.finance = {
        available: false,
        reasonCode: 'permission_denied',
        reason: 'DigitalOcean denied billing access. Check the token scopes and team permissions.',
      };
    }
    return {
      authority: string(account.uuid),
      name: optionalString(account.email) ?? optionalString(account.name) ?? 'DigitalOcean',
      capabilities,
    };
  }
  async catalog(): Promise<HostingCatalog> {
    if (!scopeCapability(await this.scopes(), CATALOG_SCOPES).available)
      return { locations: [], sizes: [], images: [] };
    const locations = await this.listPage('/v2/regions', 'regions', parseRegion);
    const sizes = await this.listPage('/v2/sizes', 'sizes', parseSize);
    const images = await this.listPage('/v2/images', 'images', parseImage, { type: 'distribution' });
    return {
      locations,
      sizes,
      images: images.map((image) => {
        const gpu = Object.values(GPU_IMAGES).find(
          (candidate) => String(candidate.id) === image.id && image.operatingSystem
        );
        return gpu
          ? { ...image, compatibleSizes: sizes.filter((size) => gpu.sizes.test(size.id)).map((size) => size.id) }
          : image;
      }),
    };
  }
  async listResources(): Promise<HostingInventory> {
    const capabilities = this.capabilities(await this.scopes());
    const droplets = await this.listPage('/v2/droplets', 'droplets', parseDroplet);
    const observedAt = new Date().toISOString();
    return {
      resources: droplets.map((droplet) => normalize(droplet, observedAt, this.connection.baseUrl, capabilities)),
      complete: true,
      observedAt,
    };
  }
  async getResource(remoteId: string): Promise<HostingResourceSnapshot | null> {
    let root: Json;
    try {
      root = record(await this.request<unknown>(`/v2/droplets/${encodeURIComponent(input(remoteId))}`));
    } catch (error) {
      if (error instanceof HostingProviderError && error.providerStatus === 404) return null;
      throw error;
    }
    return normalize(
      parseDroplet(root.droplet),
      new Date().toISOString(),
      this.connection.baseUrl,
      this.capabilities(await this.scopes())
    );
  }
  async validateCreate(): Promise<void> {
    requireCapability(scopeCapability(await this.scopes(true), CREATE_SCOPES));
  }
  async create(request: HostingCreateRequest): Promise<HostingProviderOperation> {
    await this.validateCreate();
    const image = input(request.image);
    const numericImage = /^\d+$/.test(image) ? Number(image) : null;
    if (numericImage !== null && (!Number.isSafeInteger(numericImage) || numericImage < 1)) return invalid();
    const body = {
      name: input(request.name),
      region: input(request.location),
      size: input(request.size),
      image: numericImage ?? image,
      user_data: text(request.userData),
      tags: [input(request.marker)],
    };
    const payload = await this.request<unknown>('/v2/droplets', { method: 'POST', body });
    return mutationResponse(() => {
      const root = record(payload);
      return { id: null, resourceId: parseDroplet(root.droplet).id, status: 'succeeded' };
    });
  }
  async action(resource: HostingResourceSnapshot, request: HostingActionRequest): Promise<HostingProviderOperation> {
    const resourceId = input(resource.remoteId);
    requireCapability(this.capabilities(await this.scopes(true))[request.action]);
    if (request.action === 'delete') {
      await this.request<unknown>(`/v2/droplets/${encodeURIComponent(resourceId)}`, { method: 'DELETE' });
      return { id: null, resourceId, status: 'succeeded' };
    }
    const body: Record<string, string> = {};
    if (request.action === 'start') body.type = 'power_on';
    else if (request.action === 'shutdown') body.type = 'shutdown';
    else if (request.action === 'reboot') body.type = 'reboot';
    else if (request.action === 'resize') {
      body.type = 'resize';
      body.size = input(request.size ?? resource.sizeId ?? '');
    } else return invalid();
    const payload = await this.request<unknown>(`/v2/droplets/${encodeURIComponent(resourceId)}/actions`, {
      method: 'POST',
      body,
    });
    return mutationResponse(() => operation(parseAction(record(payload).action), resourceId));
  }
  async operation(idValue: string, resourceId?: string): Promise<HostingProviderOperation> {
    const root = record(await this.request<unknown>(`/v2/actions/${encodeURIComponent(input(idValue))}`));
    return operation(parseAction(root.action), resourceId);
  }
  async accountSummary(resources: HostingResourceSnapshot[]): Promise<HostingAccountSummary> {
    let balance = null;
    try {
      const result = record(await this.request<unknown>('/v2/customers/my/balance'));
      balance = amountMoney(result.account_balance);
    } catch {
      // Billing permissions are optional; VM prices remain usable without them.
    }
    return { balance, monthlyExpenses: monthlyVmExpenses(resources, 'USD'), observedAt: new Date().toISOString() };
  }

  async finance(cursor?: string): Promise<HostingFinance> {
    const page = cursor === undefined ? 1 : Number(cursor);
    if (!Number.isSafeInteger(page) || page < 1) return invalid();
    const balance = record(await this.request<unknown>('/v2/customers/my/balance'));
    const invoicesRoot = record(
      await this.request<unknown>('/v2/customers/my/invoices', { query: { page, per_page: PAGE_SIZE } })
    );
    const historyRoot = record(
      await this.request<unknown>('/v2/customers/my/billing_history', { query: { page, per_page: PAGE_SIZE } })
    );
    const invoices = values(invoicesRoot.invoices);
    const history = values(historyRoot.billing_history);
    const invoiceNext = nextPage(invoicesRoot, '/v2/customers/my/invoices', page, invoices.length, invoices.length);
    const historyNext = nextPage(historyRoot, '/v2/customers/my/billing_history', page, history.length, history.length);
    const next = [invoiceNext, historyNext].filter((value): value is number => value !== null).sort((a, b) => a - b)[0];
    const result: HostingFinance = {
      balance: amountMoney(balance.account_balance),
      usage: amountMoney(balance.month_to_date_usage),
      invoices: invoices.map(invoice),
      transactions: history.map((value, index) => transaction(value, index, page)),
      observedAt: new Date().toISOString(),
    };
    if (next !== undefined) result.nextCursor = String(next);
    return result;
  }
  async invoice(idValue: string): Promise<HostingInvoice> {
    const root = record(await this.request<unknown>(`/v2/customers/my/invoices/${encodeURIComponent(input(idValue))}`));
    return invoice(root.invoice);
  }
}

import { VmSnapshotAdapter } from './vm-snapshots.js';
