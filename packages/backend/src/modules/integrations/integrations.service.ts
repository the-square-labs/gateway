import { and, desc, eq, isNull, type SQL } from 'drizzle-orm';
import type { DrizzleClient } from '@/db/client.js';
import {
  type CloudflareConnectorSettings,
  domains,
  type IntegrationConnectorCapabilities,
  type IntegrationConnectorSettings,
  type IntegrationConnectorSettingsValue,
  type IntegrationProvider,
  integrationConnectorAllowlistEntries,
  integrationConnectorCloudflareZones,
  integrationConnectorCredentials,
  integrationConnectorProjects,
  integrationConnectorRegistries,
  integrationConnectors,
} from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';
import { buildWhere } from '@/lib/utils.js';
import { AppError } from '@/middleware/error-handler.js';
import type { AISandboxService } from '@/modules/ai/ai.sandbox.service.js';
import type { AuditService } from '@/modules/audit/audit.service.js';
import type { DockerRegistryService } from '@/modules/docker/docker-registry.service.js';
import type { SSLService } from '@/modules/ssl/ssl.service.js';
import type { CryptoService } from '@/services/crypto.service.js';
import type { EventBusService } from '@/services/event-bus.service.js';
import type { User } from '@/types.js';
import { CloudflareClient, type CloudflareDnsRecord, type CloudflareZoneRef } from './cloudflare-client.js';
import { GitLabUserCredentialsService, type ResolvedGitLabUserCredential } from './gitlab-user-credentials.service.js';
import {
  buildGitLabFileCommitAuditDetails,
  CLOUDFLARE_AUDIT_ACTIONS,
  GITLAB_AUDIT_ACTIONS,
  hashGitLabDiff,
  redactGitLabAuditDetails,
} from './integration-audit.js';
import { assertConnectorOperationAccess } from './integration-permissions.js';
import type {
  ConnectorProvider,
  VcsCommitFileChange,
  VcsConnectorAuth,
  VcsConnectorProvider,
  VcsProjectAccess,
  VcsProjectRef,
  VcsUserTokenIdentity,
} from './integration-provider.types.js';
import type {
  CloudflareConnectorCreateInput,
  CloudflareConnectorListQuery,
  CloudflareConnectorUpdateInput,
  GitLabAllowlistEntryInput,
  GitLabConnectorCreateInput,
  GitLabConnectorListQuery,
  GitLabConnectorUpdateInput,
  GitLabUserCredentialAuthorizeInput,
} from './integrations.schemas.js';

type ConnectorRow = typeof integrationConnectors.$inferSelect;
type AllowlistRow = typeof integrationConnectorAllowlistEntries.$inferSelect;
type ProjectRow = typeof integrationConnectorProjects.$inferSelect;
type CloudflareZoneRow = typeof integrationConnectorCloudflareZones.$inferSelect;
type GitLabCredentialSource = 'system' | 'personal';

interface ResolvedGitLabCredential {
  source: GitLabCredentialSource;
  auth: VcsConnectorAuth;
  scopes: string[];
}

export const DEFAULT_GITLAB_CONNECTOR_SETTINGS: IntegrationConnectorSettings = {
  autoSyncEnabled: true,
  autoSyncIntervalSeconds: 900,
  cloneShallow: true,
  cloneDepth: 1,
  cloneLfs: false,
  cloneSubmodules: false,
  cloneMaxSizeMb: 1024,
  cloneTimeoutSeconds: 300,
};

export const DEFAULT_CLOUDFLARE_CONNECTOR_SETTINGS: CloudflareConnectorSettings = {
  autoSyncEnabled: true,
  autoSyncIntervalSeconds: 900,
  defaultTtl: 1,
  defaultProxied: true,
};

const MAX_BACKOFF_SECONDS = 3600;
const STALE_SYNC_SECONDS = 1800;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SafeIntegrationConnector extends Omit<ConnectorRow, 'encryptedToken'> {
  hasToken: boolean;
  tokenMasked: string | null;
}

export class IntegrationsService {
  private eventBus?: EventBusService;
  private dockerRegistryService?: DockerRegistryService;
  private sslService?: SSLService;
  private readonly providers = new Map<IntegrationProvider, ConnectorProvider>();
  private readonly syncLocks = new Set<string>();
  private readonly gitLabUserCredentials: GitLabUserCredentialsService;

  constructor(
    private db: DrizzleClient,
    private auditService: AuditService,
    private cryptoService: CryptoService,
    providers: ConnectorProvider[] = []
  ) {
    this.gitLabUserCredentials = new GitLabUserCredentialsService(db, cryptoService);
    for (const provider of providers) {
      this.providers.set(provider.provider, provider);
    }
  }

  async getGitLabUserCredentialStatus(connectorId: string, userId: string) {
    const connector = await this.getConnectorRow(connectorId, 'gitlab');
    const credential = await this.gitLabUserCredentials.getStatus(userId, connectorId);
    return {
      connectorId: connector.id,
      connectorName: connector.name,
      baseUrl: connector.baseUrl,
      patCreationUrl: this.gitLabPatCreationUrl(connector.baseUrl),
      ...credential,
    };
  }

  async authorizeGitLabUserCredential(connectorId: string, input: GitLabUserCredentialAuthorizeInput, userId: string) {
    const connector = await this.getConnectorRow(connectorId, 'gitlab');
    if (!connector.enabled) {
      throw new AppError(409, 'CONNECTOR_DISABLED', 'GitLab connector is disabled');
    }

    let identity: VcsUserTokenIdentity;
    try {
      identity = await this.getVcsProvider('gitlab').validateUserToken({
        baseUrl: connector.baseUrl,
        token: input.token,
      });
    } catch (error) {
      if (error instanceof AppError && (error.statusCode === 401 || error.statusCode === 403)) {
        throw new AppError(400, 'GITLAB_AUTHORIZATION_INVALID', 'GitLab rejected this personal access token');
      }
      throw error;
    }

    const credential = await this.gitLabUserCredentials.replace(userId, connectorId, input.token, {
      gitlabUserId: identity.userId,
      gitlabUsername: identity.username,
      tokenScopes: identity.scopes,
      tokenExpiresAt: identity.expiresAt,
    });
    await this.auditService.log({
      action: GITLAB_AUDIT_ACTIONS.userCredentialAuthorize,
      userId,
      resourceType: 'integration-connector',
      resourceId: connectorId,
      details: {
        connectorName: connector.name,
        gitlabUserId: identity.userId,
        gitlabUsername: identity.username,
      },
    });
    return {
      connectorId: connector.id,
      connectorName: connector.name,
      baseUrl: connector.baseUrl,
      patCreationUrl: this.gitLabPatCreationUrl(connector.baseUrl),
      ...credential,
    };
  }

  async disconnectGitLabUserCredential(connectorId: string, userId: string) {
    const connector = await this.getConnectorRow(connectorId, 'gitlab');
    const disconnected = await this.gitLabUserCredentials.disconnect(userId, connectorId);
    if (disconnected) {
      await this.auditService.log({
        action: GITLAB_AUDIT_ACTIONS.userCredentialDisconnect,
        userId,
        resourceType: 'integration-connector',
        resourceId: connectorId,
        details: { connectorName: connector.name },
      });
    }
    return { disconnected };
  }

  async resolvePersonalGitLabAuth(userId: string, connectorId: string): Promise<ResolvedGitLabUserCredential | null> {
    const connector = await this.getConnectorRow(connectorId, 'gitlab');
    return this.gitLabUserCredentials.resolveAuth(userId, connectorId, connector.baseUrl);
  }

  async invalidateGitLabUserCredential(userId: string, connectorId: string): Promise<void> {
    const connector = await this.getConnectorRow(connectorId, 'gitlab');
    await this.gitLabUserCredentials.markInvalid(userId, connectorId);
    await this.auditService.log({
      action: GITLAB_AUDIT_ACTIONS.userCredentialInvalidate,
      userId,
      resourceType: 'integration-connector',
      resourceId: connectorId,
      details: { connectorName: connector.name },
    });
  }

  setEventBus(bus: EventBusService) {
    this.eventBus = bus;
  }

  setDockerRegistryService(service: DockerRegistryService) {
    this.dockerRegistryService = service;
  }

  setSSLService(service: SSLService) {
    this.sslService = service;
  }

  registerProvider(provider: ConnectorProvider) {
    this.providers.set(provider.provider, provider);
  }

  async listGitLabConnectors(query: GitLabConnectorListQuery = {}) {
    const conditions: SQL[] = [eq(integrationConnectors.provider, 'gitlab')];
    if (query.enabled !== undefined) conditions.push(eq(integrationConnectors.enabled, query.enabled));

    const rows = await this.db
      .select()
      .from(integrationConnectors)
      .where(buildWhere(conditions))
      .orderBy(desc(integrationConnectors.createdAt));

    return rows.map((row) => this.toSafeConnector(row));
  }

  async getGitLabConnector(id: string) {
    const row = await this.getConnectorRow(id, 'gitlab');
    const allowlistEntries = await this.listAllowlistRows(id);
    return { ...this.toSafeConnector(row), allowlistEntries };
  }

  async createGitLabConnector(input: GitLabConnectorCreateInput, userId: string) {
    const settings = this.mergeSettings(input.settings);
    const baseUrl = this.normalizeBaseUrl(input.baseUrl);
    const provider = this.getProvider('gitlab');
    const [capabilities, projects] = await Promise.all([
      provider.testConnection({ baseUrl, token: input.token }),
      provider.listProjects({ baseUrl, token: input.token }),
    ]);
    const encryptedToken = this.encryptToken(input.token);
    const allowlistEntries = this.dedupeAllowlistEntries(input.allowlistEntries ?? []);

    const [row] = await this.db
      .insert(integrationConnectors)
      .values({
        provider: 'gitlab',
        name: input.name,
        baseUrl,
        enabled: input.enabled,
        encryptedToken,
        tokenLast4: this.tokenLast4(input.token),
        allowlistMode: input.allowlistMode,
        settings,
        capabilities,
        testedAt: new Date(),
      })
      .returning();

    await this.replaceAllowlistEntries(row.id, allowlistEntries);
    await this.persistProjects(row.id, projects);

    await this.auditService.log({
      action: GITLAB_AUDIT_ACTIONS.connectorCreate,
      userId,
      resourceType: 'integration-connector',
      resourceId: row.id,
      details: { name: row.name, baseUrl: row.baseUrl, allowlistMode: row.allowlistMode },
    });

    this.emitConnector(row.id, 'created');
    await this.syncConnectorAfterCreate('gitlab', row.id, userId);
    return this.getGitLabConnector(row.id);
  }

  async updateGitLabConnector(id: string, input: GitLabConnectorUpdateInput, userId: string) {
    const existing = await this.getConnectorRow(id, 'gitlab');
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    const nextBaseUrl = input.baseUrl !== undefined ? this.normalizeBaseUrl(input.baseUrl) : existing.baseUrl;
    const nextSettings =
      input.settings !== undefined ? this.mergeSettings(input.settings, this.gitLabSettings(existing)) : undefined;
    const nextToken = input.token?.trim();
    const existingAuth = this.systemAuthFor(existing);
    const auth =
      nextToken && nextToken.length > 0
        ? { baseUrl: nextBaseUrl, token: nextToken }
        : { ...existingAuth, baseUrl: nextBaseUrl };
    const capabilities = await this.getProvider(existing.provider).testConnection(auth);

    if (input.name !== undefined) updates.name = input.name;
    if (input.baseUrl !== undefined) updates.baseUrl = nextBaseUrl;
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.allowlistMode !== undefined) updates.allowlistMode = input.allowlistMode;
    if (nextSettings !== undefined) updates.settings = nextSettings;
    if (nextToken && nextToken.length > 0) {
      updates.encryptedToken = this.encryptToken(nextToken);
      updates.tokenLast4 = this.tokenLast4(nextToken);
    }
    updates.capabilities = capabilities;
    updates.testedAt = new Date();

    const [row] = await this.db
      .update(integrationConnectors)
      .set(updates)
      .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, 'gitlab')))
      .returning();

    if (!row) throw new AppError(404, 'NOT_FOUND', 'GitLab connector not found');
    if (input.allowlistEntries !== undefined) {
      await this.replaceAllowlistEntries(id, this.dedupeAllowlistEntries(input.allowlistEntries));
    }

    await this.auditService.log({
      action: GITLAB_AUDIT_ACTIONS.connectorUpdate,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: {
        name: existing.name,
        changes: Object.keys(updates).filter((key) => !['updatedAt', 'encryptedToken', 'tokenLast4'].includes(key)),
        tokenRotated: Boolean(nextToken),
        allowlistUpdated: input.allowlistEntries !== undefined,
      },
    });

    if (nextToken) {
      await this.auditService.log({
        action: GITLAB_AUDIT_ACTIONS.connectorTokenRotate,
        userId,
        resourceType: 'integration-connector',
        resourceId: id,
        details: { name: row.name, tokenLast4: row.tokenLast4 },
      });
    }

    this.emitConnector(id, 'updated');
    return this.getGitLabConnector(id);
  }

  async rotateGitLabConnectorToken(id: string, token: string, userId: string) {
    const existing = await this.getConnectorRow(id, 'gitlab');
    const capabilities = await this.getProvider(existing.provider).testConnection({ baseUrl: existing.baseUrl, token });
    const [row] = await this.db
      .update(integrationConnectors)
      .set({
        encryptedToken: this.encryptToken(token),
        tokenLast4: this.tokenLast4(token),
        testedAt: new Date(),
        capabilities,
        updatedAt: new Date(),
      })
      .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, 'gitlab')))
      .returning();

    if (!row) throw new AppError(404, 'NOT_FOUND', 'GitLab connector not found');

    await this.auditService.log({
      action: GITLAB_AUDIT_ACTIONS.connectorTokenRotate,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: { name: row.name, tokenLast4: row.tokenLast4 },
    });

    this.emitConnector(id, 'token-rotated');
    return this.toSafeConnector(row);
  }

  async deleteGitLabConnector(id: string, userId: string) {
    const existing = await this.getConnectorRow(id, 'gitlab');
    await this.dockerRegistryService?.deleteGitLabConnectorRegistries(id);
    await this.db
      .delete(integrationConnectors)
      .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, 'gitlab')));

    await this.auditService.log({
      action: GITLAB_AUDIT_ACTIONS.connectorDelete,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: { name: existing.name, baseUrl: existing.baseUrl },
    });

    this.emitConnector(id, 'deleted');
  }

  async getGitLabConnectorCapabilities(id: string): Promise<IntegrationConnectorCapabilities> {
    const row = await this.getConnectorRow(id, 'gitlab');
    return row.capabilities ?? {};
  }

  async testGitLabConnector(id: string, userId: string) {
    const row = await this.getConnectorRow(id, 'gitlab');
    const provider = this.getProvider(row.provider);
    const capabilities = await provider.testConnection(this.systemAuthFor(row));
    const [updated] = await this.db
      .update(integrationConnectors)
      .set({
        capabilities,
        testedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(integrationConnectors.id, id))
      .returning();

    await this.auditService.log({
      action: GITLAB_AUDIT_ACTIONS.connectorTest,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: { name: row.name, success: true },
    });

    this.emitConnector(id, 'tested');
    return this.toSafeConnector(updated);
  }

  async syncGitLabConnector(id: string, userId: string | null, options: { scheduled?: boolean } = {}) {
    const row = await this.getConnectorRow(id, 'gitlab');
    if (this.isSyncRunning(row) || this.syncLocks.has(id)) {
      await this.recordSyncOverlap(id);
      if (options.scheduled) return { status: 'skipped', reason: 'already_running' };
      throw new AppError(409, 'CONNECTOR_SYNC_RUNNING', 'GitLab connector sync is already running', {
        syncStartedAt: row.syncStartedAt,
      });
    }

    const provider = this.getProvider(row.provider);
    this.syncLocks.add(id);
    await this.db
      .update(integrationConnectors)
      .set({ syncStatus: 'running', syncStartedAt: new Date(), syncLastError: null, updatedAt: new Date() })
      .where(eq(integrationConnectors.id, id));
    this.emitConnector(id, 'sync-started');

    try {
      const auth = this.systemAuthFor(row);
      const capabilities = await provider.testConnection(auth);
      const allProjects = await provider.listProjects(auth);
      const allowlistEntries = await this.listAllowlistRows(id);
      const projects = this.filterAllowedProjects(row, allowlistEntries, allProjects);
      const registryDiscovery = await provider.listRegistries(auth, projects);
      const registries = this.filterAllowedRegistries(row, allowlistEntries, projects, registryDiscovery.registries);
      await this.persistProjects(id, allProjects);
      await this.persistRegistries(id, registries);
      await this.dockerRegistryService?.reconcileGitLabConnectorRegistries(id);
      await this.db
        .update(integrationConnectors)
        .set({
          capabilities,
          testedAt: new Date(),
          syncStatus: 'success',
          syncFinishedAt: new Date(),
          syncFailureCount: 0,
          syncNextRetryAt: null,
          updatedAt: new Date(),
        })
        .where(eq(integrationConnectors.id, id));

      if (userId) {
        await this.auditService.log({
          action: GITLAB_AUDIT_ACTIONS.connectorSync,
          userId,
          resourceType: 'integration-connector',
          resourceId: id,
          details: {
            name: row.name,
            projectCount: projects.length,
            registryCount: registries.length,
            skippedRegistryProjects: registryDiscovery.skippedProjects.length,
          },
        });
      }

      this.emitConnector(id, 'synced');
      this.emitConnector(id, 'registries-synced');
      return {
        status: 'success',
        projectCount: projects.length,
        registryCount: registries.length,
        skippedRegistryProjects: registryDiscovery.skippedProjects,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown sync failure';
      const failureCount = row.syncFailureCount + 1;
      await this.db
        .update(integrationConnectors)
        .set({
          syncStatus: 'error',
          syncFinishedAt: new Date(),
          syncLastError: message,
          syncFailureCount: failureCount,
          syncNextRetryAt: new Date(Date.now() + this.backoffSeconds(failureCount) * 1000),
          updatedAt: new Date(),
        })
        .where(eq(integrationConnectors.id, id));
      this.emitConnector(id, 'sync-failed');
      throw error;
    } finally {
      this.syncLocks.delete(id);
    }
  }

  async runDueGitLabSyncs() {
    const rows = await this.db
      .select()
      .from(integrationConnectors)
      .where(and(eq(integrationConnectors.provider, 'gitlab'), eq(integrationConnectors.enabled, true)));
    const now = new Date();
    for (const row of rows) {
      if (!row.settings.autoSyncEnabled || !this.isDueForSync(row, now)) continue;
      try {
        await this.syncGitLabConnector(row.id, null, { scheduled: true });
      } catch {
        // syncGitLabConnector already persists failure state; scheduler must not block boot or other jobs.
      }
    }
  }

  async listCloudflareConnectors(query: CloudflareConnectorListQuery = {}) {
    const conditions: SQL[] = [eq(integrationConnectors.provider, 'cloudflare')];
    if (query.enabled !== undefined) conditions.push(eq(integrationConnectors.enabled, query.enabled));

    const rows = await this.db
      .select()
      .from(integrationConnectors)
      .where(buildWhere(conditions))
      .orderBy(desc(integrationConnectors.createdAt));

    return Promise.all(
      rows.map(async (row) => ({
        ...this.toSafeConnector(row),
        zones: await this.listCloudflareZoneRows(row.id),
      }))
    );
  }

  /** Safe shell-level capability check; never exposes connector metadata or credentials. */
  async hasEnabledCloudflareConnector(): Promise<boolean> {
    const [connector] = await this.db
      .select({ id: integrationConnectors.id })
      .from(integrationConnectors)
      .where(
        and(
          eq(integrationConnectors.provider, 'cloudflare'),
          eq(integrationConnectors.enabled, true)
        )
      )
      .limit(1);
    return connector !== undefined;
  }

  async getCloudflareConnector(id: string) {
    const row = await this.getConnectorRow(id, 'cloudflare');
    const zones = await this.listCloudflareZoneRows(id);
    return { ...this.toSafeConnector(row), zones };
  }

  async createCloudflareConnector(input: CloudflareConnectorCreateInput, userId: string) {
    const settings = this.mergeCloudflareSettings(input.settings);
    const { capabilities, zones } = await this.testCloudflareToken(input.token);
    const encryptedToken = this.encryptToken(input.token);

    const [row] = await this.db
      .insert(integrationConnectors)
      .values({
        provider: 'cloudflare',
        name: input.name,
        baseUrl: 'https://api.cloudflare.com',
        enabled: input.enabled,
        encryptedToken,
        tokenLast4: this.tokenLast4(input.token),
        allowlistMode: 'all_visible',
        settings,
        capabilities,
        testedAt: new Date(),
      })
      .returning();

    await this.persistCloudflareZones(row.id, zones);
    await this.sslService?.revalidateCloudflareAutoRenew();

    await this.auditService.log({
      action: CLOUDFLARE_AUDIT_ACTIONS.connectorCreate,
      userId,
      resourceType: 'integration-connector',
      resourceId: row.id,
      details: { name: row.name, zoneCount: zones.length },
    });

    this.emitConnector(row.id, 'created', 'cloudflare');
    await this.markCloudflareInitialSync(row.id, userId, row.name, zones.length);
    return this.getCloudflareConnector(row.id);
  }

  async updateCloudflareConnector(id: string, input: CloudflareConnectorUpdateInput, userId: string) {
    const existing = await this.getConnectorRow(id, 'cloudflare');
    const updates: Record<string, unknown> = { updatedAt: new Date() };

    if (input.name !== undefined) updates.name = input.name;
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.settings !== undefined)
      updates.settings = this.mergeCloudflareSettings(input.settings, existing.settings);

    let [row] = await this.db
      .update(integrationConnectors)
      .set(updates)
      .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, 'cloudflare')))
      .returning();

    if (!row) throw new AppError(404, 'NOT_FOUND', 'Cloudflare connector not found');

    const { capabilities, zones } = await this.testCloudflareToken(this.cloudflareTokenFor(row));
    [row] = await this.db
      .update(integrationConnectors)
      .set({ capabilities, testedAt: new Date(), updatedAt: new Date() })
      .where(eq(integrationConnectors.id, id))
      .returning();
    await this.persistCloudflareZones(id, zones);
    await this.sslService?.revalidateCloudflareAutoRenew();

    await this.auditService.log({
      action: CLOUDFLARE_AUDIT_ACTIONS.connectorUpdate,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: {
        name: existing.name,
        changes: Object.keys(updates).filter((key) => key !== 'updatedAt'),
        zoneCount: zones.length,
      },
    });

    this.emitConnector(id, 'updated', 'cloudflare');
    return this.getCloudflareConnector(id);
  }

  async rotateCloudflareConnectorToken(id: string, token: string, userId: string) {
    await this.getConnectorRow(id, 'cloudflare');
    const { capabilities, zones } = await this.testCloudflareToken(token);
    const [row] = await this.db
      .update(integrationConnectors)
      .set({
        encryptedToken: this.encryptToken(token),
        tokenLast4: this.tokenLast4(token),
        testedAt: new Date(),
        capabilities,
        updatedAt: new Date(),
      })
      .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, 'cloudflare')))
      .returning();

    if (!row) throw new AppError(404, 'NOT_FOUND', 'Cloudflare connector not found');
    await this.persistCloudflareZones(id, zones);
    await this.sslService?.revalidateCloudflareAutoRenew();

    await this.auditService.log({
      action: CLOUDFLARE_AUDIT_ACTIONS.connectorTokenRotate,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: { name: row.name, zoneCount: zones.length },
    });

    this.emitConnector(id, 'token-rotated', 'cloudflare');
    return this.getCloudflareConnector(id);
  }

  async deleteCloudflareConnector(id: string, userId: string) {
    const existing = await this.getConnectorRow(id, 'cloudflare');
    const linkedDomains = await this.db
      .select({ id: domains.id, domain: domains.domain })
      .from(domains)
      .where(eq(domains.integrationConnectorId, id))
      .limit(5);
    if (linkedDomains.length > 0) {
      throw new AppError(409, 'CLOUDFLARE_CONNECTOR_IN_USE', 'Cloudflare connector is used by Gateway domains', {
        domainCount: linkedDomains.length,
        domains: linkedDomains,
      });
    }
    await this.sslService?.disableCloudflareAutoRenewForConnector(id, 'cloudflare_connector_deleted');
    await this.db
      .delete(integrationConnectors)
      .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, 'cloudflare')));

    await this.auditService.log({
      action: CLOUDFLARE_AUDIT_ACTIONS.connectorDelete,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: { name: existing.name },
    });

    this.emitConnector(id, 'deleted', 'cloudflare');
  }

  async testCloudflareConnector(id: string, userId: string) {
    const row = await this.getConnectorRow(id, 'cloudflare');
    const { capabilities, zones } = await this.testCloudflareToken(this.cloudflareTokenFor(row));
    const [updated] = await this.db
      .update(integrationConnectors)
      .set({ capabilities, testedAt: new Date(), updatedAt: new Date() })
      .where(eq(integrationConnectors.id, id))
      .returning();
    await this.persistCloudflareZones(id, zones);
    await this.sslService?.revalidateCloudflareAutoRenew();

    await this.auditService.log({
      action: CLOUDFLARE_AUDIT_ACTIONS.connectorTest,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: { name: row.name, success: true, zoneCount: zones.length },
    });

    this.emitConnector(id, 'tested', 'cloudflare');
    return this.toSafeConnector(updated);
  }

  async testCloudflareConnectorPreview(input: { token: string }) {
    const { capabilities, zones } = await this.testCloudflareToken(input.token);
    return {
      capabilities,
      zones: zones.map((zone) => this.cloudflareZonePreview(zone)),
    };
  }

  async syncCloudflareConnector(id: string, userId: string | null, options: { scheduled?: boolean } = {}) {
    const row = await this.getConnectorRow(id, 'cloudflare');
    if (this.isSyncRunning(row) || this.syncLocks.has(id)) {
      await this.recordSyncOverlap(id);
      if (options.scheduled) return { status: 'skipped', reason: 'already_running' };
      throw new AppError(409, 'CONNECTOR_SYNC_RUNNING', 'Cloudflare connector sync is already running', {
        syncStartedAt: row.syncStartedAt,
      });
    }

    this.syncLocks.add(id);
    await this.db
      .update(integrationConnectors)
      .set({ syncStatus: 'running', syncStartedAt: new Date(), syncLastError: null, updatedAt: new Date() })
      .where(eq(integrationConnectors.id, id));
    this.emitConnector(id, 'sync-started', 'cloudflare');

    try {
      const { capabilities, zones } = await this.testCloudflareToken(this.cloudflareTokenFor(row));
      await this.persistCloudflareZones(id, zones);
      await this.sslService?.revalidateCloudflareAutoRenew();
      await this.db
        .update(integrationConnectors)
        .set({
          capabilities,
          testedAt: new Date(),
          syncStatus: 'success',
          syncFinishedAt: new Date(),
          syncFailureCount: 0,
          syncNextRetryAt: null,
          updatedAt: new Date(),
        })
        .where(eq(integrationConnectors.id, id));

      if (userId) {
        await this.auditService.log({
          action: CLOUDFLARE_AUDIT_ACTIONS.connectorSync,
          userId,
          resourceType: 'integration-connector',
          resourceId: id,
          details: { name: row.name, zoneCount: zones.length },
        });
      }

      this.emitConnector(id, 'synced', 'cloudflare');
      return { status: 'success', zoneCount: zones.length };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown sync failure';
      const failureCount = row.syncFailureCount + 1;
      if (this.shouldDisableCloudflareAutoRenew(error)) {
        await this.sslService?.disableCloudflareAutoRenewForConnector(id, 'cloudflare_connector_unavailable');
      }
      await this.db
        .update(integrationConnectors)
        .set({
          syncStatus: 'error',
          syncFinishedAt: new Date(),
          syncLastError: message,
          syncFailureCount: failureCount,
          syncNextRetryAt: new Date(Date.now() + this.backoffSeconds(failureCount) * 1000),
          updatedAt: new Date(),
        })
        .where(eq(integrationConnectors.id, id));
      this.emitConnector(id, 'sync-failed', 'cloudflare');
      throw error;
    } finally {
      this.syncLocks.delete(id);
    }
  }

  async runDueCloudflareSyncs() {
    const rows = await this.db
      .select()
      .from(integrationConnectors)
      .where(and(eq(integrationConnectors.provider, 'cloudflare'), eq(integrationConnectors.enabled, true)));
    const now = new Date();
    for (const row of rows) {
      if (!row.settings.autoSyncEnabled || !this.isDueForSync(row, now)) continue;
      try {
        await this.syncCloudflareConnector(row.id, null, { scheduled: true });
      } catch {
        // syncCloudflareConnector already persists failure state; scheduler must not block boot or other jobs.
      }
    }
  }

  async listCloudflareZones(id: string) {
    await this.getConnectorRow(id, 'cloudflare');
    return this.listCloudflareZoneRows(id);
  }

  async resolveCloudflareDnsContext(domain: string) {
    const connectors = await this.db
      .select()
      .from(integrationConnectors)
      .where(and(eq(integrationConnectors.provider, 'cloudflare'), eq(integrationConnectors.enabled, true)));
    const candidates: Array<{ connector: ConnectorRow; zone: CloudflareZoneRow; matchLength: number }> = [];

    for (const connector of connectors) {
      const zones = await this.listCloudflareZoneRows(connector.id);
      for (const zone of zones) {
        if (domain === zone.name || domain.endsWith(`.${zone.name}`)) {
          candidates.push({ connector, zone, matchLength: zone.name.length });
        }
      }
    }

    if (candidates.length === 0) {
      throw new AppError(
        409,
        'CLOUDFLARE_ZONE_NOT_FOUND',
        'No enabled Cloudflare connector has a synced zone for this domain',
        { domain }
      );
    }

    const bestLength = Math.max(...candidates.map((candidate) => candidate.matchLength));
    const best = candidates.filter((candidate) => candidate.matchLength === bestLength);
    if (best.length > 1) {
      throw new AppError(409, 'CLOUDFLARE_ZONE_AMBIGUOUS', 'Multiple Cloudflare connectors match this domain zone', {
        domain,
        zones: best.map((candidate) => ({
          connectorId: candidate.connector.id,
          connectorName: candidate.connector.name,
          zoneId: candidate.zone.remoteId,
          zoneName: candidate.zone.name,
        })),
      });
    }

    const [{ connector, zone }] = best;
    return {
      connector,
      zone,
      settings: this.mergeCloudflareSettings(undefined, connector.settings),
      client: new CloudflareClient(this.cloudflareTokenFor(connector)),
    };
  }

  async getCloudflareDnsContextForRecord(connectorId: string, zoneRemoteId: string) {
    const connector = await this.getConnectorRow(connectorId, 'cloudflare');
    const zones = await this.listCloudflareZoneRows(connector.id);
    const zone = zones.find((candidate) => candidate.remoteId === zoneRemoteId);
    if (!zone) {
      throw new AppError(409, 'CLOUDFLARE_ZONE_NOT_FOUND', 'Cloudflare zone is no longer synced for this domain', {
        connectorId,
        zoneId: zoneRemoteId,
      });
    }
    return {
      connector,
      zone,
      settings: this.mergeCloudflareSettings(undefined, connector.settings),
      client: new CloudflareClient(this.cloudflareTokenFor(connector)),
    };
  }

  async searchGitLabAllowlist(id: string, query: string) {
    const row = await this.getConnectorRow(id, 'gitlab');
    const provider = this.getProvider(row.provider);
    return provider.searchAllowlist(this.systemAuthFor(row), query);
  }

  async listGitLabAllowlistOptions(id: string) {
    const row = await this.getConnectorRow(id, 'gitlab');
    const projects = await this.db
      .select()
      .from(integrationConnectorProjects)
      .where(
        and(eq(integrationConnectorProjects.connectorId, row.id), isNull(integrationConnectorProjects.inaccessibleAt))
      )
      .orderBy(integrationConnectorProjects.fullPath);
    return projects.map((project) => this.projectToAllowlistEntry(project));
  }

  async refreshGitLabAllowlistOptions(id: string, userId: string) {
    const row = await this.getConnectorRow(id, 'gitlab');
    const provider = this.getProvider(row.provider);
    const projects = await provider.listProjects(this.systemAuthFor(row));
    await this.persistProjects(id, projects);

    await this.auditService.log({
      action: GITLAB_AUDIT_ACTIONS.projectList,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: { name: row.name, source: 'settings', refreshed: true, projectCount: projects.length },
    });

    return this.listGitLabAllowlistOptions(id);
  }

  async searchGitLabAllowlistPreview(input: { baseUrl: string; token: string; q: string }) {
    const baseUrl = this.normalizeBaseUrl(input.baseUrl);
    return this.getProvider('gitlab').searchAllowlist({ baseUrl, token: input.token }, input.q);
  }

  async testGitLabConnectorPreview(input: { baseUrl: string; token: string }) {
    const baseUrl = this.normalizeBaseUrl(input.baseUrl);
    const auth = { baseUrl, token: input.token };
    const provider = this.getProvider('gitlab');
    const [capabilities, projects] = await Promise.all([provider.testConnection(auth), provider.listProjects(auth)]);
    return {
      capabilities,
      allowlistEntries: projects.map((project) => ({
        entryType: 'project' as const,
        remoteId: project.remoteId,
        fullPath: project.fullPath,
        name: project.name,
        webUrl: project.webUrl,
      })),
    };
  }

  async listGitLabConnectorsForTool(user: User) {
    await this.assertGitLabConnectorAccess(user, 'integrations:gitlab:view', 'project.list', {
      auditAction: GITLAB_AUDIT_ACTIONS.projectList,
    });
    const rows = await this.listGitLabConnectors({ enabled: true });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      baseUrl: row.baseUrl,
      enabled: row.enabled,
      allowlistMode: row.allowlistMode,
      capabilities: row.capabilities,
      syncStatus: row.syncStatus,
      syncFinishedAt: row.syncFinishedAt,
    }));
  }

  async listGitLabProjectsForTool(user: User, input: { connectorId: string; search?: string; limit?: number }) {
    const row = await this.getConnectorRow(input.connectorId, 'gitlab');
    assertConnectorOperationAccess({
      actor: { userId: user.id, scopes: user.scopes },
      provider: 'gitlab',
      operation: 'project.list',
      requiredScope: 'integrations:gitlab:projects:view',
      capabilities: row.capabilities,
      requiredCapability: 'projectsView',
      connectorId: row.id,
      connectorName: row.name,
    });
    const limit = this.toolLimit(input.limit, 25, 100);
    const projects = await this.db
      .select()
      .from(integrationConnectorProjects)
      .where(eq(integrationConnectorProjects.connectorId, row.id))
      .orderBy(integrationConnectorProjects.fullPath)
      .limit(500);
    const allowlistRows = await this.listAllowlistRows(row.id);
    let allowedProjects = this.filterAllowedProjects(row, allowlistRows, projects);
    const credential = await this.resolveGitLabCredential(user, row);
    if (credential.source === 'personal') {
      const provider = this.gitLabProviderForCredential(user, row, credential);
      const visibleProjects = await provider.listProjects(credential.auth);
      const visibleIds = new Set(visibleProjects.map((project) => project.remoteId));
      allowedProjects = allowedProjects.filter((project) => visibleIds.has(project.remoteId));
    }
    const search = input.search?.trim().toLowerCase();
    const filtered = search
      ? allowedProjects.filter(
          (project) => project.fullPath.toLowerCase().includes(search) || project.name.toLowerCase().includes(search)
        )
      : allowedProjects;
    await this.auditGitLabTool(user, row, GITLAB_AUDIT_ACTIONS.projectList, {
      search: input.search ?? null,
      returned: Math.min(filtered.length, limit),
      totalMatched: filtered.length,
    });
    return {
      data: filtered.slice(0, limit).map((project) => this.toSafeProject(project)),
      total: filtered.length,
      truncated: filtered.length > limit,
    };
  }

  async getGitLabProjectForTool(user: User, input: { connectorId: string; project: string }) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:projects:view',
      requiredCapability: 'projectsView',
    });
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.projectList, {
      project: context.project.fullPath,
    });
    return this.toSafeProject(context.project);
  }

  async gitLabSyncConnectorForTool(user: User, input: { connectorId: string }) {
    await this.assertGitLabConnectorAccess(user, 'integrations:gitlab:sync', 'connector.sync');
    return this.syncGitLabConnector(input.connectorId, user.id);
  }

  async gitLabAddConnectorProjects(
    user: User,
    input: { connectorId: string; projects: string[]; syncAfter?: boolean }
  ) {
    const connector = await this.getConnectorRow(input.connectorId, 'gitlab');
    if (!connector.enabled) {
      throw new AppError(409, 'CONNECTOR_DISABLED', 'GitLab connector is disabled');
    }
    assertConnectorOperationAccess({
      actor: { userId: user.id, scopes: user.scopes },
      provider: 'gitlab',
      operation: 'connector.allowlist.update',
      requiredScope: 'integrations:gitlab:manage',
      capabilities: connector.capabilities,
      requiredCapability: 'projectsView',
      connectorId: connector.id,
      connectorName: connector.name,
    });

    const requested = [...new Set(input.projects.map((project) => project.trim()).filter(Boolean))];
    if (requested.length === 0) {
      throw new AppError(400, 'GITLAB_PROJECTS_REQUIRED', 'At least one GitLab project path or remote ID is required');
    }
    const provider = this.getProvider(connector.provider);
    const visibleProjects = await provider.listProjects(this.systemAuthFor(connector));
    await this.persistProjects(connector.id, visibleProjects);
    const visibleByKey = new Map<string, VcsProjectRef>();
    for (const project of visibleProjects) {
      visibleByKey.set(project.remoteId, project);
      visibleByKey.set(project.fullPath.toLowerCase(), project);
    }

    const missing = requested.filter(
      (project) => !visibleByKey.has(project) && !visibleByKey.has(project.toLowerCase())
    );
    if (missing.length > 0) {
      throw new AppError(
        404,
        'GITLAB_PROJECT_NOT_VISIBLE',
        'One or more GitLab projects are not visible to this connector',
        {
          missing,
        }
      );
    }

    const allowlistRows = await this.listAllowlistRows(connector.id);
    const matchedProjects = requested.map(
      (project) => visibleByKey.get(project) ?? visibleByKey.get(project.toLowerCase())!
    );
    const alreadyAllowed = matchedProjects.filter(
      (project) => connector.allowlistMode === 'all_visible' || this.isGitLabProjectAllowed(project, allowlistRows)
    );
    const toAdd = matchedProjects.filter(
      (project) => connector.allowlistMode !== 'all_visible' && !this.isGitLabProjectAllowed(project, allowlistRows)
    );

    if (toAdd.length > 0) {
      await this.replaceAllowlistEntries(connector.id, [
        ...allowlistRows.map((entry) => ({
          entryType: entry.entryType,
          remoteId: entry.remoteId,
          fullPath: entry.fullPath,
          name: entry.name ?? undefined,
          webUrl: entry.webUrl,
        })),
        ...toAdd.map((project) => ({
          entryType: 'project' as const,
          remoteId: project.remoteId,
          fullPath: project.fullPath,
          name: project.name,
          webUrl: project.webUrl ?? null,
        })),
      ]);
      this.emitConnector(connector.id, 'updated');
    }

    await this.auditGitLabTool(user, connector, GITLAB_AUDIT_ACTIONS.connectorAllowlistUpdate, {
      addedProjects: toAdd.map((project) => project.fullPath),
      alreadyAllowedProjects: alreadyAllowed.map((project) => project.fullPath),
      allowlistMode: connector.allowlistMode,
    });

    const syncResult = input.syncAfter ? await this.syncGitLabConnector(connector.id, user.id) : null;
    return {
      connectorId: connector.id,
      allowlistMode: connector.allowlistMode,
      added: toAdd.map((project) => this.toSafeProjectRef(connector.id, project)),
      alreadyAllowed: alreadyAllowed.map((project) => this.toSafeProjectRef(connector.id, project)),
      sync: syncResult,
    };
  }

  async gitLabUpdateProjectSettings(
    user: User,
    input: {
      connectorId: string;
      project: string;
      containerRegistryAccessLevel: 'enabled' | 'private' | 'disabled';
    }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:registry:manage',
      requiredCapability: 'deployTokensManage',
    });
    const result = await context.provider.updateProjectSettings(context.auth, this.toProviderProject(context.project), {
      containerRegistryAccessLevel: input.containerRegistryAccessLevel,
    });
    let syncResult: Awaited<ReturnType<IntegrationsService['syncGitLabConnector']>> | null = null;
    let syncError: { code: string; message: string; statusCode?: number } | null = null;
    try {
      syncResult = await this.syncGitLabConnector(context.connector.id, user.id);
    } catch (error) {
      syncError =
        error instanceof AppError
          ? { code: error.code, message: error.message, statusCode: error.statusCode }
          : { code: 'CONNECTOR_SYNC_FAILED', message: error instanceof Error ? error.message : String(error) };
    }
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.projectSettingsUpdate, {
      project: context.project.fullPath,
      settings: { containerRegistryAccessLevel: input.containerRegistryAccessLevel },
      syncStatus: syncResult?.status ?? 'error',
      syncError,
    });
    return { ...result, sync: syncResult, syncError };
  }

  async gitLabListRepositoryTree(
    user: User,
    input: { connectorId: string; project: string; path?: string; ref?: string; limit?: number }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:repo:read',
      requiredCapability: 'repoRead',
    });
    const entries = await context.provider.listTree(
      context.auth,
      this.toProviderProject(context.project),
      input.path ?? '',
      input.ref
    );
    const limit = this.toolLimit(input.limit, 100, 500);
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.repositoryTree, {
      project: context.project.fullPath,
      path: input.path ?? '',
      ref: input.ref ?? null,
      returned: Math.min(entries.length, limit),
    });
    return { data: entries.slice(0, limit), total: entries.length, truncated: entries.length > limit };
  }

  async gitLabReadFile(
    user: User,
    input: { connectorId: string; project: string; path: string; ref?: string; offset?: number; length?: number }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:repo:read',
      requiredCapability: 'repoRead',
    });
    const result = await context.provider.readFile(context.auth, {
      project: this.toProviderProject(context.project),
      path: input.path,
      ref: input.ref,
      offset: input.offset,
      length: input.length,
    });
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.fileRead, {
      project: context.project.fullPath,
      path: input.path,
      ref: input.ref ?? null,
      offset: result.offset,
      bytesRead: result.bytesRead,
      truncated: result.truncated,
    });
    return result;
  }

  async gitLabCommitFiles(
    user: User,
    input: {
      connectorId: string;
      project: string;
      branch: string;
      commitMessage: string;
      changes: VcsCommitFileChange[];
      startBranch?: string;
    }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:repo:write',
      requiredCapability: 'repoWrite',
    });
    const createdBranch = await this.assertPersonalGitLabWriteAccess(context, input.branch, input.startBranch);
    const executionAuth =
      context.credentialSource === 'personal' ? this.systemAuthFor(context.connector) : context.auth;
    const executionProvider = this.getVcsProvider(context.connector.provider);
    const result = await executionProvider.commitFiles(executionAuth, {
      project: this.toProviderProject(context.project),
      branch: input.branch,
      commitMessage: input.commitMessage,
      changes: input.changes,
      startBranch: createdBranch ? undefined : input.startBranch,
    });
    await this.auditGitLabTool(
      user,
      context.connector,
      GITLAB_AUDIT_ACTIONS.fileCommit,
      buildGitLabFileCommitAuditDetails({
        connectorId: context.connector.id,
        connectorName: context.connector.name,
        projectRemoteId: context.project.remoteId,
        projectFullPath: context.project.fullPath,
        branch: input.branch,
        actionCount: input.changes.length,
        filePaths: input.changes.map((change) => change.path),
        commitSha: result.commitSha,
      }) as Record<string, unknown>
    );
    return result;
  }

  async gitLabLintCiConfig(user: User, input: { connectorId: string; project: string; content: string }) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:ci:view',
      requiredCapability: 'ciLint',
    });
    const result = await context.provider.lintCiConfig(
      context.auth,
      this.toProviderProject(context.project),
      input.content
    );
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.ciLint, {
      project: context.project.fullPath,
      contentHash: hashGitLabDiff(input.content),
      valid: result.valid,
      errorCount: result.errors.length,
      warningCount: result.warnings.length,
    });
    return result;
  }

  async gitLabUpdateCiConfig(
    user: User,
    input: {
      connectorId: string;
      project: string;
      branch: string;
      content: string;
      commitMessage: string;
      startBranch?: string;
    }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:ci:edit',
      requiredCapability: 'ciEdit',
    });
    const executionAuth =
      context.credentialSource === 'personal' ? this.systemAuthFor(context.connector) : context.auth;
    const executionProvider = this.getVcsProvider(context.connector.provider);
    const lint = await executionProvider.lintCiConfig(
      executionAuth,
      this.toProviderProject(context.project),
      input.content
    );
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.ciLint, {
      project: context.project.fullPath,
      contentHash: hashGitLabDiff(input.content),
      valid: lint.valid,
      errorCount: lint.errors.length,
      warningCount: lint.warnings.length,
    });
    if (!lint.valid) {
      throw new AppError(
        400,
        'GITLAB_CI_LINT_FAILED',
        'GitLab CI config lint failed; refusing to commit invalid config',
        {
          errors: lint.errors,
          warnings: lint.warnings,
        }
      );
    }
    const createdBranch = await this.assertPersonalGitLabWriteAccess(context, input.branch, input.startBranch);
    const result = await executionProvider.commitFiles(executionAuth, {
      project: this.toProviderProject(context.project),
      branch: input.branch,
      startBranch: createdBranch ? undefined : input.startBranch,
      commitMessage: input.commitMessage,
      changes: [{ action: 'update', path: '.gitlab-ci.yml', content: input.content }],
    });
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.ciUpdate, {
      project: context.project.fullPath,
      branch: input.branch,
      contentHash: hashGitLabDiff(input.content),
      commitSha: result.commitSha,
    });
    return { ...result, lint };
  }

  async gitLabListPipelines(user: User, input: { connectorId: string; project: string; ref?: string; limit?: number }) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:ci:view',
      requiredCapability: 'pipelineRead',
    });
    const data = await context.provider.listPipelines(
      context.auth,
      this.toProviderProject(context.project),
      input.ref,
      this.toolLimit(input.limit, 20, 100)
    );
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.pipelineRead, {
      project: context.project.fullPath,
      ref: input.ref ?? null,
      returned: data.length,
    });
    return { data };
  }

  async gitLabGetPipeline(user: User, input: { connectorId: string; project: string; pipelineId: number }) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:ci:view',
      requiredCapability: 'pipelineRead',
    });
    const pipeline = await context.provider.getPipeline(
      context.auth,
      this.toProviderProject(context.project),
      input.pipelineId
    );
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.pipelineRead, {
      project: context.project.fullPath,
      pipelineId: input.pipelineId,
    });
    return pipeline;
  }

  async gitLabGetPipelineJobs(
    user: User,
    input: { connectorId: string; project: string; pipelineId: number; limit?: number }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:ci:view',
      requiredCapability: 'pipelineRead',
    });
    const data = await context.provider.listPipelineJobs(
      context.auth,
      this.toProviderProject(context.project),
      input.pipelineId,
      this.toolLimit(input.limit, 50, 100)
    );
    return { data };
  }

  async gitLabGetJobLog(
    user: User,
    input: { connectorId: string; project: string; jobId: number; limitBytes?: number }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:ci:view',
      requiredCapability: 'pipelineRead',
    });
    const result = await context.provider.getJobLog(
      context.auth,
      this.toProviderProject(context.project),
      input.jobId,
      Math.min(Math.max(input.limitBytes ?? 200_000, 1), 1_000_000)
    );
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.pipelineRead, {
      project: context.project.fullPath,
      jobId: input.jobId,
      bytesRead: result.bytesRead,
    });
    return result;
  }

  async gitLabListProjectVariables(user: User, input: { connectorId: string; project: string }) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:variables:view',
      requiredCapability: 'variablesView',
    });
    const data = await context.provider.listProjectVariables(context.auth, this.toProviderProject(context.project));
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.variableList, {
      project: context.project.fullPath,
      returned: data.length,
    });
    return { data };
  }

  async gitLabSetProjectVariable(
    user: User,
    input: {
      connectorId: string;
      project: string;
      key: string;
      value: string;
      variableType?: 'env_var' | 'file';
      protected?: boolean;
      masked?: boolean;
      raw?: boolean;
      environmentScope?: string;
      description?: string;
    }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:variables:edit',
      requiredCapability: 'variablesEdit',
    });
    const variable = await context.provider.setProjectVariable(
      context.auth,
      this.toProviderProject(context.project),
      input
    );
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.variableUpsert, {
      project: context.project.fullPath,
      key: input.key,
      valueHash: hashGitLabDiff(input.value),
      environmentScope: input.environmentScope ?? null,
      masked: input.masked ?? null,
      protected: input.protected ?? null,
    });
    return variable;
  }

  async gitLabDeleteProjectVariable(
    user: User,
    input: { connectorId: string; project: string; key: string; environmentScope?: string }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:variables:delete',
      requiredCapability: 'variablesDelete',
    });
    await context.provider.deleteProjectVariable(
      context.auth,
      this.toProviderProject(context.project),
      input.key,
      input.environmentScope
    );
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.variableDelete, {
      project: context.project.fullPath,
      key: input.key,
      environmentScope: input.environmentScope ?? null,
    });
    return { success: true };
  }

  async gitLabListProjectWebhooks(user: User, input: { connectorId: string; project: string }) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:webhooks:manage',
      requiredCapability: 'webhooksManage',
    });
    const data = await context.provider.listProjectWebhooks(context.auth, this.toProviderProject(context.project));
    return { data };
  }

  async gitLabCreateOrUpdateProjectWebhook(
    user: User,
    input: {
      connectorId: string;
      project: string;
      id?: number;
      url: string;
      token?: string;
      pushEvents?: boolean;
      mergeRequestsEvents?: boolean;
      tagPushEvents?: boolean;
      jobEvents?: boolean;
      pipelineEvents?: boolean;
      enableSslVerification?: boolean;
    }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:webhooks:manage',
      requiredCapability: 'webhooksManage',
    });
    const webhook = await context.provider.createOrUpdateProjectWebhook(
      context.auth,
      this.toProviderProject(context.project),
      input
    );
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.webhookManage, {
      project: context.project.fullPath,
      webhookId: webhook.id,
      url: webhook.url,
      tokenProvided: Boolean(input.token),
    });
    return webhook;
  }

  async gitLabDeleteProjectWebhook(user: User, input: { connectorId: string; project: string; hookId: number }) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:webhooks:manage',
      requiredCapability: 'webhooksManage',
    });
    await context.provider.deleteProjectWebhook(context.auth, this.toProviderProject(context.project), input.hookId);
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.webhookManage, {
      project: context.project.fullPath,
      hookId: input.hookId,
      deleted: true,
    });
    return { success: true };
  }

  async gitLabListRegistryRepositories(user: User, input: { connectorId: string; project: string }) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:registry:view',
      requiredCapability: 'registryView',
    });
    const data = await context.provider.listRegistryRepositories(context.auth, this.toProviderProject(context.project));
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.registryDiscover, {
      project: context.project.fullPath,
      returned: data.length,
    });
    return { data };
  }

  async gitLabCreateDeployToken(
    user: User,
    input: {
      connectorId: string;
      project: string;
      name: string;
      scopes: string[];
      expiresAt?: string;
      registryUrl?: string;
    }
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:registry:manage',
      requiredCapability: 'deployTokensManage',
    });
    const deployToken = await context.provider.createDeployToken(
      context.auth,
      this.toProviderProject(context.project),
      {
        name: input.name,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
      }
    );
    const [credential] = await this.db
      .insert(integrationConnectorCredentials)
      .values({
        connectorId: context.connector.id,
        credentialType: 'gitlab_deploy_token',
        name: deployToken.name,
        encryptedSecret: this.encryptToken(deployToken.token),
        secretLast4: this.tokenLast4(deployToken.token),
        username: deployToken.username,
        projectRemoteId: context.project.remoteId,
        projectFullPath: context.project.fullPath,
        registryUrl: input.registryUrl ?? null,
        scopes: deployToken.scopes,
        expiresAt: deployToken.expiresAt ? new Date(deployToken.expiresAt) : null,
        createdBy: user.id,
        metadata: { remoteDeployTokenId: deployToken.id },
      })
      .returning();
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.deployTokenCreate, {
      project: context.project.fullPath,
      credentialId: credential.id,
      username: deployToken.username,
      tokenLast4: this.tokenLast4(deployToken.token),
      scopes: deployToken.scopes,
      expiresAt: deployToken.expiresAt ?? null,
    });
    return {
      credentialId: credential.id,
      name: deployToken.name,
      username: deployToken.username,
      tokenMasked: `****${this.tokenLast4(deployToken.token)}`,
      scopes: deployToken.scopes,
      expiresAt: deployToken.expiresAt ?? null,
      project: context.project.fullPath,
      registryUrl: input.registryUrl ?? null,
    };
  }

  async gitLabCloneRepositoryToSandbox(
    user: User,
    input: { connectorId: string; project: string; ref?: string; targetPath?: string; ttlSeconds?: number },
    sandboxService: AISandboxService,
    conversationId?: string
  ) {
    const context = await this.resolveGitLabProjectContext(user, {
      connectorId: input.connectorId,
      project: input.project,
      requiredScope: 'integrations:gitlab:sandbox:clone',
      requiredCapability: 'repoRead',
    });
    assertConnectorOperationAccess({
      actor: { userId: user.id, scopes: user.scopes },
      provider: 'gitlab',
      operation: 'repository.clone.sandbox',
      requiredScope: 'ai:sandbox:use',
      connectorId: context.connector.id,
      connectorName: context.connector.name,
    });
    const targetPath = this.safeRelativePath(input.targetPath || this.slugPath(context.project.name || 'repository'));
    const archivePath = `.gateway/gitlab-${Date.now()}.tar.gz`;
    const connectorSettings = this.gitLabSettings(context.connector);
    const cloneTimeoutSeconds = Math.max(10, connectorSettings.cloneTimeoutSeconds);
    const effectiveTtlSeconds = Math.min(input.ttlSeconds ?? cloneTimeoutSeconds, cloneTimeoutSeconds);
    const processTtlSeconds = effectiveTtlSeconds + cloneTimeoutSeconds;
    const archive = await context.provider.downloadRepositoryArchive(
      context.auth,
      this.toProviderProject(context.project),
      input.ref,
      {
        maxBytes: connectorSettings.cloneMaxSizeMb * 1024 * 1024,
        timeoutMs: cloneTimeoutSeconds * 1000,
      }
    );
    if (archive.bytes.byteLength > connectorSettings.cloneMaxSizeMb * 1024 * 1024) {
      throw new AppError(413, 'GITLAB_ARCHIVE_TOO_LARGE', 'Repository archive exceeds connector clone size limit');
    }
    const command = [
      'sh',
      '-lc',
      [
        'set -eu',
        `while [ ! -f ${this.shellQuote(`/workspace/${archivePath}`)} ]; do sleep 0.2; done`,
        `mkdir -p ${this.shellQuote(`/workspace/${targetPath}`)}`,
        `tar -xzf ${this.shellQuote(`/workspace/${archivePath}`)} -C ${this.shellQuote(`/workspace/${targetPath}`)} --strip-components=1`,
        `rm -f ${this.shellQuote(`/workspace/${archivePath}`)}`,
        'echo CLONE_READY',
        `sleep ${effectiveTtlSeconds}`,
      ].join('; '),
    ];
    const process = await sandboxService.runProcess(user, {
      runtime: 'alpine',
      command,
      ttlSeconds: processTtlSeconds,
      conversationId,
    });
    await sandboxService.uploadArtifact(user, {
      processId: process.processId,
      path: archivePath,
      contentBase64: archive.bytes.toString('base64'),
    });
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.repositoryClone, {
      project: context.project.fullPath,
      ref: input.ref ?? null,
      targetPath,
      archiveBytes: archive.bytes.byteLength,
      processId: process.processId,
    });
    return {
      processId: process.processId,
      jobId: process.jobId,
      path: targetPath,
      ref: input.ref ?? context.project.defaultBranch ?? null,
      archiveBytes: archive.bytes.byteLength,
      status: 'extracting',
      nextStep:
        'Call read_process_output for CLONE_READY, then use list_artifact_files with this processId/path for repository structure and read_artifact for specific files. Do not start another sandbox process just to list or read cloned files.',
    };
  }

  private async assertGitLabConnectorAccess(
    user: User,
    requiredScope: string,
    operation: string,
    input: { auditAction?: string } = {}
  ) {
    assertConnectorOperationAccess({
      actor: { userId: user.id, scopes: user.scopes },
      provider: 'gitlab',
      operation,
      requiredScope,
    });
    if (input.auditAction) {
      await this.auditService.log({
        action: input.auditAction,
        userId: user.id,
        resourceType: 'integration-connector',
        details: { operation },
      });
    }
  }

  private async resolveGitLabProjectContext(
    user: User,
    input: {
      connectorId: string;
      project: string;
      requiredScope: string;
      requiredCapability?: keyof IntegrationConnectorCapabilities;
    }
  ) {
    let connector = await this.getConnectorRow(input.connectorId, 'gitlab');
    if (!connector.enabled) {
      throw new AppError(409, 'CONNECTOR_DISABLED', 'GitLab connector is disabled');
    }
    const [project] = await this.db
      .select()
      .from(integrationConnectorProjects)
      .where(
        and(
          eq(integrationConnectorProjects.connectorId, connector.id),
          input.project.includes('/') || Number.isNaN(Number(input.project))
            ? eq(integrationConnectorProjects.fullPath, input.project)
            : eq(integrationConnectorProjects.remoteId, input.project)
        )
      )
      .limit(1);
    if (!project) {
      throw new AppError(
        404,
        'GITLAB_PROJECT_NOT_FOUND',
        'GitLab project is not synced or not visible to this connector'
      );
    }
    const allowlistRows = await this.listAllowlistRows(connector.id);
    const isProjectAllowed =
      connector.allowlistMode === 'all_visible' || this.isGitLabProjectAllowed(project, allowlistRows);
    assertConnectorOperationAccess({
      actor: { userId: user.id, scopes: user.scopes },
      provider: 'gitlab',
      operation: input.requiredScope,
      requiredScope: input.requiredScope,
      connectorId: connector.id,
      connectorName: connector.name,
      project: { remoteId: project.remoteId, fullPath: project.fullPath, name: project.name },
      projectAllowed: isProjectAllowed,
    });
    const credential = await this.resolveGitLabCredential(user, connector);
    const provider = this.gitLabProviderForCredential(user, connector, credential);
    if (input.requiredCapability && connector.capabilities?.[input.requiredCapability] !== true) {
      const capabilities =
        credential.source === 'system'
          ? await this.refreshGitLabConnectorCapabilities(connector)
          : await provider.testConnection(credential.auth);
      connector = { ...connector, capabilities };
    }
    assertConnectorOperationAccess({
      actor: { userId: user.id, scopes: user.scopes },
      provider: 'gitlab',
      operation: input.requiredScope,
      requiredScope: input.requiredScope,
      capabilities: connector.capabilities,
      requiredCapability: input.requiredCapability,
      connectorId: connector.id,
      connectorName: connector.name,
      project: { remoteId: project.remoteId, fullPath: project.fullPath, name: project.name },
      projectAllowed: isProjectAllowed,
    });
    let projectAccess: VcsProjectAccess;
    try {
      projectAccess = await provider.getProjectAccess(credential.auth, this.toProviderProject(project));
    } catch (error) {
      if (error instanceof AppError && error.statusCode === 404) {
        throw new AppError(
          404,
          'GITLAB_PROJECT_NOT_VISIBLE',
          'GitLab project is not visible to the selected credential'
        );
      }
      throw error;
    }
    return {
      connector,
      project,
      auth: credential.auth,
      credentialSource: credential.source,
      credentialScopes: credential.scopes,
      projectAccessLevel: projectAccess.accessLevel,
      provider,
    };
  }

  private async assertPersonalGitLabWriteAccess(
    context: {
      credentialSource: GitLabCredentialSource;
      credentialScopes: string[];
      projectAccessLevel: number | null;
      auth: VcsConnectorAuth;
      provider: VcsConnectorProvider;
      project: ProjectRow;
    },
    branch: string,
    startBranch?: string
  ): Promise<boolean> {
    if (context.credentialSource === 'system') return false;
    const scopeAllowsWrite =
      context.credentialScopes.length === 0 ||
      context.credentialScopes.includes('api') ||
      context.credentialScopes.includes('write_repository');
    if (!scopeAllowsWrite || context.projectAccessLevel === null || context.projectAccessLevel < 30) {
      throw new AppError(
        403,
        'GITLAB_PERSONAL_WRITE_ACCESS_REQUIRED',
        'Your personal GitLab authorization does not have write access to this project'
      );
    }
    const branchAccess = await context.provider.getBranchAccess(
      context.auth,
      this.toProviderProject(context.project),
      branch
    );
    if (!branchAccess.exists) {
      if (!startBranch) {
        throw new AppError(
          400,
          'GITLAB_START_BRANCH_REQUIRED',
          'A start branch is required when creating a new GitLab branch'
        );
      }
      await context.provider.createBranch(context.auth, this.toProviderProject(context.project), branch, startBranch);
      return true;
    }
    if (!branchAccess.canPush) {
      throw new AppError(
        403,
        'GITLAB_PERSONAL_BRANCH_WRITE_ACCESS_REQUIRED',
        'Your personal GitLab authorization cannot push to this branch'
      );
    }
    return false;
  }

  private async resolveGitLabCredential(user: User, connector: ConnectorRow): Promise<ResolvedGitLabCredential> {
    if (hasScope(user.scopes, 'integrations:gitlab:system')) {
      return { source: 'system', auth: this.systemAuthFor(connector), scopes: [] };
    }
    const personal = await this.gitLabUserCredentials.resolveAuth(user.id, connector.id, connector.baseUrl);
    if (!personal) throw this.gitLabCredentialRequired(connector);
    return { source: 'personal', auth: personal.auth, scopes: personal.scopes };
  }

  private gitLabProviderForCredential(
    user: User,
    connector: ConnectorRow,
    credential: ResolvedGitLabCredential
  ): VcsConnectorProvider {
    const provider = this.getVcsProvider(connector.provider);
    if (credential.source === 'system') return provider;

    return new Proxy(provider, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        return async (...args: unknown[]) => {
          try {
            return await Reflect.apply(value, target, args);
          } catch (error) {
            if (error instanceof AppError && error.statusCode === 401) {
              await this.gitLabUserCredentials.markInvalid(user.id, connector.id);
              await this.auditService.log({
                action: GITLAB_AUDIT_ACTIONS.userCredentialInvalidate,
                userId: user.id,
                resourceType: 'integration-connector',
                resourceId: connector.id,
                details: { connectorName: connector.name },
              });
              throw this.gitLabCredentialRequired(connector, 'invalid');
            }
            throw error;
          }
        };
      },
    });
  }

  private gitLabCredentialRequired(connector: ConnectorRow, reason: 'missing' | 'invalid' = 'missing'): AppError {
    return new AppError(428, 'GITLAB_CREDENTIAL_REQUIRED', 'Personal GitLab authorization is required', {
      connectorId: connector.id,
      connectorName: connector.name,
      baseUrl: connector.baseUrl,
      patCreationUrl: this.gitLabPatCreationUrl(connector.baseUrl),
      reason,
    });
  }

  private async refreshGitLabConnectorCapabilities(connector: ConnectorRow): Promise<IntegrationConnectorCapabilities> {
    const provider = this.getProvider(connector.provider);
    const capabilities = await provider.testConnection(this.systemAuthFor(connector));
    await this.db
      .update(integrationConnectors)
      .set({ capabilities, testedAt: new Date(), updatedAt: new Date() })
      .where(eq(integrationConnectors.id, connector.id));
    return capabilities;
  }

  private toSafeProject(project: ProjectRow) {
    return {
      id: project.id,
      connectorId: project.connectorId,
      remoteId: project.remoteId,
      fullPath: project.fullPath,
      name: project.name,
      webUrl: project.webUrl,
      visibility: project.visibility,
      defaultBranch: project.defaultBranch,
      archived: project.archived,
      lastSeenAt: project.lastSeenAt,
      inaccessibleAt: project.inaccessibleAt,
    };
  }

  private toSafeProjectRef(connectorId: string, project: VcsProjectRef) {
    return {
      connectorId,
      remoteId: project.remoteId,
      fullPath: project.fullPath,
      name: project.name,
      webUrl: project.webUrl ?? null,
      visibility: project.visibility ?? null,
      defaultBranch: project.defaultBranch ?? null,
      archived: project.archived ?? false,
    };
  }

  private projectToAllowlistEntry(project: ProjectRow) {
    return {
      entryType: 'project' as const,
      remoteId: project.remoteId,
      fullPath: project.fullPath,
      name: project.name,
      webUrl: project.webUrl,
    };
  }

  private toProviderProject(project: ProjectRow): VcsProjectRef {
    return {
      remoteId: project.remoteId,
      fullPath: project.fullPath,
      name: project.name,
      webUrl: project.webUrl,
      visibility: project.visibility,
      defaultBranch: project.defaultBranch,
      archived: project.archived,
    };
  }

  private async auditGitLabTool(user: User, connector: ConnectorRow, action: string, details: Record<string, unknown>) {
    await this.auditService.log({
      action,
      userId: user.id,
      resourceType: 'integration-connector',
      resourceId: connector.id,
      details: redactGitLabAuditDetails({
        connectorId: connector.id,
        connectorName: connector.name,
        ...details,
      }) as Record<string, unknown>,
    });
  }

  private toolLimit(value: number | undefined, fallback: number, max: number) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.floor(value), 1), max);
  }

  private safeRelativePath(value: string) {
    const trimmed = value.trim().replace(/^\/+/, '');
    if (!trimmed || trimmed.includes('..') || trimmed.includes('\0')) {
      throw new AppError(400, 'INVALID_SANDBOX_PATH', 'Sandbox target path must be a relative path');
    }
    return trimmed;
  }

  private slugPath(value: string) {
    return (
      value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._/-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'repository'
    );
  }

  private shellQuote(value: string) {
    return `'${value.replace(/'/g, "'\"'\"'")}'`;
  }

  private async syncConnectorAfterCreate(provider: IntegrationProvider, id: string, userId: string) {
    try {
      if (provider === 'gitlab') {
        await this.syncGitLabConnector(id, userId);
      }
    } catch {
      // Sync methods persist failure state. Connector creation should not fail after the row exists.
    }
  }

  private async markCloudflareInitialSync(id: string, userId: string, name: string, zoneCount: number) {
    await this.db
      .update(integrationConnectors)
      .set({
        syncStatus: 'success',
        syncStartedAt: new Date(),
        syncFinishedAt: new Date(),
        syncFailureCount: 0,
        syncNextRetryAt: null,
        syncLastError: null,
        updatedAt: new Date(),
      })
      .where(eq(integrationConnectors.id, id));

    await this.auditService.log({
      action: CLOUDFLARE_AUDIT_ACTIONS.connectorSync,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: { name, zoneCount, source: 'connector.create' },
    });
    this.emitConnector(id, 'synced', 'cloudflare');
  }

  private async getConnectorRow(id: string, provider?: IntegrationProvider): Promise<ConnectorRow> {
    if (!UUID_RE.test(id)) {
      throw new AppError(400, 'INVALID_CONNECTOR_ID', 'connectorId must be a valid integration connector UUID');
    }
    const conditions: SQL[] = [eq(integrationConnectors.id, id)];
    if (provider) conditions.push(eq(integrationConnectors.provider, provider));
    const [row] = await this.db.select().from(integrationConnectors).where(buildWhere(conditions)).limit(1);
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Integration connector not found');
    return row;
  }

  private async listAllowlistRows(connectorId: string): Promise<AllowlistRow[]> {
    return this.db
      .select()
      .from(integrationConnectorAllowlistEntries)
      .where(eq(integrationConnectorAllowlistEntries.connectorId, connectorId))
      .orderBy(integrationConnectorAllowlistEntries.fullPath);
  }

  private async replaceAllowlistEntries(connectorId: string, entries: GitLabAllowlistEntryInput[]) {
    await this.db
      .delete(integrationConnectorAllowlistEntries)
      .where(eq(integrationConnectorAllowlistEntries.connectorId, connectorId));
    if (entries.length === 0) return;
    await this.db.insert(integrationConnectorAllowlistEntries).values(
      entries.map((entry) => ({
        connectorId,
        entryType: entry.entryType,
        remoteId: entry.remoteId,
        fullPath: entry.fullPath,
        name: entry.name ?? null,
        webUrl: entry.webUrl ?? null,
      }))
    );
  }

  private async persistProjects(connectorId: string, projects: ProjectRowInput[]) {
    const now = new Date();
    const seenRemoteIds = new Set(projects.map((project) => project.remoteId));
    for (const project of projects) {
      await this.db
        .insert(integrationConnectorProjects)
        .values({
          connectorId,
          remoteId: project.remoteId,
          fullPath: project.fullPath,
          name: project.name,
          webUrl: project.webUrl ?? null,
          visibility: project.visibility ?? null,
          defaultBranch: project.defaultBranch ?? null,
          archived: project.archived ?? false,
          lastSeenAt: now,
          inaccessibleAt: null,
          metadata: {},
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [integrationConnectorProjects.connectorId, integrationConnectorProjects.remoteId],
          set: {
            fullPath: project.fullPath,
            name: project.name,
            webUrl: project.webUrl ?? null,
            visibility: project.visibility ?? null,
            defaultBranch: project.defaultBranch ?? null,
            archived: project.archived ?? false,
            lastSeenAt: now,
            inaccessibleAt: null,
            updatedAt: now,
          },
        });
    }

    const existing = await this.db
      .select()
      .from(integrationConnectorProjects)
      .where(eq(integrationConnectorProjects.connectorId, connectorId));
    for (const project of existing) {
      if (seenRemoteIds.has(project.remoteId) || project.inaccessibleAt) continue;
      await this.db
        .update(integrationConnectorProjects)
        .set({ inaccessibleAt: now, updatedAt: now })
        .where(eq(integrationConnectorProjects.id, project.id));
    }
  }

  private async persistRegistries(connectorId: string, registries: RegistryRowInput[]) {
    const now = new Date();
    const seenUrls = new Set(registries.map((registry) => registry.registryUrl));
    for (const registry of registries) {
      await this.db
        .insert(integrationConnectorRegistries)
        .values({
          connectorId,
          remoteRegistryId: registry.remoteRegistryId ?? null,
          projectRemoteId: registry.projectRemoteId ?? null,
          projectFullPath: registry.projectFullPath ?? null,
          registryUrl: registry.registryUrl,
          name: registry.name,
          status: 'available',
          lastSeenAt: now,
          inaccessibleAt: null,
          metadata: {},
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [integrationConnectorRegistries.connectorId, integrationConnectorRegistries.registryUrl],
          set: {
            remoteRegistryId: registry.remoteRegistryId ?? null,
            projectRemoteId: registry.projectRemoteId ?? null,
            projectFullPath: registry.projectFullPath ?? null,
            name: registry.name,
            status: 'available',
            lastSeenAt: now,
            inaccessibleAt: null,
            updatedAt: now,
          },
        });
    }

    const existing = await this.db
      .select()
      .from(integrationConnectorRegistries)
      .where(eq(integrationConnectorRegistries.connectorId, connectorId));
    for (const registry of existing) {
      if (seenUrls.has(registry.registryUrl) || registry.inaccessibleAt) continue;
      await this.db
        .update(integrationConnectorRegistries)
        .set({ status: 'inaccessible', inaccessibleAt: now, updatedAt: now })
        .where(eq(integrationConnectorRegistries.id, registry.id));
    }
  }

  private async listCloudflareZoneRows(connectorId: string): Promise<CloudflareZoneRow[]> {
    return this.db
      .select()
      .from(integrationConnectorCloudflareZones)
      .where(eq(integrationConnectorCloudflareZones.connectorId, connectorId))
      .orderBy(integrationConnectorCloudflareZones.name);
  }

  private async persistCloudflareZones(connectorId: string, zones: CloudflareZoneInput[]) {
    const now = new Date();
    await this.db
      .delete(integrationConnectorCloudflareZones)
      .where(eq(integrationConnectorCloudflareZones.connectorId, connectorId));
    if (zones.length === 0) return;

    await this.db.insert(integrationConnectorCloudflareZones).values(
      zones.map((zone) => ({
        connectorId,
        remoteId: zone.id,
        name: zone.name,
        status: zone.status ?? null,
        accountId: zone.account?.id ?? null,
        accountName: zone.account?.name ?? null,
        lastSeenAt: now,
        metadata: {},
        updatedAt: now,
      }))
    );
  }

  private async testCloudflareToken(token: string) {
    const client = new CloudflareClient(token);
    const tokenStatus = await client.verifyToken();
    if (tokenStatus.status && tokenStatus.status !== 'active') {
      throw new AppError(400, 'CLOUDFLARE_TOKEN_INACTIVE', 'Cloudflare token is not active', {
        status: tokenStatus.status,
      });
    }
    let zones: CloudflareZoneRef[];
    try {
      zones = await client.listZones();
    } catch (error) {
      if (!this.isCloudflarePermissionError(error)) throw error;
      throw new AppError(
        400,
        'CLOUDFLARE_ZONE_READ_REQUIRED',
        'Cloudflare token must include Zone:Read permission for the zones Gateway should manage',
        { cause: error instanceof Error ? error.message : String(error) }
      );
    }
    const probeZone = zones[0];
    if (!probeZone) {
      throw new AppError(400, 'CLOUDFLARE_ZONE_NOT_FOUND', 'Cloudflare token has no active zones');
    }
    try {
      await client.listDnsRecords(probeZone.id);
    } catch (error) {
      if (!this.isCloudflarePermissionError(error)) throw error;
      throw new AppError(
        400,
        'CLOUDFLARE_DNS_READ_REQUIRED',
        'Cloudflare token must include DNS:Read permission for Gateway-managed zones',
        { zone: probeZone.name, cause: error instanceof Error ? error.message : String(error) }
      );
    }
    let probeRecordId: string | null = null;
    let cleanupError: unknown = null;
    try {
      let probeRecord: CloudflareDnsRecord;
      try {
        probeRecord = await client.createDnsRecord(probeZone.id, {
          type: 'TXT',
          name: `_gateway-permission-check.${probeZone.name}`,
          content: `gateway-${Date.now()}`,
          ttl: 60,
          comment: 'Gateway permission check',
        });
      } catch (error) {
        if (!this.isCloudflarePermissionError(error)) throw error;
        throw new AppError(
          400,
          'CLOUDFLARE_DNS_EDIT_REQUIRED',
          'Cloudflare token must include DNS:Edit permission for Gateway-managed zones',
          { zone: probeZone.name, cause: error instanceof Error ? error.message : String(error) }
        );
      }
      probeRecordId = probeRecord.id;
    } finally {
      if (probeRecordId) {
        try {
          await client.deleteDnsRecord(probeZone.id, probeRecordId);
        } catch (error) {
          cleanupError = error;
        }
      }
    }
    if (cleanupError) {
      throw new AppError(400, 'CLOUDFLARE_DNS_PROBE_CLEANUP_FAILED', 'Cloudflare DNS probe cleanup failed', {
        zone: probeZone.name,
        error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
    }
    return {
      capabilities: {
        apiReachable: true,
        tokenActive: true,
        zonesRead: true,
        dnsRead: true,
        dnsEdit: true,
      },
      zones,
    };
  }

  private isCloudflarePermissionError(error: unknown): boolean {
    return error instanceof AppError && (error.statusCode === 401 || error.statusCode === 403);
  }

  private shouldDisableCloudflareAutoRenew(error: unknown): boolean {
    if (!(error instanceof AppError)) return false;
    return [
      'CLOUDFLARE_TOKEN_INACTIVE',
      'CLOUDFLARE_ZONE_READ_REQUIRED',
      'CLOUDFLARE_ZONE_NOT_FOUND',
      'CLOUDFLARE_DNS_READ_REQUIRED',
      'CLOUDFLARE_DNS_EDIT_REQUIRED',
    ].includes(error.code);
  }

  private cloudflareZonePreview(zone: CloudflareZoneRef) {
    return {
      remoteId: zone.id,
      name: zone.name,
      status: zone.status ?? null,
      accountId: zone.account?.id ?? null,
      accountName: zone.account?.name ?? null,
    };
  }

  private toSafeConnector(row: ConnectorRow): SafeIntegrationConnector {
    const { encryptedToken: _encryptedToken, ...safe } = row;
    return {
      ...safe,
      hasToken: Boolean(row.encryptedToken),
      tokenMasked: row.tokenLast4 ? `****${row.tokenLast4}` : null,
    };
  }

  private mergeSettings(
    patch: Partial<IntegrationConnectorSettings> | undefined,
    base: IntegrationConnectorSettings = DEFAULT_GITLAB_CONNECTOR_SETTINGS
  ): IntegrationConnectorSettings {
    return { ...DEFAULT_GITLAB_CONNECTOR_SETTINGS, ...base, ...patch };
  }

  private gitLabSettings(row: ConnectorRow): IntegrationConnectorSettings {
    return this.mergeSettings(undefined, row.settings as IntegrationConnectorSettings);
  }

  private mergeCloudflareSettings(
    patch: Partial<CloudflareConnectorSettings> | undefined,
    base: IntegrationConnectorSettingsValue = DEFAULT_CLOUDFLARE_CONNECTOR_SETTINGS
  ): CloudflareConnectorSettings {
    return { ...DEFAULT_CLOUDFLARE_CONNECTOR_SETTINGS, ...base, ...patch };
  }

  private filterAllowedProjects<T extends Pick<ProjectRow, 'remoteId' | 'fullPath' | 'name'>>(
    row: ConnectorRow,
    allowlistEntries: AllowlistRow[],
    projects: T[]
  ): T[] {
    if (row.allowlistMode === 'all_visible') return projects;
    return projects.filter((project) => this.isGitLabProjectAllowed(project, allowlistEntries));
  }

  private filterAllowedRegistries(
    row: ConnectorRow,
    allowlistEntries: AllowlistRow[],
    projects: ProjectRowInput[],
    registries: RegistryRowInput[]
  ): RegistryRowInput[] {
    if (row.allowlistMode === 'all_visible') return registries;
    const allowedProjectIds = new Set(projects.map((project) => project.remoteId));
    return registries.filter((registry) => {
      if (registry.projectRemoteId && allowedProjectIds.has(registry.projectRemoteId)) return true;
      if (!registry.projectFullPath) return false;
      return this.isGitLabProjectAllowed(
        {
          remoteId: registry.projectRemoteId ?? '',
          fullPath: registry.projectFullPath,
          name: registry.name,
        },
        allowlistEntries
      );
    });
  }

  isGitLabProjectAllowed(
    project: Pick<ProjectRow, 'remoteId' | 'fullPath' | 'name'>,
    allowlistEntries: AllowlistRow[]
  ) {
    return allowlistEntries.some((entry) => {
      if (entry.entryType === 'project') return entry.remoteId === project.remoteId;
      return project.fullPath === entry.fullPath || project.fullPath.startsWith(`${entry.fullPath}/`);
    });
  }

  private normalizeBaseUrl(rawUrl: string): string {
    const parsed = new URL(rawUrl.trim());
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/+$/, '');
  }

  private encryptToken(token: string): string {
    return JSON.stringify(this.cryptoService.encryptString(token));
  }

  private decryptToken(encryptedToken: string): string {
    return this.cryptoService.decryptString(JSON.parse(encryptedToken));
  }

  private tokenLast4(token: string): string {
    return token.slice(-4);
  }

  private gitLabPatCreationUrl(baseUrl: string): string {
    const url = new URL('/-/user_settings/personal_access_tokens', `${baseUrl}/`);
    url.searchParams.set('name', 'Gateway AI');
    url.searchParams.set('description', 'Personal token for Gateway AI tools');
    url.searchParams.set('scopes', 'api');
    return url.toString();
  }

  private systemAuthFor(row: ConnectorRow): VcsConnectorAuth {
    if (!row.encryptedToken) {
      throw new AppError(400, 'CONNECTOR_TOKEN_MISSING', 'GitLab connector token is not configured');
    }
    return { baseUrl: row.baseUrl, token: this.decryptToken(row.encryptedToken) };
  }

  private cloudflareTokenFor(row: ConnectorRow): string {
    if (!row.encryptedToken) {
      throw new AppError(400, 'CONNECTOR_TOKEN_MISSING', 'Cloudflare connector token is not configured');
    }
    return this.decryptToken(row.encryptedToken);
  }

  private isDueForSync(row: ConnectorRow, now: Date): boolean {
    if (row.syncNextRetryAt && row.syncNextRetryAt > now) return false;
    const lastCompleted = row.syncFinishedAt ?? row.testedAt ?? null;
    if (!lastCompleted) return true;
    return now.getTime() - lastCompleted.getTime() >= row.settings.autoSyncIntervalSeconds * 1000;
  }

  private isSyncRunning(row: ConnectorRow): boolean {
    if (row.syncStatus !== 'running' || !row.syncStartedAt) return false;
    return Date.now() - row.syncStartedAt.getTime() < STALE_SYNC_SECONDS * 1000;
  }

  private async recordSyncOverlap(id: string) {
    await this.db
      .update(integrationConnectors)
      .set({ syncLastOverlapAt: new Date(), updatedAt: new Date() })
      .where(eq(integrationConnectors.id, id));
  }

  private backoffSeconds(failureCount: number): number {
    return Math.min(MAX_BACKOFF_SECONDS, 60 * 2 ** Math.max(0, failureCount - 1));
  }

  private getProvider(provider: IntegrationProvider): ConnectorProvider {
    const implementation = this.providers.get(provider);
    if (!implementation) {
      throw new AppError(
        501,
        'CONNECTOR_PROVIDER_UNAVAILABLE',
        `The ${provider} connector provider is not available yet`
      );
    }
    return implementation;
  }

  private getVcsProvider(provider: IntegrationProvider): VcsConnectorProvider {
    const implementation = this.getProvider(provider);
    if (
      !('readFile' in implementation) ||
      !('commitFiles' in implementation) ||
      !('updateProjectSettings' in implementation) ||
      !('downloadRepositoryArchive' in implementation)
    ) {
      throw new AppError(501, 'CONNECTOR_VCS_PROVIDER_UNAVAILABLE', `The ${provider} VCS provider is not available`);
    }
    return implementation as VcsConnectorProvider;
  }

  private dedupeAllowlistEntries(entries: GitLabAllowlistEntryInput[]): GitLabAllowlistEntryInput[] {
    const keyed = new Map<string, GitLabAllowlistEntryInput>();
    for (const entry of entries) {
      keyed.set(`${entry.entryType}:${entry.remoteId}`, entry);
    }
    return [...keyed.values()];
  }

  private emitConnector(id: string, action: string, provider: IntegrationProvider = 'gitlab') {
    this.eventBus?.publish('integration.connector.changed', { id, provider, action });
  }
}

type ProjectRowInput = {
  remoteId: string;
  fullPath: string;
  name: string;
  webUrl?: string | null;
  visibility?: string | null;
  defaultBranch?: string | null;
  archived?: boolean;
};

type RegistryRowInput = {
  remoteRegistryId?: string | null;
  projectRemoteId?: string | null;
  projectFullPath?: string | null;
  registryUrl: string;
  name: string;
};

type CloudflareZoneInput = CloudflareZoneRef;
