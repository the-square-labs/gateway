import type { IntegrationConnectorCapabilities } from '@/db/schema/index.js';
import { commercialModuleUnavailable } from '@/edition/unavailable.js';
import type { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import type { VcsConnectorAuth, VcsConnectorProvider, VcsProjectRef } from './integration-provider.types.js';
import type {
  ConnectorRow,
  GitLabCredentialSource,
  ProjectRow,
  ResolvedGitLabCredential,
} from './integrations.service.core.js';
import { IntegrationsGitSupportService } from './integrations.service.git-support.js';

// Public contract only. The commercial package supplies paid implementations.
export abstract class IntegrationsGitLabSupportService extends IntegrationsGitSupportService {
  protected async assertGitLabConnectorAccess(
    _user: User,
    _requiredScope: string,
    _operation: string,
    _input?: {
      auditAction?: string;
    }
  ): Promise<void> {
    return commercialModuleUnavailable();
  }
  protected async resolveGitLabProjectContext(
    _user: User,
    _input: {
      connectorId: string;
      project: string;
      requiredScope: string;
      requiredCapability?: keyof IntegrationConnectorCapabilities;
    }
  ): Promise<{
    connector: {
      id: string;
      name: string;
      provider: import('@/db/schema/index.js').IntegrationProvider;
      baseUrl: string;
      enabled: boolean;
      authMode: import('@/db/schema/index.js').IntegrationConnectorAuthMode;
      username: string | null;
      encryptedToken: string | null;
      encryptedRefreshToken: string | null;
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
    };
    project: {
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
      metadata: Record<string, unknown>;
      createdAt: Date;
      updatedAt: Date;
    };
    auth: VcsConnectorAuth;
    credentialSource: GitLabCredentialSource;
    credentialScopes: string[];
    projectAccessLevel: number | null;
    provider: VcsConnectorProvider;
  }> {
    return commercialModuleUnavailable();
  }
  protected async assertPersonalGitLabWriteAccess(
    _context: {
      credentialSource: GitLabCredentialSource;
      credentialScopes: string[];
      projectAccessLevel: number | null;
      auth: VcsConnectorAuth;
      provider: VcsConnectorProvider;
      project: ProjectRow;
    },
    _branch: string,
    _startBranch?: string
  ): Promise<boolean> {
    return commercialModuleUnavailable();
  }
  protected async resolveGitLabCredential(_user: User, _connector: ConnectorRow): Promise<ResolvedGitLabCredential> {
    return commercialModuleUnavailable();
  }
  protected gitLabProviderForCredential(
    _user: User,
    _connector: ConnectorRow,
    _credential: ResolvedGitLabCredential
  ): VcsConnectorProvider {
    return commercialModuleUnavailable();
  }
  protected gitLabCredentialRequired(_connector: ConnectorRow, _reason?: 'missing' | 'invalid'): AppError {
    return commercialModuleUnavailable();
  }
  protected async refreshGitLabConnectorCapabilities(
    _connector: ConnectorRow
  ): Promise<IntegrationConnectorCapabilities> {
    return commercialModuleUnavailable();
  }
  protected toSafeProject(_project: ProjectRow): {
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
  } {
    return commercialModuleUnavailable();
  }
  protected toSafeProjectRef(
    _connectorId: string,
    _project: VcsProjectRef
  ): {
    connectorId: string;
    remoteId: string;
    fullPath: string;
    name: string;
    webUrl: string | null;
    visibility: string | null;
    defaultBranch: string | null;
    archived: boolean;
  } {
    return commercialModuleUnavailable();
  }
  protected projectToAllowlistEntry(_project: ProjectRow): {
    entryType: 'project';
    remoteId: string;
    fullPath: string;
    name: string;
    webUrl: string | null;
  } {
    return commercialModuleUnavailable();
  }
  protected toProviderProject(project: ProjectRow): VcsProjectRef {
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
  protected async auditGitLabTool(
    _user: User,
    _connector: ConnectorRow,
    _action: string,
    _details: Record<string, unknown>
  ): Promise<void> {
    return commercialModuleUnavailable();
  }
  protected toolLimit(_value: number | undefined, _fallback: number, _max: number): number {
    return commercialModuleUnavailable();
  }
  protected safeRelativePath(_value: string): string {
    return commercialModuleUnavailable();
  }
  protected slugPath(_value: string): string {
    return commercialModuleUnavailable();
  }
  protected shellQuote(_value: string): string {
    return commercialModuleUnavailable();
  }
}
