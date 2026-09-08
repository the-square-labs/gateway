import { createHash, timingSafeEqual } from 'node:crypto';
import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import { hostingOperations, hostingResources, integrationConnectors } from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { AuthService } from '@/modules/auth/auth.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import {
  type CreateHostingConnectorInput,
  type DiscoverHostingConnectorInput,
  HostingSettingsSchema,
  type UpdateHostingConnectorInput,
} from './hosting.schemas.js';
import { lockHostingFirewalls } from './hosting-firewall-lock.js';
import { assertHostingAdoptionAuthority, assertHostingScope } from './hosting-permissions.js';
import {
  HOSTING_PROVIDERS,
  type HostingAccount,
  type HostingConnection,
  type HostingProviderAdapter,
  type HostingSettings,
  isHostingProvider,
} from './hosting-provider.types.js';
import { parseIpv4Range, parseVmidRange } from './proxmox-pool.js';

export type HostingAdapterFactory = (connection: HostingConnection) => HostingProviderAdapter;
export type HostingConnectorRow = typeof integrationConnectors.$inferSelect;
export interface StoredHostingSettings extends HostingSettings {
  authority: string;
  /** CA-derived domain used only for cross-connector allocation serialization. Never exposed to clients. */
  proxmoxAllocationAuthority?: string;
  ownerId: string;
  accountName: string;
}

function normalizedSettings(settings: HostingSettings, provider?: string): HostingSettings {
  const resourceIds =
    provider === 'proxmox' && settings.resourceIds.length
      ? parseVmidRange(settings.resourceIds.join(',')).ids.map(String)
      : settings.resourceIds;
  const profile = settings.proxmox;
  if (!profile?.ipRange || profile.network !== 'static' || !profile.subnet || !profile.gateway)
    return resourceIds === settings.resourceIds ? settings : { ...settings, resourceIds };
  return {
    ...settings,
    resourceIds,
    proxmox: { ...profile, ipRange: parseIpv4Range(profile.ipRange, profile.subnet, profile.gateway).normalized },
  };
}

function legacyProxmoxAuthority(settings: StoredHostingSettings): boolean {
  return !!settings.clusterId && settings.authority === `proxmox:${settings.clusterId}`;
}

function allocationAuthority(settings: StoredHostingSettings, account: HostingAccount): string {
  return settings.proxmoxAllocationAuthority ?? account.authority;
}

function discoverySettings(
  stored: HostingSettings,
  input: DiscoverHostingConnectorInput['settings'],
  tlsMode: DiscoverHostingConnectorInput['tlsMode']
): HostingSettings {
  const merged = { ...stored, ...input };
  if (tlsMode === 'system') {
    const { caCertificate: _ca, certificateFingerprint: _pin, ...settings } = merged;
    return HostingSettingsSchema.parse(settings);
  }
  if (tlsMode === 'ca') {
    const { certificateFingerprint: _pin, ...settings } = merged;
    return HostingSettingsSchema.parse(settings);
  }
  if (tlsMode === 'pin') {
    const { caCertificate: _ca, ...settings } = merged;
    return HostingSettingsSchema.parse(settings);
  }
  return HostingSettingsSchema.parse(merged);
}

function sameDiscoveryTrust(left: HostingSettings, right: HostingSettings): boolean {
  return (
    left.tokenId === right.tokenId &&
    left.caCertificate === right.caCertificate &&
    left.certificateFingerprint === right.certificateFingerprint
  );
}

/** Reuses existing connector credentials and audit without exposing secrets in projections. */
export class HostingConnectorsService {
  private initializeInventory?: (id: string) => Promise<unknown>;
  private invalidateSnapshot?: (id: string, resourceIds?: string[]) => Promise<unknown>;

  setInventoryLifecycle(
    initialize: (id: string) => Promise<unknown>,
    invalidate: (id: string, resourceIds?: string[]) => Promise<unknown>
  ) {
    this.initializeInventory = initialize;
    this.invalidateSnapshot = invalidate;
  }

  async revokeFinance(connector: HostingConnectorRow) {
    await this.db
      .update(integrationConnectors)
      .set({ capabilities: { ...connector.capabilities, finance: false, topup: false } })
      .where(and(eq(integrationConnectors.id, connector.id), eq(integrationConnectors.updatedAt, connector.updatedAt)));
    this.changed(connector.id);
  }
  constructor(
    readonly db: DrizzleClient,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly events: EventBusService,
    private readonly auth: Pick<AuthService, 'getUserById'>,
    private readonly adapters: HostingAdapterFactory
  ) {}

  settings(row: HostingConnectorRow): StoredHostingSettings {
    if (!isHostingProvider(row.provider) || !('kind' in row.settings) || row.settings.kind !== 'hosting') {
      throw new AppError(404, 'HOSTING_CONNECTOR_NOT_FOUND', 'Hosting integration not found');
    }
    const settings = row.settings as StoredHostingSettings;
    if (!settings.ownerId || !settings.authority)
      throw new AppError(409, 'HOSTING_CONNECTOR_INVALID', 'Hosting integration must be reconfigured');
    return settings;
  }

  safe(row: HostingConnectorRow) {
    const settings = this.settings(row);
    // Internal automation authority and trust material stay server-side. CA/pin are exposed only in configuration().
    const {
      ownerId: _owner,
      authority: _authority,
      proxmoxAllocationAuthority: _allocation,
      caCertificate,
      certificateFingerprint,
      ...publicSettings
    } = settings;
    return {
      id: row.id,
      provider: row.provider,
      name: row.name,
      baseUrl: row.baseUrl,
      enabled: row.enabled,
      tokenLast4: row.tokenLast4,
      settings: publicSettings,
      hasCustomCa: !!caCertificate,
      certificateFingerprint: certificateFingerprint ?? null,
      capabilities: row.capabilities,
      syncStatus: row.syncStatus,
      syncLastError: row.syncLastError,
      testedAt: row.testedAt,
      syncedAt: row.syncFinishedAt,
      createdAt: row.createdAt,
    };
  }

  async get(id: string, user?: User, requireEnabled = false): Promise<HostingConnectorRow> {
    if (user) assertHostingScope(user.scopes, 'integrations:hosting:view', id);
    const [row] = await this.db
      .select()
      .from(integrationConnectors)
      .where(and(eq(integrationConnectors.id, id), inArray(integrationConnectors.provider, [...HOSTING_PROVIDERS])))
      .limit(1);
    if (!row) throw new AppError(404, 'HOSTING_CONNECTOR_NOT_FOUND', 'Hosting integration not found');
    this.settings(row);
    if (requireEnabled && !row.enabled)
      throw new AppError(409, 'HOSTING_CONNECTOR_DISABLED', 'Hosting integration is disabled');
    return row;
  }

  async configuration(id: string, user: User) {
    assertHostingScope(user.scopes, 'integrations:hosting:manage', id);
    const row = await this.get(id, user);
    const {
      ownerId: _owner,
      authority: _authority,
      proxmoxAllocationAuthority: _allocation,
      accountName: _account,
      ...settings
    } = this.settings(row);
    return { ...this.safe(row), settings };
  }

  async list(user: User) {
    const rows = await this.db
      .select()
      .from(integrationConnectors)
      .where(inArray(integrationConnectors.provider, [...HOSTING_PROVIDERS]));
    return rows
      .filter((row) => hasScope(user.scopes, `integrations:hosting:view:${row.id}`))
      .map((row) => this.safe(row));
  }

  adapter(row: HostingConnectorRow, beforeRequest?: () => Promise<void>): HostingProviderAdapter {
    if (!isHostingProvider(row.provider) || !row.encryptedToken)
      throw new AppError(409, 'HOSTING_CREDENTIALS_MISSING', 'Hosting credentials are missing');
    const token = this.crypto.decryptString(JSON.parse(row.encryptedToken));
    return this.adapters({
      provider: row.provider,
      baseUrl: row.baseUrl,
      token,
      settings: this.settings(row),
      beforeRequest,
    });
  }

  async owner(row: HostingConnectorRow): Promise<User> {
    const user = await this.auth.getUserById(this.settings(row).ownerId);
    if (!user || user.isBlocked || user.isDeleted)
      throw new AppError(403, 'HOSTING_AUTOMATION_ACCESS_REVOKED', 'Hosting integration owner no longer has access');
    assertHostingScope(user.scopes, 'integrations:hosting:manage', row.id);
    assertHostingAdoptionAuthority(user.scopes, this.settings(row));
    return user;
  }

  private capabilityFlags(account: HostingAccount): Record<string, boolean> {
    return Object.fromEntries(
      Object.entries(account.capabilities).map(([key, capability]) => [key, capability.available])
    );
  }

  async preview(input: CreateHostingConnectorInput, user: User) {
    assertHostingScope(user.scopes, 'integrations:hosting:manage');
    assertHostingAdoptionAuthority(user.scopes, input.settings);
    const account = await this.adapters({
      ...input,
      settings: normalizedSettings(input.settings, input.provider),
    }).test();
    return { name: account.name, capabilities: account.capabilities };
  }

  async create(input: CreateHostingConnectorInput, user: User) {
    assertHostingScope(user.scopes, 'integrations:hosting:manage');
    assertHostingAdoptionAuthority(user.scopes, input.settings);
    const settings = normalizedSettings(input.settings, input.provider);
    const account = await this.adapters({ ...input, settings }).test();
    const row = await this.db.transaction(async (tx) => {
      if (input.provider === 'proxmox') {
        const [unreconciled] = await tx
          .select({ id: integrationConnectors.id })
          .from(integrationConnectors)
          .where(
            and(
              eq(integrationConnectors.provider, 'proxmox'),
              sql`${integrationConnectors.settings}->>'authority' = 'proxmox:' || (${integrationConnectors.settings}->>'clusterId')`,
              sql`${integrationConnectors.settings}->>'proxmoxAllocationAuthority' IS NULL`
            )
          )
          .limit(1);
        if (unreconciled)
          throw new AppError(
            409,
            'HOSTING_LEGACY_RECONCILIATION_REQUIRED',
            'Test existing Proxmox connectors to verify their cluster identities before connecting another host'
          );
      }
      const uniqueness =
        input.provider === 'proxmox' ? `${account.authority}:${settings.proxmoxHost}` : account.authority;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`hosting-account:${input.provider}:${uniqueness}`}))`
      );
      const duplicate = await tx
        .select({ id: integrationConnectors.id, encryptedToken: integrationConnectors.encryptedToken })
        .from(integrationConnectors)
        .where(
          and(
            eq(integrationConnectors.provider, input.provider),
            ...(input.provider === 'proxmox'
              ? [
                  sql`COALESCE(${integrationConnectors.settings}->>'proxmoxAllocationAuthority', ${integrationConnectors.settings}->>'authority') = ${account.authority}`,
                ]
              : [sql`${integrationConnectors.settings}->>'authority' = ${account.authority}`]),
            ...(input.provider === 'proxmox'
              ? [sql`${integrationConnectors.settings}->>'proxmoxHost' = ${settings.proxmoxHost!}`]
              : [])
          )
        );
      // Two different scoped tokens for Hetzner may share global server IDs; actual overlap is checked at sync.
      const identicalHetznerToken =
        input.provider === 'hetzner' &&
        duplicate.some((candidate) => {
          if (!candidate.encryptedToken) return false;
          const token = this.crypto.decryptString(JSON.parse(candidate.encryptedToken));
          return timingSafeEqual(
            createHash('sha256').update(token).digest(),
            createHash('sha256').update(input.token).digest()
          );
        });
      if (duplicate.length && (input.provider !== 'hetzner' || identicalHetznerToken))
        throw new AppError(
          409,
          'HOSTING_ACCOUNT_ALREADY_CONNECTED',
          'This hosting account or cluster is already connected'
        );
      const [created] = await tx
        .insert(integrationConnectors)
        .values({
          provider: input.provider,
          name: input.name,
          baseUrl: input.baseUrl,
          enabled: input.enabled,
          encryptedToken: JSON.stringify(this.crypto.encryptString(input.token)),
          tokenLast4: input.token.slice(-4),
          authMode: 'token',
          allowlistMode: 'all_visible',
          settings: {
            ...settings,
            authority: account.authority,
            ...(input.provider === 'proxmox' ? { proxmoxAllocationAuthority: account.authority } : {}),
            accountName: account.name,
            ownerId: user.id,
          } as StoredHostingSettings,
          capabilities: this.capabilityFlags(account),
          testedAt: new Date(),
        })
        .returning();
      return created;
    });
    await this.audit.log({
      userId: user.id,
      action: 'hosting.connector.create',
      resourceType: 'integration-connector',
      resourceId: row.id,
      details: { provider: row.provider },
    });
    if (row.enabled && this.initializeInventory) {
      try {
        // The connection remains pending in the UI until inventory, adoption and Redis projection are ready.
        await this.initializeInventory(row.id);
      } catch (error) {
        // Failed initial connection must not leave an invisible duplicate that blocks retry.
        // remove() detaches metadata only; existing node bindings and provider VMs survive.
        await this.remove(row.id, user);
        throw error;
      }
    }
    this.changed(row.id);
    return this.safe(await this.get(row.id));
  }

  async update(id: string, input: UpdateHostingConnectorInput, user: User) {
    assertHostingScope(user.scopes, 'integrations:hosting:manage', id);
    const previous = await this.get(id, user);
    if (input.provider !== previous.provider)
      throw new AppError(400, 'HOSTING_PROVIDER_IMMUTABLE', 'Create a separate integration for another provider');
    const settings = normalizedSettings(input.settings, input.provider);
    assertHostingAdoptionAuthority(user.scopes, settings);
    const previousSettings = this.settings(previous);
    const canReuseSavedToken =
      !input.token && input.baseUrl === previous.baseUrl && sameDiscoveryTrust(settings, previousSettings);
    if (!input.token && !canReuseSavedToken)
      throw new AppError(
        400,
        'HOSTING_FRESH_TOKEN_REQUIRED',
        'Provide a fresh provider token when changing the endpoint, token identity, or TLS trust'
      );
    const previousToken = this.crypto.decryptString(JSON.parse(previous.encryptedToken!));
    const token = input.token ?? previousToken;
    if (previous.provider === 'hetzner' && token !== previousToken)
      throw new AppError(
        409,
        'HOSTING_PROJECT_IDENTITY_UNVERIFIABLE',
        'Hetzner Cloud does not expose a verifiable project identity. Remove this integration and connect the replacement token as a new integration; existing node identities are retained.'
      );
    const previousAccount =
      previous.provider === 'proxmox'
        ? await this.adapter(previous).test()
        : ({ authority: previousSettings.authority } as HostingAccount);
    const account = await this.adapters({ ...input, token, settings }).test();
    const previousAllocationAuthority = allocationAuthority(previousSettings, previousAccount);
    if (previous.provider === 'proxmox' && account.authority !== previousAllocationAuthority)
      throw new AppError(
        409,
        'HOSTING_ACCOUNT_CHANGED',
        'Replacement Proxmox endpoint or credentials belong to another verified cluster'
      );
    const authority = legacyProxmoxAuthority(previousSettings) ? previousSettings.authority : account.authority;
    if (account.authority !== previousSettings.authority && !legacyProxmoxAuthority(previousSettings))
      throw new AppError(
        409,
        'HOSTING_ACCOUNT_CHANGED',
        'Replacement credentials belong to another account or cluster'
      );
    await this.db.transaction(async (tx) => {
      const uniqueness =
        input.provider === 'proxmox' ? `${account.authority}:${settings.proxmoxHost ?? ''}` : authority;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`hosting-account:${input.provider}:${uniqueness}`}))`
      );
      const [locked] = await tx
        .select()
        .from(integrationConnectors)
        .where(eq(integrationConnectors.id, id))
        .for('update');
      if (!locked) throw new AppError(404, 'HOSTING_CONNECTOR_NOT_FOUND', 'Hosting integration not found');
      const firewallResources = await tx
        .select({ id: hostingResources.id })
        .from(hostingResources)
        .where(eq(hostingResources.connectorId, id));
      await lockHostingFirewalls(
        tx,
        firewallResources.map((resource) => resource.id)
      );
      const active = await tx
        .select({ id: hostingOperations.id })
        .from(hostingOperations)
        .where(and(eq(hostingOperations.connectorId, id), notInArray(hostingOperations.phase, ['ready', 'failed'])))
        .limit(1);
      if (active.length)
        throw new AppError(
          409,
          'HOSTING_OPERATION_ACTIVE',
          'Wait for the current hosting operation before changing connection settings'
        );
      const duplicate = await tx
        .select({ id: integrationConnectors.id })
        .from(integrationConnectors)
        .where(
          and(
            eq(integrationConnectors.provider, input.provider),
            ...(input.provider === 'proxmox'
              ? [
                  sql`COALESCE(${integrationConnectors.settings}->>'proxmoxAllocationAuthority', ${integrationConnectors.settings}->>'authority') = ${account.authority}`,
                ]
              : [sql`${integrationConnectors.settings}->>'authority' = ${authority}`]),
            ...(input.provider === 'proxmox'
              ? [sql`${integrationConnectors.settings}->>'proxmoxHost' = ${settings.proxmoxHost ?? ''}`]
              : []),
            sql`${integrationConnectors.id} <> ${id}`
          )
        )
        .limit(1);
      if (duplicate.length && input.provider !== 'hetzner')
        throw new AppError(409, 'HOSTING_ACCOUNT_ALREADY_CONNECTED', 'This Proxmox physical host is already connected');
      await tx
        .update(integrationConnectors)
        .set({
          name: input.name,
          baseUrl: input.baseUrl,
          enabled: input.enabled,
          encryptedToken: JSON.stringify(this.crypto.encryptString(token)),
          tokenLast4: token.slice(-4),
          settings: {
            ...settings,
            authority,
            ...(input.provider === 'proxmox' ? { proxmoxAllocationAuthority: account.authority } : {}),
            accountName: account.name,
            ownerId: user.id,
          } as StoredHostingSettings,
          capabilities: this.capabilityFlags(account),
          testedAt: new Date(),
          syncStatus: 'never',
          updatedAt: new Date(),
        })
        .where(eq(integrationConnectors.id, id));
    });
    await this.audit.log({
      userId: user.id,
      action: 'hosting.connector.update',
      resourceType: 'integration-connector',
      resourceId: id,
    });
    await this.invalidateSnapshot?.(id);
    if (input.enabled) await this.initializeInventory?.(id);
    this.changed(id);
    return this.safe(await this.get(id, user));
  }

  async test(id: string, user: User) {
    assertHostingScope(user.scopes, 'integrations:hosting:manage', id);
    const row = await this.get(id, user);
    const account = await this.adapter(row).test();
    const settings = this.settings(row);
    const expectedAuthority =
      row.provider === 'proxmox' ? (settings.proxmoxAllocationAuthority ?? settings.authority) : settings.authority;
    if (
      account.authority !== expectedAuthority &&
      !(legacyProxmoxAuthority(settings) && !settings.proxmoxAllocationAuthority)
    )
      throw new AppError(409, 'HOSTING_ACCOUNT_CHANGED', 'The provider account identity changed');
    await this.db
      .update(integrationConnectors)
      .set({
        capabilities: this.capabilityFlags(account),
        ...(row.provider === 'proxmox'
          ? { settings: { ...settings, proxmoxAllocationAuthority: account.authority } as StoredHostingSettings }
          : {}),
        testedAt: new Date(),
      })
      .where(eq(integrationConnectors.id, id));
    this.changed(id);
    return { success: true, capabilities: account.capabilities };
  }

  async discover(input: DiscoverHostingConnectorInput, user: User) {
    assertHostingScope(user.scopes, 'integrations:hosting:manage', input.connectorId);
    let token = input.token;
    let settings: HostingSettings;
    let previous: HostingConnectorRow | undefined;
    if (input.connectorId) {
      previous = await this.get(input.connectorId, user);
      if (previous.provider !== 'proxmox')
        throw new AppError(400, 'HOSTING_PROVIDER_IMMUTABLE', 'Select a Proxmox integration for Proxmox discovery');
      const stored = this.settings(previous);
      const {
        authority: _authority,
        ownerId: _owner,
        accountName: _account,
        proxmoxAllocationAuthority: _allocation,
        ...publicStored
      } = stored;
      settings = discoverySettings(publicStored, input.settings, input.tlsMode);
    } else settings = discoverySettings(HostingSettingsSchema.parse({}), input.settings, input.tlsMode);
    if (previous) {
      const previousSettings = this.settings(previous);
      const canReuseSavedToken =
        !input.token && input.baseUrl === previous.baseUrl && sameDiscoveryTrust(settings, previousSettings);
      if (!input.token && !canReuseSavedToken)
        throw new AppError(
          400,
          'HOSTING_FRESH_TOKEN_REQUIRED',
          'Provide a fresh Proxmox token when changing the endpoint, token identity, or TLS trust'
        );
      token ??= this.crypto.decryptString(JSON.parse(previous.encryptedToken!));
    }
    if (!token || !settings.tokenId)
      throw new AppError(400, 'HOSTING_TOKEN_ID_REQUIRED', 'Proxmox token ID is required for discovery');
    const adapter = this.adapters({
      provider: 'proxmox',
      baseUrl: input.baseUrl,
      token,
      settings: normalizedSettings(settings, 'proxmox'),
    });
    if (!adapter.discover)
      throw new AppError(
        409,
        'HOSTING_DISCOVERY_UNSUPPORTED',
        'This hosting provider does not support setup discovery'
      );
    const { usedIps: _usedIps, ...discovery } = await adapter.discover();
    return discovery;
  }

  async remove(id: string, user: User) {
    assertHostingScope(user.scopes, 'integrations:hosting:manage', id);
    await this.get(id, user);
    let removedResourceIds: string[] = [];
    await this.db.transaction(async (tx) => {
      await tx
        .select({ id: integrationConnectors.id })
        .from(integrationConnectors)
        .where(eq(integrationConnectors.id, id))
        .for('update');
      const firewallResources = await tx
        .select({ id: hostingResources.id })
        .from(hostingResources)
        .where(eq(hostingResources.connectorId, id));
      removedResourceIds = firewallResources.map((resource) => resource.id);
      await lockHostingFirewalls(
        tx,
        firewallResources.map((resource) => resource.id)
      );
      const active = await tx
        .select({ id: hostingOperations.id })
        .from(hostingOperations)
        .where(and(eq(hostingOperations.connectorId, id), notInArray(hostingOperations.phase, ['ready', 'failed'])))
        .limit(1);
      if (active.length)
        throw new AppError(
          409,
          'HOSTING_OPERATION_ACTIVE',
          'Resolve active hosting operations before removing the integration'
        );
      // Keep resource identity, origin and node bindings for safe reconnection; FK only detaches connector.
      await tx
        .update(hostingResources)
        .set({ connectorId: null, updatedAt: new Date() })
        .where(eq(hostingResources.connectorId, id));
      await tx.delete(integrationConnectors).where(eq(integrationConnectors.id, id));
    });
    await this.audit.log({
      userId: user.id,
      action: 'hosting.connector.delete',
      resourceType: 'integration-connector',
      resourceId: id,
      details: { remoteResourcesDeleted: false },
    });
    await this.invalidateSnapshot?.(id, removedResourceIds);
    this.changed(id);
    return { success: true };
  }

  changed(id: string) {
    // Invalidation only; never broadcast account finance, credentials or node names.
    this.events.publish('integration.connector.changed', { id, provider: 'hosting' });
  }
}
