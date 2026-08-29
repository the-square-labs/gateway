import { and, eq } from 'drizzle-orm';
import { type IntegrationConnectorCapabilities, integrationConnectors } from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import { hasConfiguredLicenseFeature } from '@/modules/license/license-policy.service.js';
import { GITLAB_AUDIT_ACTIONS } from './integration-audit.js';
import type { GitLabConnectorCreateInput, GitLabConnectorUpdateInput } from './integrations.schemas.js';
import { GITHUB_HEALTH_CHECK_INTERVAL_MS } from './integrations.service.core.js';
import { IntegrationsGitConnectorService } from './integrations.service.git-connectors.js';

export class IntegrationsGitLabConnectorService extends IntegrationsGitConnectorService {
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
      const registryDiscoveryEnabled = await hasConfiguredLicenseFeature(this.licensePolicy, 'registry-discovery');
      const registryDiscovery = registryDiscoveryEnabled
        ? await provider.listRegistries(auth, projects)
        : { registries: [], skippedProjects: [] };
      const registries = registryDiscoveryEnabled
        ? this.filterAllowedRegistries(row, allowlistEntries, projects, registryDiscovery.registries)
        : [];
      await this.persistProjects(id, allProjects);
      if (registryDiscoveryEnabled) {
        // LICENSE ENFORCEMENT: Automatic registry discovery/import requires Personal under the project license/TOS.
        await this.persistRegistries(id, registries);
        await this.dockerRegistryService?.reconcileGitLabConnectorRegistries(id);
      }
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

      this.emitConnector(id, 'synced', 'gitlab', { name: row.name, failureCount: 0 });
      if (registryDiscoveryEnabled) this.emitConnector(id, 'registries-synced');
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
      this.emitConnector(id, 'sync-failed', 'gitlab', {
        name: row.name,
        failureCount,
        failureCode: this.connectorFailureCode(error),
      });
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

  async runDueGitHubHealthChecks() {
    const rows = await this.db
      .select()
      .from(integrationConnectors)
      .where(and(eq(integrationConnectors.provider, 'github'), eq(integrationConnectors.enabled, true)));
    const now = Date.now();
    for (const row of rows) {
      if (row.testedAt && now - row.testedAt.getTime() < GITHUB_HEALTH_CHECK_INTERVAL_MS) continue;
      try {
        await this.testGitConnector('github', row.id, null);
      } catch {
        // testGitConnector persists the failed health state; continue with the remaining connectors.
      }
    }
  }
}
