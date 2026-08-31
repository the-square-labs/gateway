import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  integrationConnectorCredentials,
  integrationConnectorProjects,
  integrationConnectors,
} from '@/db/schema/index.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import type { ResolvedGitLabUserCredential } from './gitlab-user-credentials.service.js';
import { GITLAB_AUDIT_ACTIONS } from './integration-audit.js';
import { assertConnectorOperationAccess } from './integration-permissions.js';
import type { VcsConnectorProvider, VcsUserTokenIdentity } from './integration-provider.types.js';
import type { GitLabUserCredentialAuthorizeInput } from './integrations.schemas.js';
import {
  type DockerBuildCheckoutCredential,
  type DockerBuildSourceRepository,
  type DockerBuildSourceResolution,
  isPlainRecord,
} from './integrations.service.core.js';
import { IntegrationsGitLabSupportService } from './integrations.service.gitlab-support.js';

interface GitHubRepositorySummary {
  id: number | null;
  name: string;
  fullName: string;
  repositoryUrl: string;
  defaultBranch: string | null;
  archived: boolean;
}

export abstract class IntegrationsSourceService extends IntegrationsGitLabSupportService {
  abstract githubListRepositories(user: User, input: { connectorId: string }): Promise<GitHubRepositorySummary[]>;
  abstract githubReadRepositoryFile(
    user: User,
    input: { connectorId: string; repositoryUrl: string; path: string; ref?: string }
  ): Promise<{ path: string; content: string }>;
  abstract gitReadRepositoryFile(
    user: User,
    input: { connectorId: string; repositoryUrl: string; path: string; ref?: string }
  ): Promise<{ path: string; content: string }>;

  async resolveDockerBuildCheckoutCredential(input: {
    connectorId: string;
    repositoryUrl: string;
    repositoryRemoteId: string;
  }): Promise<DockerBuildCheckoutCredential> {
    const [connector] = await this.db
      .select()
      .from(integrationConnectors)
      .where(eq(integrationConnectors.id, input.connectorId))
      .limit(1);
    if (!connector || !['gitlab', 'github', 'git'].includes(connector.provider)) {
      throw new AppError(404, 'SOURCE_CONNECTOR_NOT_FOUND', 'Source connector was not found');
    }
    if (!connector.enabled) throw new AppError(409, 'CONNECTOR_DISABLED', `${connector.name} is disabled`);
    const repositoryUrl = this.normalizeRepositoryUrl(input.repositoryUrl);
    if (new URL(repositoryUrl).host !== new URL(connector.baseUrl).host) {
      throw new AppError(403, 'REPOSITORY_HOST_MISMATCH', 'Repository host does not match the connector host');
    }

    if (connector.provider === 'gitlab') {
      const [deployToken] = await this.db
        .select()
        .from(integrationConnectorCredentials)
        .where(
          and(
            eq(integrationConnectorCredentials.connectorId, connector.id),
            eq(integrationConnectorCredentials.credentialType, 'gitlab_deploy_token'),
            eq(integrationConnectorCredentials.projectRemoteId, input.repositoryRemoteId)
          )
        )
        .orderBy(desc(integrationConnectorCredentials.createdAt))
        .limit(1);
      if (
        deployToken &&
        (!deployToken.expiresAt || deployToken.expiresAt > new Date()) &&
        deployToken.scopes.includes('read_repository') &&
        deployToken.username
      ) {
        return { username: deployToken.username, password: this.decryptToken(deployToken.encryptedSecret) };
      }
    }
    if (!connector.encryptedToken) {
      throw new AppError(
        409,
        'SOURCE_AUTOMATION_CREDENTIAL_MISSING',
        'Automated builds require a connector-owned repository credential'
      );
    }
    return {
      username: connector.username || (connector.provider === 'gitlab' ? 'oauth2' : 'x-access-token'),
      password:
        connector.provider === 'github'
          ? await this.resolveGitHubConnectorToken(connector)
          : this.decryptToken(connector.encryptedToken),
    };
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

  async listDockerBuildSourceRepositories(user: User, connectorId: string): Promise<DockerBuildSourceRepository[]> {
    const connector = await this.getConnectorRow(connectorId);
    if (!['gitlab', 'github', 'git'].includes(connector.provider)) {
      throw new AppError(400, 'UNSUPPORTED_SOURCE_CONNECTOR', 'Connector does not provide a Git repository');
    }
    if (!connector.enabled) throw new AppError(409, 'CONNECTOR_DISABLED', `${connector.name} is disabled`);

    if (connector.provider === 'gitlab') {
      assertConnectorOperationAccess({
        actor: { userId: user.id, scopes: user.scopes },
        provider: 'gitlab',
        operation: 'repository.read',
        requiredScope: 'integrations:gitlab:repo:read',
        capabilities: connector.capabilities,
        requiredCapability: 'repoRead',
        connectorId: connector.id,
        connectorName: connector.name,
      });
      const projects = await this.db
        .select()
        .from(integrationConnectorProjects)
        .where(
          and(
            eq(integrationConnectorProjects.connectorId, connector.id),
            isNull(integrationConnectorProjects.inaccessibleAt)
          )
        )
        .orderBy(integrationConnectorProjects.fullPath);
      const allowlistRows = await this.listAllowlistRows(connector.id);
      return this.filterAllowedProjects(connector, allowlistRows, projects).map((project) =>
        this.toDockerBuildSourceRepository(connector, project)
      );
    }

    if (connector.provider === 'github') {
      const repositories = await this.githubListRepositories(user, { connectorId });
      await this.upsertProjectRows(
        connector.id,
        repositories
          .filter((repository) => repository.id !== null && repository.fullName && repository.repositoryUrl)
          .map((repository) => ({
            remoteId: String(repository.id),
            fullPath: repository.fullName,
            name: repository.name,
            webUrl: repository.repositoryUrl,
            defaultBranch: repository.defaultBranch,
            archived: repository.archived,
          }))
      );
      const projectRows = await this.db
        .select()
        .from(integrationConnectorProjects)
        .where(eq(integrationConnectorProjects.connectorId, connector.id));
      const projectIds = new Map(projectRows.map((project) => [project.remoteId, project.id]));
      return repositories.flatMap((repository) => {
        if (repository.id === null) return [];
        const projectId = projectIds.get(String(repository.id));
        if (!projectId) return [];
        return [
          {
            connectorId: connector.id,
            connectorName: connector.name,
            projectId,
            provider: 'github' as const,
            remoteId: String(repository.id),
            fullPath: repository.fullName,
            name: repository.name,
            webUrl: repository.repositoryUrl,
            defaultBranch: repository.defaultBranch,
            archived: repository.archived,
          },
        ];
      });
    }

    assertConnectorOperationAccess({
      actor: { userId: user.id, scopes: user.scopes },
      provider: 'git',
      connectorId: connector.id,
      connectorName: connector.name,
      operation: 'repository.read',
      requiredScope: 'integrations:git:view',
    });
    const entries = (await this.listAllowlistRows(connector.id)).filter((entry) => entry.entryType === 'project');
    await this.upsertProjectRows(
      connector.id,
      entries.map((entry) => ({
        remoteId: entry.remoteId,
        fullPath: entry.fullPath,
        name: entry.name || entry.fullPath,
        webUrl: entry.webUrl || entry.fullPath,
        archived: false,
      }))
    );
    const rows = await this.db
      .select()
      .from(integrationConnectorProjects)
      .where(
        and(
          eq(integrationConnectorProjects.connectorId, connector.id),
          isNull(integrationConnectorProjects.inaccessibleAt)
        )
      )
      .orderBy(integrationConnectorProjects.fullPath);
    return rows.map((project) => this.toDockerBuildSourceRepository(connector, project));
  }

  async resolveDockerBuildSource(
    user: User,
    input: { connectorId: string; projectId: string; branch: string }
  ): Promise<DockerBuildSourceResolution> {
    const branch = this.gitRefName(input.branch);
    const [joined] = await this.db
      .select({ connector: integrationConnectors, project: integrationConnectorProjects })
      .from(integrationConnectorProjects)
      .innerJoin(integrationConnectors, eq(integrationConnectors.id, integrationConnectorProjects.connectorId))
      .where(
        and(
          eq(integrationConnectorProjects.id, input.projectId),
          eq(integrationConnectorProjects.connectorId, input.connectorId)
        )
      )
      .limit(1);
    if (!joined || !['gitlab', 'github', 'git'].includes(joined.connector.provider)) {
      throw new AppError(404, 'SOURCE_PROJECT_NOT_FOUND', 'Repository is not available through this connector');
    }
    const connector = joined.connector;
    const project = joined.project;
    if (!connector.enabled) throw new AppError(409, 'CONNECTOR_DISABLED', `${connector.name} is disabled`);
    if (project.inaccessibleAt) {
      throw new AppError(409, 'SOURCE_PROJECT_INACCESSIBLE', 'Repository is no longer visible to this connector');
    }
    if (project.archived)
      throw new AppError(409, 'SOURCE_PROJECT_ARCHIVED', 'Archived repositories cannot be deployed');

    let cloneUrl: string;
    let commitSha: string | null = null;
    if (connector.provider === 'gitlab') {
      assertConnectorOperationAccess({
        actor: { userId: user.id, scopes: user.scopes },
        provider: 'gitlab',
        operation: 'repository.read',
        requiredScope: 'integrations:gitlab:repo:read',
        capabilities: connector.capabilities,
        requiredCapability: 'repoRead',
        connectorId: connector.id,
        connectorName: connector.name,
      });
      const allowlistRows = await this.listAllowlistRows(connector.id);
      if (!this.isGitLabProjectAllowed(project, allowlistRows) && connector.allowlistMode !== 'all_visible') {
        throw new AppError(404, 'SOURCE_PROJECT_NOT_FOUND', 'Repository is not available through this connector');
      }
      const provider = this.getProvider('gitlab') as VcsConnectorProvider;
      const resolved = await provider.getBranchAccess(
        this.systemAuthFor(connector),
        this.toProviderProject(project),
        branch
      );
      if (!resolved.exists) throw new AppError(404, 'SOURCE_BRANCH_NOT_FOUND', 'Repository branch was not found');
      commitSha = resolved.commitSha ?? null;
      cloneUrl = `${connector.baseUrl.replace(/\/+$/, '')}/${project.fullPath}.git`;
    } else if (connector.provider === 'github') {
      cloneUrl = this.normalizeRepositoryUrl(project.webUrl || `${connector.baseUrl}/${project.fullPath}`);
      const context = await this.resolveGitRepository(user, 'github', connector.id, cloneUrl);
      const { owner, repository } = this.githubRepositoryIdentity(context.repositoryUrl);
      const response = await this.githubConnectorRequest(
        context.connector,
        context.token,
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches/${encodeURIComponent(branch)}`
      );
      const body = (await response.json().catch(() => null)) as unknown;
      if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
      const record = isPlainRecord(body) ? body : {};
      const commit = isPlainRecord(record.commit) ? record.commit : {};
      commitSha = typeof commit.sha === 'string' ? commit.sha : null;
      cloneUrl = context.repositoryUrl.endsWith('.git') ? context.repositoryUrl : `${context.repositoryUrl}.git`;
    } else {
      cloneUrl = this.normalizeRepositoryUrl(project.webUrl || project.fullPath);
      commitSha = await this.withGenericGitCheckout(
        user,
        { connectorId: connector.id, repositoryUrl: cloneUrl, ref: branch },
        async (context) => (await this.runGit(['rev-parse', 'HEAD'], context)).stdout.trim()
      );
    }
    if (!commitSha || !/^[0-9a-f]{40,64}$/i.test(commitSha)) {
      throw new AppError(502, 'SOURCE_COMMIT_UNRESOLVED', 'Provider did not return an immutable commit SHA');
    }
    return {
      ...this.toDockerBuildSourceRepository(connector, project),
      cloneUrl,
      branch,
      commitSha: commitSha.toLowerCase(),
    };
  }

  async readDockerBuildSourceFile(
    user: User,
    input: { connectorId: string; projectId: string; repositoryUrl: string; path: string; commitSha: string }
  ): Promise<{ path: string; content: string }> {
    const [joined] = await this.db
      .select({ connector: integrationConnectors, project: integrationConnectorProjects })
      .from(integrationConnectorProjects)
      .innerJoin(integrationConnectors, eq(integrationConnectors.id, integrationConnectorProjects.connectorId))
      .where(
        and(
          eq(integrationConnectorProjects.id, input.projectId),
          eq(integrationConnectorProjects.connectorId, input.connectorId)
        )
      )
      .limit(1);
    if (!joined || !['gitlab', 'github', 'git'].includes(joined.connector.provider)) {
      throw new AppError(404, 'SOURCE_PROJECT_NOT_FOUND', 'Repository is not available through this connector');
    }
    if (joined.connector.provider === 'gitlab') {
      const result = await (this.getProvider('gitlab') as VcsConnectorProvider).readFile(
        this.systemAuthFor(joined.connector),
        {
          project: this.toProviderProject(joined.project),
          path: input.path,
          ref: input.commitSha,
          length: 256_000,
        }
      );
      if (result.truncated) throw new AppError(413, 'COMPOSE_FILE_TOO_LARGE', 'Compose file exceeds 256 KiB');
      return { path: result.path, content: result.content };
    }
    const repositoryUrl = joined.project.webUrl || input.repositoryUrl;
    if (joined.connector.provider === 'github') {
      return this.githubReadRepositoryFile(user, {
        connectorId: input.connectorId,
        repositoryUrl,
        path: input.path,
        ref: input.commitSha,
      });
    }
    return this.gitReadRepositoryFile(user, {
      connectorId: input.connectorId,
      repositoryUrl,
      path: input.path,
      ref: input.commitSha,
    });
  }

  async reconcileDockerSourceWebhook(input: {
    connectorId: string;
    projectId: string;
    callbackUrl: string;
    secret: string;
  }): Promise<{ provider: 'gitlab' | 'github'; id: string } | null> {
    const [joined] = await this.db
      .select({ connector: integrationConnectors, project: integrationConnectorProjects })
      .from(integrationConnectorProjects)
      .innerJoin(integrationConnectors, eq(integrationConnectors.id, integrationConnectorProjects.connectorId))
      .where(
        and(
          eq(integrationConnectorProjects.id, input.projectId),
          eq(integrationConnectorProjects.connectorId, input.connectorId)
        )
      )
      .limit(1);
    if (!joined?.connector.enabled) return null;
    if (joined.connector.provider === 'gitlab') {
      const provider = this.getProvider('gitlab') as VcsConnectorProvider;
      const auth = this.systemAuthFor(joined.connector);
      const project = this.toProviderProject(joined.project);
      const hooks = await provider.listProjectWebhooks(auth, project);
      const existing = hooks.find((hook) => hook.url === input.callbackUrl);
      const hook = await provider.createOrUpdateProjectWebhook(auth, project, {
        id: existing?.id,
        url: input.callbackUrl,
        token: input.secret,
        pushEvents: true,
        mergeRequestsEvents: false,
        tagPushEvents: false,
        jobEvents: false,
        pipelineEvents: false,
        enableSslVerification: true,
      });
      return { provider: 'gitlab', id: String(hook.id) };
    }
    if (joined.connector.provider !== 'github' || !joined.connector.encryptedToken) return null;
    const token = await this.resolveGitHubConnectorToken(joined.connector);
    const repositoryUrl = this.normalizeRepositoryUrl(
      joined.project.webUrl || `${joined.connector.baseUrl}/${joined.project.fullPath}`
    );
    const { owner, repository } = this.githubRepositoryIdentity(repositoryUrl);
    const basePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/hooks`;
    const listed = await this.githubConnectorRequest(joined.connector, token, basePath);
    const listBody = (await listed.json().catch(() => null)) as unknown;
    if (!listed.ok) throw this.githubRepositoryRequestError(listed.status, listBody);
    const hooks = Array.isArray(listBody) ? listBody : [];
    const existing = hooks.find((candidate) => {
      if (!isPlainRecord(candidate)) return false;
      const config = isPlainRecord(candidate.config) ? candidate.config : {};
      return config.url === input.callbackUrl;
    });
    const existingId = isPlainRecord(existing) && typeof existing.id === 'number' ? existing.id : null;
    const response = await this.githubConnectorRequest(
      joined.connector,
      token,
      existingId ? `${basePath}/${existingId}` : basePath,
      {
        method: existingId ? 'PATCH' : 'POST',
        body: JSON.stringify({
          name: 'web',
          active: true,
          events: ['push'],
          config: { url: input.callbackUrl, content_type: 'json', insecure_ssl: '0', secret: input.secret },
        }),
      }
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    const id = isPlainRecord(body) && typeof body.id === 'number' ? body.id : existingId;
    if (!id) throw new AppError(502, 'GITHUB_WEBHOOK_INVALID', 'GitHub did not return a webhook id');
    return { provider: 'github', id: String(id) };
  }

  async removeDockerSourceWebhook(input: {
    connectorId: string;
    projectId: string;
    providerId: string;
  }): Promise<boolean> {
    const [providerName, hookIdValue] = input.providerId.split(':', 2);
    if (!providerName || !hookIdValue || !['gitlab', 'github'].includes(providerName)) return false;
    const hookId = Number(hookIdValue);
    if (!Number.isSafeInteger(hookId) || hookId <= 0) return false;

    const [joined] = await this.db
      .select({ connector: integrationConnectors, project: integrationConnectorProjects })
      .from(integrationConnectorProjects)
      .innerJoin(integrationConnectors, eq(integrationConnectors.id, integrationConnectorProjects.connectorId))
      .where(
        and(
          eq(integrationConnectorProjects.id, input.projectId),
          eq(integrationConnectorProjects.connectorId, input.connectorId)
        )
      )
      .limit(1);
    if (!joined || joined.connector.provider !== providerName) return false;

    if (providerName === 'gitlab') {
      const provider = this.getProvider('gitlab') as VcsConnectorProvider;
      await provider.deleteProjectWebhook(
        this.systemAuthFor(joined.connector),
        this.toProviderProject(joined.project),
        hookId
      );
      return true;
    }

    if (!joined.connector.encryptedToken) return false;
    const token = await this.resolveGitHubConnectorToken(joined.connector);
    const repositoryUrl = this.normalizeRepositoryUrl(
      joined.project.webUrl || `${joined.connector.baseUrl}/${joined.project.fullPath}`
    );
    const { owner, repository } = this.githubRepositoryIdentity(repositoryUrl);
    const response = await this.githubConnectorRequest(
      joined.connector,
      token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/hooks/${hookId}`,
      { method: 'DELETE' }
    );
    if (response.status === 404) return true;
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as unknown;
      throw this.githubRepositoryRequestError(response.status, body);
    }
    return true;
  }
}
