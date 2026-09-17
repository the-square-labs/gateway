import { and, eq } from 'drizzle-orm';
import { type IntegrationConnectorCapabilities, integrationConnectors } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { GitLabConnectorCreateInput, GitLabConnectorUpdateInput } from './integrations.schemas.js';
import { GITHUB_HEALTH_CHECK_INTERVAL_MS } from './integrations.service.core.js';
import { IntegrationsGitConnectorService } from './integrations.service.git-connectors.js';

// Public contract only. The commercial package supplies paid implementations.
export class IntegrationsGitLabConnectorService extends IntegrationsGitConnectorService {
  async getGitLabConnector(_id: string): Promise<{
    allowlistEntries: {
      id: string;
      name: string | null;
      createdAt: Date;
      updatedAt: Date;
      connectorId: string;
      remoteId: string;
      fullPath: string;
      webUrl: string | null;
      entryType: import('@/db/schema/index.js').IntegrationAllowlistEntryType;
    }[];
    hasToken: boolean;
    tokenMasked: string | null;
    id: string;
    name: string;
    provider: import('@/db/schema/index.js').IntegrationProvider;
    baseUrl: string;
    enabled: boolean;
    authMode: import('@/db/schema/index.js').IntegrationConnectorAuthMode;
    username: string | null;
    tokenLast4: string | null;
    tokenExpiresAt: Date | null;
    refreshTokenExpiresAt: Date | null;
    allowlistMode: import('@/db/schema/index.js').IntegrationAllowlistMode;
    settings: import('@/db/schema/index.js').IntegrationConnectorSettingsValue;
    capabilities: IntegrationConnectorCapabilities;
    syncStatus: import('@/db/schema/index.js').IntegrationSyncStatus;
    syncLastError: string | null;
    syncFailureCount: number;
    syncStartedAt: Date | null;
    syncFinishedAt: Date | null;
    syncLastOverlapAt: Date | null;
    syncNextRetryAt: Date | null;
    testedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async createGitLabConnector(
    _input: GitLabConnectorCreateInput,
    _userId: string
  ): Promise<{
    allowlistEntries: {
      id: string;
      name: string | null;
      createdAt: Date;
      updatedAt: Date;
      connectorId: string;
      remoteId: string;
      fullPath: string;
      webUrl: string | null;
      entryType: import('@/db/schema/index.js').IntegrationAllowlistEntryType;
    }[];
    hasToken: boolean;
    tokenMasked: string | null;
    id: string;
    name: string;
    provider: import('@/db/schema/index.js').IntegrationProvider;
    baseUrl: string;
    enabled: boolean;
    authMode: import('@/db/schema/index.js').IntegrationConnectorAuthMode;
    username: string | null;
    tokenLast4: string | null;
    tokenExpiresAt: Date | null;
    refreshTokenExpiresAt: Date | null;
    allowlistMode: import('@/db/schema/index.js').IntegrationAllowlistMode;
    settings: import('@/db/schema/index.js').IntegrationConnectorSettingsValue;
    capabilities: IntegrationConnectorCapabilities;
    syncStatus: import('@/db/schema/index.js').IntegrationSyncStatus;
    syncLastError: string | null;
    syncFailureCount: number;
    syncStartedAt: Date | null;
    syncFinishedAt: Date | null;
    syncLastOverlapAt: Date | null;
    syncNextRetryAt: Date | null;
    testedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async updateGitLabConnector(
    _id: string,
    _input: GitLabConnectorUpdateInput,
    _userId: string
  ): Promise<{
    allowlistEntries: {
      id: string;
      name: string | null;
      createdAt: Date;
      updatedAt: Date;
      connectorId: string;
      remoteId: string;
      fullPath: string;
      webUrl: string | null;
      entryType: import('@/db/schema/index.js').IntegrationAllowlistEntryType;
    }[];
    hasToken: boolean;
    tokenMasked: string | null;
    id: string;
    name: string;
    provider: import('@/db/schema/index.js').IntegrationProvider;
    baseUrl: string;
    enabled: boolean;
    authMode: import('@/db/schema/index.js').IntegrationConnectorAuthMode;
    username: string | null;
    tokenLast4: string | null;
    tokenExpiresAt: Date | null;
    refreshTokenExpiresAt: Date | null;
    allowlistMode: import('@/db/schema/index.js').IntegrationAllowlistMode;
    settings: import('@/db/schema/index.js').IntegrationConnectorSettingsValue;
    capabilities: IntegrationConnectorCapabilities;
    syncStatus: import('@/db/schema/index.js').IntegrationSyncStatus;
    syncLastError: string | null;
    syncFailureCount: number;
    syncStartedAt: Date | null;
    syncFinishedAt: Date | null;
    syncLastOverlapAt: Date | null;
    syncNextRetryAt: Date | null;
    testedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }> {
    return commercialModuleUnavailable();
  }
  async rotateGitLabConnectorToken(
    _id: string,
    _token: string,
    _userId: string
  ): Promise<import('./integrations.service.core.js').SafeIntegrationConnector> {
    return commercialModuleUnavailable();
  }
  async deleteGitLabConnector(_id: string, _userId: string): Promise<void> {
    return commercialModuleUnavailable();
  }
  async getGitLabConnectorCapabilities(_id: string): Promise<IntegrationConnectorCapabilities> {
    return commercialModuleUnavailable();
  }
  async testGitLabConnector(
    _id: string,
    _userId: string
  ): Promise<import('./integrations.service.core.js').SafeIntegrationConnector> {
    return commercialModuleUnavailable();
  }
  async syncGitLabConnector(
    _id: string,
    _userId: string | null,
    _options?: {
      scheduled?: boolean;
    }
  ): Promise<
    | {
        status: string;
        reason: string;
        projectCount?: undefined;
        registryCount?: undefined;
        skippedRegistryProjects?: undefined;
      }
    | {
        status: string;
        projectCount: number;
        registryCount: number;
        skippedRegistryProjects: import('./integration-provider.types.js').VcsRegistryDiscoverySkippedProject[];
        reason?: undefined;
      }
  > {
    return commercialModuleUnavailable();
  }
  async runDueGitLabSyncs(): Promise<void> {
    return commercialModuleUnavailable();
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
