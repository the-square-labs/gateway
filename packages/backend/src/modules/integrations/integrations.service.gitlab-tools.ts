import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { User } from '@/types.js';
import type { VcsCommitFileChange } from './integration-provider.types.js';
import { IntegrationsCloudflareService } from './integrations.service.cloudflare.js';

// Public contract only. The commercial package supplies paid implementations.
export class IntegrationsGitLabToolService extends IntegrationsCloudflareService {
  async searchGitLabAllowlist(
    _id: string,
    _query: string
  ): Promise<import('./integration-provider.types.js').VcsAllowlistSearchResult[]> {
    return commercialModuleUnavailable();
  }
  async listGitLabAllowlistOptions(_id: string): Promise<
    {
      entryType: 'project';
      remoteId: string;
      fullPath: string;
      name: string;
      webUrl: string | null;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async refreshGitLabAllowlistOptions(
    _id: string,
    _userId: string
  ): Promise<
    {
      entryType: 'project';
      remoteId: string;
      fullPath: string;
      name: string;
      webUrl: string | null;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async searchGitLabAllowlistPreview(_input: {
    baseUrl: string;
    token: string;
    q: string;
  }): Promise<import('./integration-provider.types.js').VcsAllowlistSearchResult[]> {
    return commercialModuleUnavailable();
  }
  async testGitLabConnectorPreview(_input: { baseUrl: string; token: string }): Promise<{
    capabilities: import('@/db/schema/index.js').IntegrationConnectorCapabilities;
    allowlistEntries: {
      entryType: 'project';
      remoteId: string;
      fullPath: string;
      name: string;
      webUrl: string | null | undefined;
    }[];
  }> {
    return commercialModuleUnavailable();
  }
  async listGitLabConnectorsForTool(_user: User): Promise<
    {
      id: string;
      name: string;
      baseUrl: string;
      enabled: boolean;
      allowlistMode: import('@/db/schema/index.js').IntegrationAllowlistMode;
      capabilities: import('@/db/schema/index.js').IntegrationConnectorCapabilities;
      syncStatus: import('@/db/schema/index.js').IntegrationSyncStatus;
      syncFinishedAt: Date | null;
    }[]
  > {
    return commercialModuleUnavailable();
  }
  async listGitLabProjectsForTool(
    _user: User,
    _input: {
      connectorId: string;
      search?: string;
      limit?: number;
    }
  ): Promise<{
    data: {
      id: string;
      connectorId: string;
      remoteId: string;
      fullPath: string;
      name: string;
      webUrl: string | null;
      visibility: string | null;
      defaultBranch: string | null;
      archived: boolean;
      lastSeenAt: Date;
      inaccessibleAt: Date | null;
    }[];
    total: number;
    truncated: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async getGitLabProjectForTool(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
    }
  ): Promise<{
    id: string;
    connectorId: string;
    remoteId: string;
    fullPath: string;
    name: string;
    webUrl: string | null;
    visibility: string | null;
    defaultBranch: string | null;
    archived: boolean;
    lastSeenAt: Date;
    inaccessibleAt: Date | null;
  }> {
    return commercialModuleUnavailable();
  }
  async gitLabSyncConnectorForTool(
    _user: User,
    _input: {
      connectorId: string;
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
  async gitLabAddConnectorProjects(
    _user: User,
    _input: {
      connectorId: string;
      projects: string[];
      syncAfter?: boolean;
    }
  ): Promise<{
    connectorId: string;
    allowlistMode: import('@/db/schema/index.js').IntegrationAllowlistMode;
    added: {
      connectorId: string;
      remoteId: string;
      fullPath: string;
      name: string;
      webUrl: string | null;
      visibility: string | null;
      defaultBranch: string | null;
      archived: boolean;
    }[];
    alreadyAllowed: {
      connectorId: string;
      remoteId: string;
      fullPath: string;
      name: string;
      webUrl: string | null;
      visibility: string | null;
      defaultBranch: string | null;
      archived: boolean;
    }[];
    sync:
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
      | null;
  }> {
    return commercialModuleUnavailable();
  }
  async gitLabUpdateProjectSettings(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      containerRegistryAccessLevel: 'enabled' | 'private' | 'disabled';
    }
  ): Promise<{
    sync:
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
      | null;
    syncError: {
      code: string;
      message: string;
      statusCode?: number;
    } | null;
    remoteId: string;
    fullPath: string;
    name: string;
    webUrl?: string | null;
    containerRegistryAccessLevel?: string | null;
  }> {
    return commercialModuleUnavailable();
  }
  async gitLabListRepositoryTree(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      path?: string;
      ref?: string;
      limit?: number;
    }
  ): Promise<{
    data: import('./integration-provider.types.js').VcsTreeEntry[];
    total: number;
    truncated: boolean;
  }> {
    return commercialModuleUnavailable();
  }
  async gitLabReadFile(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      path: string;
      ref?: string;
      offset?: number;
      length?: number;
    }
  ): Promise<import('./integration-provider.types.js').VcsFileReadResult> {
    return commercialModuleUnavailable();
  }
  async gitLabCommitFiles(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      branch: string;
      commitMessage: string;
      changes: VcsCommitFileChange[];
      startBranch?: string;
    }
  ): Promise<import('./integration-provider.types.js').VcsCommitResult> {
    return commercialModuleUnavailable();
  }
  async gitLabLintCiConfig(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      content: string;
    }
  ): Promise<import('./integration-provider.types.js').VcsCiLintResult> {
    return commercialModuleUnavailable();
  }
  async gitLabUpdateCiConfig(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      branch: string;
      content: string;
      commitMessage: string;
      startBranch?: string;
    }
  ): Promise<{
    lint: import('./integration-provider.types.js').VcsCiLintResult;
    commitSha: string;
    webUrl?: string | null;
  }> {
    return commercialModuleUnavailable();
  }
}
