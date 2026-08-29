import { and, eq } from 'drizzle-orm';
import {
  type IntegrationConnectorCapabilities,
  integrationConnectorProjects,
  integrationConnectors,
} from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import { GITLAB_AUDIT_ACTIONS, redactGitLabAuditDetails } from './integration-audit.js';
import { assertConnectorOperationAccess } from './integration-permissions.js';
import type {
  VcsConnectorAuth,
  VcsConnectorProvider,
  VcsProjectAccess,
  VcsProjectRef,
} from './integration-provider.types.js';
import type {
  ConnectorRow,
  GitLabCredentialSource,
  ProjectRow,
  ResolvedGitLabCredential,
} from './integrations.service.core.js';
import { IntegrationsGitSupportService } from './integrations.service.git-support.js';

export abstract class IntegrationsGitLabSupportService extends IntegrationsGitSupportService {
  protected async assertGitLabConnectorAccess(
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

  protected async resolveGitLabProjectContext(
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

  protected async assertPersonalGitLabWriteAccess(
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

  protected async resolveGitLabCredential(user: User, connector: ConnectorRow): Promise<ResolvedGitLabCredential> {
    if (hasScope(user.scopes, 'integrations:gitlab:system')) {
      return { source: 'system', auth: this.systemAuthFor(connector), scopes: [] };
    }
    const personal = await this.gitLabUserCredentials.resolveAuth(user.id, connector.id, connector.baseUrl);
    if (!personal) throw this.gitLabCredentialRequired(connector);
    return { source: 'personal', auth: personal.auth, scopes: personal.scopes };
  }

  protected gitLabProviderForCredential(
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

  protected gitLabCredentialRequired(connector: ConnectorRow, reason: 'missing' | 'invalid' = 'missing'): AppError {
    return new AppError(428, 'GITLAB_CREDENTIAL_REQUIRED', 'Personal GitLab authorization is required', {
      provider: 'gitlab',
      connectorId: connector.id,
      connectorName: connector.name,
      baseUrl: connector.baseUrl,
      patCreationUrl: this.gitLabPatCreationUrl(connector.baseUrl),
      reason,
    });
  }

  protected async refreshGitLabConnectorCapabilities(
    connector: ConnectorRow
  ): Promise<IntegrationConnectorCapabilities> {
    const provider = this.getProvider(connector.provider);
    const capabilities = await provider.testConnection(this.systemAuthFor(connector));
    await this.db
      .update(integrationConnectors)
      .set({ capabilities, testedAt: new Date(), updatedAt: new Date() })
      .where(eq(integrationConnectors.id, connector.id));
    return capabilities;
  }

  protected toSafeProject(project: ProjectRow) {
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

  protected toSafeProjectRef(connectorId: string, project: VcsProjectRef) {
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

  protected projectToAllowlistEntry(project: ProjectRow) {
    return {
      entryType: 'project' as const,
      remoteId: project.remoteId,
      fullPath: project.fullPath,
      name: project.name,
      webUrl: project.webUrl,
    };
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
    user: User,
    connector: ConnectorRow,
    action: string,
    details: Record<string, unknown>
  ) {
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

  protected toolLimit(value: number | undefined, fallback: number, max: number) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.floor(value), 1), max);
  }

  protected safeRelativePath(value: string) {
    const trimmed = value.trim().replace(/^\/+/, '');
    if (!trimmed || trimmed.includes('..') || trimmed.includes('\0')) {
      throw new AppError(400, 'INVALID_SANDBOX_PATH', 'Sandbox target path must be a relative path');
    }
    return trimmed;
  }

  protected slugPath(value: string) {
    return (
      value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._/-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'repository'
    );
  }

  protected shellQuote(value: string) {
    return `'${value.replace(/'/g, "'\"'\"'")}'`;
  }
}
