import { spawn } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { and, desc, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import sodium from 'libsodium-wrappers';
import { getEnv } from '@/config/env.js';
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
  integrationGitHubOAuthSessions,
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
  GitConnectorCreateInput,
  GitConnectorPreviewTestInput,
  GitConnectorUpdateInput,
  GitHubConnectorCreateInput,
  GitHubConnectorPreviewTestInput,
  GitHubOAuthStartInput,
  GitLabAllowlistEntryInput,
  GitLabConnectorCreateInput,
  GitLabConnectorListQuery,
  GitLabConnectorUpdateInput,
  GitLabUserCredentialAuthorizeInput,
  GitUserCredentialAuthorizeInput,
} from './integrations.schemas.js';

type ConnectorRow = typeof integrationConnectors.$inferSelect;
type AllowlistRow = typeof integrationConnectorAllowlistEntries.$inferSelect;
type ProjectRow = typeof integrationConnectorProjects.$inferSelect;
type CloudflareZoneRow = typeof integrationConnectorCloudflareZones.$inferSelect;
type GitHubOAuthSessionRow = typeof integrationGitHubOAuthSessions.$inferSelect;
type GitLabCredentialSource = 'system' | 'personal';

interface ResolvedGitLabCredential {
  source: GitLabCredentialSource;
  auth: VcsConnectorAuth;
  scopes: string[];
}

interface GenericGitExecutionContext {
  checkoutDir: string;
  askpassPath: string;
  username: string;
  token: string;
  repositoryUrl: string;
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
const GITHUB_HEALTH_CHECK_INTERVAL_MS = 15 * 60 * 1000;
const GIT_CHECKOUT_TIMEOUT_MS = 30_000;
const GIT_FILE_READ_LIMIT_BYTES = 262_144;
const GIT_FILE_WRITE_LIMIT_BYTES = 524_288;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function githubApiUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  if (url.hostname === 'github.com') return `https://api.github.com${path}`;
  return new URL(`/api/v3${path}`, `${url.protocol}//${url.host}`).toString();
}

function githubTokenCapabilities(scopes: readonly string[]): IntegrationConnectorCapabilities {
  const has = (...candidates: string[]) => candidates.some((scope) => scopes.includes(scope));
  const canUseRepository = has('repo', 'public_repo');
  return {
    projectsView: true,
    repoRead: canUseRepository,
    repoWrite: canUseRepository,
    ciView: has('repo', 'public_repo', 'workflow'),
    ciEdit: has('repo', 'public_repo', 'workflow'),
    variablesView: canUseRepository,
    variablesEdit: canUseRepository,
    webhooksManage: canUseRepository,
    registryView: has('repo', 'read:packages', 'write:packages'),
  };
}

function genericGitCapabilities(): IntegrationConnectorCapabilities {
  return { projectsView: true, repoRead: true, repoWrite: true };
}

export interface SafeIntegrationConnector extends Omit<ConnectorRow, 'encryptedToken'> {
  hasToken: boolean;
  tokenMasked: string | null;
}

export interface GitHubOAuthSession {
  id: string;
  status: GitHubOAuthSessionRow['status'];
  userCode: string;
  verificationUri: string;
  pollIntervalSeconds: number;
  expiresAt: Date;
  connectorId: string | null;
  errorMessage: string | null;
}

export interface GitUserCredentialStatus {
  provider: 'github' | 'git';
  connectorId: string;
  connectorName: string;
  baseUrl: string;
  authorized: boolean;
  status: 'missing' | 'valid' | 'invalid';
  tokenMasked: string | null;
  username: string | null;
  authorizationUrl: string | null;
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

  async listGitConnectors(provider: 'github' | 'git', enabled?: boolean) {
    const conditions: SQL[] = [eq(integrationConnectors.provider, provider)];
    if (enabled !== undefined) conditions.push(eq(integrationConnectors.enabled, enabled));
    const rows = await this.db
      .select()
      .from(integrationConnectors)
      .where(buildWhere(conditions))
      .orderBy(desc(integrationConnectors.createdAt));
    return Promise.all(
      rows.map(async (row) => ({
        ...this.toSafeConnector(row),
        allowlistEntries: await this.listAllowlistRows(row.id),
      }))
    );
  }

  async githubListRepositories(user: User, input: { connectorId: string }) {
    const { connector, token } = await this.resolveGitHubAccount(user, input.connectorId);
    const response = await this.githubConnectorRequest(
      connector,
      token,
      '/user/repos?per_page=100&sort=updated&affiliation=owner%2Ccollaborator%2Corganization_member'
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    if (!Array.isArray(body)) return [];
    return body.slice(0, 100).map((entry) => {
      const repository = isPlainRecord(entry) ? entry : {};
      const owner = isPlainRecord(repository.owner) ? repository.owner : {};
      const permissions = isPlainRecord(repository.permissions) ? repository.permissions : {};
      return {
        id: typeof repository.id === 'number' ? repository.id : null,
        name: typeof repository.name === 'string' ? repository.name : '',
        fullName: typeof repository.full_name === 'string' ? repository.full_name : '',
        repositoryUrl: typeof repository.html_url === 'string' ? repository.html_url : '',
        owner: typeof owner.login === 'string' ? owner.login : '',
        defaultBranch: typeof repository.default_branch === 'string' ? repository.default_branch : null,
        private: repository.private === true,
        archived: repository.archived === true,
        updatedAt: typeof repository.updated_at === 'string' ? repository.updated_at : null,
        permissions: {
          admin: permissions.admin === true,
          maintain: permissions.maintain === true,
          push: permissions.push === true,
          pull: permissions.pull === true,
        },
      };
    });
  }

  async githubListRepositoryTree(
    user: User,
    input: { connectorId: string; repositoryUrl: string; path?: string; ref?: string }
  ) {
    const { connector, repositoryUrl, token } = await this.resolveGitRepository(
      user,
      'github',
      input.connectorId,
      input.repositoryUrl
    );
    const { owner, repository } = this.githubRepositoryIdentity(repositoryUrl);
    const path = input.path?.trim().replace(/^\/+/, '') ?? '';
    const query = input.ref?.trim() ? `?ref=${encodeURIComponent(input.ref.trim())}` : '';
    const response = await this.githubConnectorRequest(
      connector,
      token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${path}${query}`
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    const entries = Array.isArray(body) ? body : [body];
    return entries.slice(0, 500).map((entry) => {
      const item = isPlainRecord(entry) ? entry : {};
      return {
        name: typeof item.name === 'string' ? item.name : '',
        path: typeof item.path === 'string' ? item.path : '',
        type: typeof item.type === 'string' ? item.type : 'unknown',
        size: typeof item.size === 'number' ? item.size : null,
        sha: typeof item.sha === 'string' ? item.sha : null,
      };
    });
  }

  async githubReadRepositoryFile(
    user: User,
    input: { connectorId: string; repositoryUrl: string; path: string; ref?: string }
  ) {
    const { connector, repositoryUrl, token } = await this.resolveGitRepository(
      user,
      'github',
      input.connectorId,
      input.repositoryUrl
    );
    const { owner, repository } = this.githubRepositoryIdentity(repositoryUrl);
    const path = input.path.trim().replace(/^\/+/, '');
    if (!path || path.includes('..') || path.includes('\0')) {
      throw new AppError(400, 'INVALID_REPOSITORY_PATH', 'Repository path must be relative');
    }
    const query = input.ref?.trim() ? `?ref=${encodeURIComponent(input.ref.trim())}` : '';
    const response = await this.githubConnectorRequest(
      connector,
      token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${path}${query}`
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    const item = isPlainRecord(body) ? body : {};
    const encoded = typeof item.content === 'string' ? item.content.replace(/\s+/g, '') : '';
    if (item.encoding !== 'base64' || !encoded) {
      throw new AppError(400, 'GITHUB_FILE_UNAVAILABLE', 'GitHub did not return file content');
    }
    const content = Buffer.from(encoded, 'base64');
    if (content.byteLength > 262_144) {
      throw new AppError(413, 'GITHUB_FILE_TOO_LARGE', 'Repository file exceeds the 256 KiB AI read limit');
    }
    return {
      path: typeof item.path === 'string' ? item.path : path,
      sha: typeof item.sha === 'string' ? item.sha : null,
      size: content.byteLength,
      content: content.toString('utf8'),
    };
  }

  async githubListBranches(user: User, input: { connectorId: string; repositoryUrl: string }) {
    const context = await this.resolveGitRepository(user, 'github', input.connectorId, input.repositoryUrl);
    const { owner, repository } = this.githubRepositoryIdentity(context.repositoryUrl);
    const response = await this.githubConnectorRequest(
      context.connector,
      context.token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/branches?per_page=100`
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    if (!Array.isArray(body)) return [];
    return body.slice(0, 100).map((entry) => {
      const branch = isPlainRecord(entry) ? entry : {};
      const commit = isPlainRecord(branch.commit) ? branch.commit : {};
      return {
        name: typeof branch.name === 'string' ? branch.name : '',
        commitSha: typeof commit.sha === 'string' ? commit.sha : null,
        protected: branch.protected === true,
      };
    });
  }

  async githubListWorkflowRuns(
    user: User,
    input: { connectorId: string; repositoryUrl: string; branch?: string; status?: string }
  ) {
    const context = await this.resolveGitRepository(user, 'github', input.connectorId, input.repositoryUrl);
    const { owner, repository } = this.githubRepositoryIdentity(context.repositoryUrl);
    const query = new URLSearchParams({ per_page: '50' });
    if (input.branch?.trim()) query.set('branch', input.branch.trim());
    if (input.status?.trim()) query.set('status', input.status.trim());
    const response = await this.githubConnectorRequest(
      context.connector,
      context.token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/runs?${query}`
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    const runs = isPlainRecord(body) && Array.isArray(body.workflow_runs) ? body.workflow_runs : [];
    return runs.slice(0, 50).map((entry) => {
      const run = isPlainRecord(entry) ? entry : {};
      return {
        id: typeof run.id === 'number' ? run.id : null,
        name: typeof run.name === 'string' ? run.name : '',
        event: typeof run.event === 'string' ? run.event : null,
        branch: typeof run.head_branch === 'string' ? run.head_branch : null,
        headSha: typeof run.head_sha === 'string' ? run.head_sha : null,
        status: typeof run.status === 'string' ? run.status : null,
        conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
        url: typeof run.html_url === 'string' ? run.html_url : null,
        createdAt: typeof run.created_at === 'string' ? run.created_at : null,
        updatedAt: typeof run.updated_at === 'string' ? run.updated_at : null,
      };
    });
  }

  async githubListActionsVariables(user: User, input: { connectorId: string; repositoryUrl: string }) {
    const context = await this.resolveGitRepository(user, 'github', input.connectorId, input.repositoryUrl);
    const { owner, repository } = this.githubRepositoryIdentity(context.repositoryUrl);
    const response = await this.githubConnectorRequest(
      context.connector,
      context.token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/variables?per_page=100`
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    const variables = isPlainRecord(body) && Array.isArray(body.variables) ? body.variables : [];
    return variables.slice(0, 100).map((entry) => {
      const variable = isPlainRecord(entry) ? entry : {};
      return {
        name: typeof variable.name === 'string' ? variable.name : '',
        value: typeof variable.value === 'string' ? variable.value : '',
        createdAt: typeof variable.created_at === 'string' ? variable.created_at : null,
        updatedAt: typeof variable.updated_at === 'string' ? variable.updated_at : null,
      };
    });
  }

  async githubListActionsSecrets(user: User, input: { connectorId: string; repositoryUrl: string }) {
    const context = await this.resolveGitRepository(user, 'github', input.connectorId, input.repositoryUrl);
    const { owner, repository } = this.githubRepositoryIdentity(context.repositoryUrl);
    const response = await this.githubConnectorRequest(
      context.connector,
      context.token,
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/secrets?per_page=100`
    );
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    const secrets = isPlainRecord(body) && Array.isArray(body.secrets) ? body.secrets : [];
    return secrets.slice(0, 100).map((entry) => {
      const secret = isPlainRecord(entry) ? entry : {};
      return {
        name: typeof secret.name === 'string' ? secret.name : '',
        createdAt: typeof secret.created_at === 'string' ? secret.created_at : null,
        updatedAt: typeof secret.updated_at === 'string' ? secret.updated_at : null,
      };
    });
  }

  async githubUpsertRepositoryFile(
    user: User,
    input: {
      connectorId: string;
      repositoryUrl: string;
      path: string;
      branch: string;
      message: string;
      content: string;
    }
  ) {
    if (!hasScope(user.scopes, 'integrations:github:manage')) {
      throw new AppError(403, 'PERMISSION_DENIED', 'GitHub connector manage scope is required');
    }
    const { connector, repositoryUrl, token } = await this.resolveGitRepository(
      user,
      'github',
      input.connectorId,
      input.repositoryUrl
    );
    const { owner, repository } = this.githubRepositoryIdentity(repositoryUrl);
    const path = input.path.trim().replace(/^\/+/, '');
    if (!path || path.includes('..') || path.includes('\0')) {
      throw new AppError(400, 'INVALID_REPOSITORY_PATH', 'Repository path must be relative');
    }
    if (Buffer.byteLength(input.content, 'utf8') > 524_288) {
      throw new AppError(413, 'GITHUB_FILE_TOO_LARGE', 'Repository file exceeds the 512 KiB write limit');
    }
    const apiPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/contents/${path}`;
    const existingResponse = await this.githubConnectorRequest(
      connector,
      token,
      `${apiPath}?ref=${encodeURIComponent(input.branch.trim())}`
    );
    let sha: string | undefined;
    if (existingResponse.ok) {
      const existing = (await existingResponse.json().catch(() => null)) as unknown;
      if (isPlainRecord(existing) && typeof existing.sha === 'string') sha = existing.sha;
    } else if (existingResponse.status !== 404) {
      throw this.githubRepositoryRequestError(existingResponse.status, await existingResponse.json().catch(() => null));
    }
    const response = await this.githubConnectorRequest(connector, token, apiPath, {
      method: 'PUT',
      body: JSON.stringify({
        message: input.message.trim(),
        branch: input.branch.trim(),
        content: Buffer.from(input.content, 'utf8').toString('base64'),
        ...(sha ? { sha } : {}),
      }),
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) throw this.githubRepositoryRequestError(response.status, body);
    const result = isPlainRecord(body) ? body : {};
    const commit = isPlainRecord(result.commit) ? result.commit : {};
    const content = isPlainRecord(result.content) ? result.content : {};
    return {
      repositoryUrl,
      path,
      branch: input.branch.trim(),
      commitSha: typeof commit.sha === 'string' ? commit.sha : null,
      contentSha: typeof content.sha === 'string' ? content.sha : null,
    };
  }

  async githubUpsertActionsVariable(
    user: User,
    input: { connectorId: string; repositoryUrl: string; name: string; value: string }
  ) {
    if (!hasScope(user.scopes, 'integrations:github:manage')) {
      throw new AppError(403, 'PERMISSION_DENIED', 'GitHub connector manage scope is required');
    }
    const context = await this.resolveGitRepository(user, 'github', input.connectorId, input.repositoryUrl);
    const { owner, repository } = this.githubRepositoryIdentity(context.repositoryUrl);
    const name = this.githubActionsName(input.name);
    const basePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/variables`;
    const updateResponse = await this.githubConnectorRequest(
      context.connector,
      context.token,
      `${basePath}/${encodeURIComponent(name)}`,
      { method: 'PATCH', body: JSON.stringify({ name, value: input.value }) }
    );
    if (updateResponse.status === 404) {
      const createResponse = await this.githubConnectorRequest(context.connector, context.token, basePath, {
        method: 'POST',
        body: JSON.stringify({ name, value: input.value }),
      });
      if (!createResponse.ok) {
        throw this.githubRepositoryRequestError(createResponse.status, await createResponse.json().catch(() => null));
      }
    } else if (!updateResponse.ok) {
      throw this.githubRepositoryRequestError(updateResponse.status, await updateResponse.json().catch(() => null));
    }
    return { repositoryUrl: context.repositoryUrl, name, updated: true };
  }

  async githubUpsertActionsSecret(
    user: User,
    input: { connectorId: string; repositoryUrl: string; name: string; value: string }
  ) {
    if (!hasScope(user.scopes, 'integrations:github:manage')) {
      throw new AppError(403, 'PERMISSION_DENIED', 'GitHub connector manage scope is required');
    }
    const context = await this.resolveGitRepository(user, 'github', input.connectorId, input.repositoryUrl);
    const { owner, repository } = this.githubRepositoryIdentity(context.repositoryUrl);
    const name = this.githubActionsName(input.name);
    const basePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/actions/secrets`;
    const keyResponse = await this.githubConnectorRequest(context.connector, context.token, `${basePath}/public-key`);
    const keyBody = (await keyResponse.json().catch(() => null)) as unknown;
    if (!keyResponse.ok) throw this.githubRepositoryRequestError(keyResponse.status, keyBody);
    if (!isPlainRecord(keyBody) || typeof keyBody.key !== 'string' || typeof keyBody.key_id !== 'string') {
      throw new AppError(502, 'GITHUB_SECRET_KEY_INVALID', 'GitHub returned an invalid Actions secret public key');
    }
    await sodium.ready;
    const encrypted = sodium.crypto_box_seal(
      sodium.from_string(input.value),
      sodium.from_base64(keyBody.key, sodium.base64_variants.ORIGINAL)
    );
    const response = await this.githubConnectorRequest(
      context.connector,
      context.token,
      `${basePath}/${encodeURIComponent(name)}`,
      {
        method: 'PUT',
        body: JSON.stringify({
          encrypted_value: sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL),
          key_id: keyBody.key_id,
        }),
      }
    );
    if (!response.ok) {
      throw this.githubRepositoryRequestError(response.status, await response.json().catch(() => null));
    }
    return { repositoryUrl: context.repositoryUrl, name, updated: true };
  }

  async gitListRemoteRefs(user: User, input: { connectorId: string; repositoryUrl: string }) {
    const { repositoryUrl, token, username } = await this.resolveGitRepository(
      user,
      'git',
      input.connectorId,
      input.repositoryUrl
    );
    const url = new URL(repositoryUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/info/refs`;
    url.searchParams.set('service', 'git-upload-pack');
    const response = await fetch(url, {
      headers: {
        accept: 'application/x-git-upload-pack-advertisement',
        authorization: `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`,
      },
    }).catch(() => null);
    if (!response) throw new AppError(502, 'GIT_CONNECTION_FAILED', 'Git host could not be reached');
    if (!response.ok)
      throw new AppError(400, 'GIT_AUTHORIZATION_INVALID', `Git host rejected access (${response.status})`);
    const advertised = await response.text();
    if (advertised.length > 1_048_576) {
      throw new AppError(413, 'GIT_REFS_TOO_LARGE', 'Git reference advertisement exceeds 1 MiB');
    }
    const refs = [...advertised.matchAll(/([0-9a-f]{40,64})\s+(refs\/(?:heads|tags)\/[^\0\n ]+)/gi)]
      .slice(0, 500)
      .map((match) => ({ sha: match[1], ref: match[2] }));
    return { repositoryUrl, refs };
  }

  async gitListRepositoryTree(
    user: User,
    input: { connectorId: string; repositoryUrl: string; path?: string; ref?: string }
  ) {
    return this.withGenericGitCheckout(user, input, async ({ checkoutDir }) => {
      const relativePath = this.repositoryRelativePath(input.path ?? '', true);
      const directory = await this.resolveRepositoryPath(checkoutDir, relativePath, 'directory');
      const entries = await readdir(directory, { withFileTypes: true });
      return entries
        .filter((entry) => !(relativePath === '' && entry.name === '.git'))
        .sort((left, right) => left.name.localeCompare(right.name))
        .slice(0, 500)
        .map((entry) => ({
          name: entry.name,
          path: relativePath ? `${relativePath}/${entry.name}` : entry.name,
          type: entry.isDirectory() ? 'tree' : entry.isFile() ? 'blob' : entry.isSymbolicLink() ? 'symlink' : 'other',
        }));
    });
  }

  async gitReadRepositoryFile(
    user: User,
    input: { connectorId: string; repositoryUrl: string; path: string; ref?: string }
  ) {
    return this.withGenericGitCheckout(user, input, async ({ checkoutDir }) => {
      const relativePath = this.repositoryRelativePath(input.path, false);
      const filePath = await this.resolveRepositoryPath(checkoutDir, relativePath, 'file');
      const stats = await lstat(filePath);
      if (stats.size > GIT_FILE_READ_LIMIT_BYTES) {
        throw new AppError(413, 'GIT_FILE_TOO_LARGE', 'Repository file exceeds the 256 KiB AI read limit');
      }
      const content = await readFile(filePath);
      if (content.includes(0)) throw new AppError(400, 'GIT_FILE_BINARY', 'Repository file is not text');
      return {
        repositoryUrl: input.repositoryUrl,
        path: relativePath,
        size: content.byteLength,
        content: content.toString('utf8'),
      };
    });
  }

  async gitUpsertRepositoryFile(
    user: User,
    input: {
      connectorId: string;
      repositoryUrl: string;
      path: string;
      branch: string;
      message: string;
      content: string;
    }
  ) {
    if (!hasScope(user.scopes, 'integrations:git:manage')) {
      throw new AppError(403, 'PERMISSION_DENIED', 'Git connector manage scope is required');
    }
    if (Buffer.byteLength(input.content, 'utf8') > GIT_FILE_WRITE_LIMIT_BYTES) {
      throw new AppError(413, 'GIT_FILE_TOO_LARGE', 'Repository file exceeds the 512 KiB write limit');
    }
    const branch = this.gitRefName(input.branch);
    return this.withGenericGitCheckout(user, { ...input, ref: branch }, async (context) => {
      const relativePath = this.repositoryRelativePath(input.path, false);
      await this.assertNoRepositorySymlink(context.checkoutDir, relativePath);
      const filePath = resolve(context.checkoutDir, relativePath);
      await mkdir(dirname(filePath), { recursive: true });
      const existing = await readFile(filePath, 'utf8').catch(() => null);
      if (existing === input.content) {
        return { repositoryUrl: context.repositoryUrl, path: relativePath, branch, changed: false, commitSha: null };
      }
      await writeFile(filePath, input.content, { mode: 0o600 });
      await this.runGit(['config', 'user.name', 'Gateway AI'], context);
      await this.runGit(['config', 'user.email', 'gateway-ai@localhost'], context);
      await this.runGit(['add', '--', relativePath], context);
      await this.runGit(['commit', '-m', input.message.trim()], context);
      await this.runGit(['push', 'origin', `HEAD:${branch}`], context);
      const commitSha = (await this.runGit(['rev-parse', 'HEAD'], context)).stdout.trim();
      return { repositoryUrl: context.repositoryUrl, path: relativePath, branch, changed: true, commitSha };
    });
  }

  async createGitConnector(
    provider: 'github' | 'git',
    input: GitConnectorCreateInput | GitHubConnectorCreateInput,
    userId: string,
    authMode: 'token' | 'oauth' = 'token'
  ) {
    const baseUrl = this.normalizeBaseUrl(input.baseUrl);
    const gitInput = provider === 'git' ? (input as GitConnectorCreateInput) : null;
    if (gitInput && !gitInput.username?.trim()) {
      throw new AppError(400, 'GIT_USERNAME_REQUIRED', 'Username is required for a generic Git connector');
    }
    const githubIdentity = provider === 'github' ? await this.validateGitHubToken(baseUrl, input.token) : null;
    const capabilities = githubIdentity?.capabilities ?? genericGitCapabilities();
    const allowlistEntries = this.dedupeAllowlistEntries(gitInput?.allowlistEntries ?? []);
    const [row] = await this.db
      .insert(integrationConnectors)
      .values({
        provider,
        name: input.name,
        baseUrl,
        enabled: input.enabled,
        authMode,
        username: githubIdentity?.username ?? gitInput?.username?.trim() ?? null,
        encryptedToken: this.encryptToken(input.token),
        tokenLast4: this.tokenLast4(input.token),
        allowlistMode: provider === 'github' ? 'all_visible' : 'selected',
        settings: {
          repositoryMode: 'multi_repository',
          autoSyncEnabled: provider === 'github',
          autoSyncIntervalSeconds: provider === 'github' ? 900 : 86_400,
        },
        capabilities,
        syncStatus: provider === 'github' ? 'success' : 'never',
        testedAt: new Date(),
      })
      .returning();
    await this.replaceAllowlistEntries(row.id, allowlistEntries);
    await this.auditService.log({
      action: `integrations.${provider}.connector.create`,
      userId,
      resourceType: 'integration-connector',
      resourceId: row.id,
      details: { name: row.name, baseUrl: row.baseUrl, repositoryMode: 'multi_repository', authMode },
    });
    this.emitConnector(row.id, 'created', provider);
    return { ...this.toSafeConnector(row), allowlistEntries };
  }

  async updateGitConnector(provider: 'github' | 'git', id: string, input: GitConnectorUpdateInput, userId: string) {
    const existing = await this.getConnectorRow(id, provider);
    const updates: Partial<typeof integrationConnectors.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) updates.name = input.name;
    if (input.baseUrl !== undefined) updates.baseUrl = this.normalizeBaseUrl(input.baseUrl);
    if (input.enabled !== undefined) updates.enabled = input.enabled;
    if (input.username !== undefined) updates.username = input.username?.trim() || null;
    if (input.token !== undefined) {
      if (provider === 'github') {
        const identity = await this.validateGitHubToken(
          input.baseUrl !== undefined ? this.normalizeBaseUrl(input.baseUrl) : existing.baseUrl,
          input.token
        );
        updates.capabilities = identity.capabilities;
        updates.username = identity.username;
      }
      updates.encryptedToken = this.encryptToken(input.token);
      updates.tokenLast4 = this.tokenLast4(input.token);
      updates.testedAt = new Date();
    }
    if (provider === 'git' && input.allowlistEntries !== undefined) {
      updates.allowlistMode = 'selected';
      updates.settings = {
        repositoryMode: 'multi_repository',
        autoSyncEnabled: false,
        autoSyncIntervalSeconds: 86_400,
      };
    }
    const [row] = await this.db
      .update(integrationConnectors)
      .set(updates)
      .where(eq(integrationConnectors.id, existing.id))
      .returning();
    if (provider === 'git' && input.allowlistEntries !== undefined) {
      await this.replaceAllowlistEntries(existing.id, this.dedupeAllowlistEntries(input.allowlistEntries));
    }
    await this.auditService.log({
      action: `integrations.${provider}.connector.update`,
      userId,
      resourceType: 'integration-connector',
      resourceId: existing.id,
      details: { name: row.name },
    });
    this.emitConnector(existing.id, 'updated', provider);
    return { ...this.toSafeConnector(row), allowlistEntries: await this.listAllowlistRows(existing.id) };
  }

  async testGitConnector(provider: 'github' | 'git', id: string, userId: string | null) {
    const row = await this.getConnectorRow(id, provider);
    try {
      if (!row.encryptedToken) {
        throw new AppError(400, 'CONNECTOR_CREDENTIAL_MISSING', `${row.name} has no credential`);
      }
      const token = this.decryptToken(row.encryptedToken);
      let capabilities = row.capabilities;
      let username = row.username;
      if (provider === 'github') {
        const identity = await this.validateGitHubToken(row.baseUrl, token);
        capabilities = identity.capabilities;
        username = identity.username;
      } else {
        if (!username) throw new AppError(400, 'GIT_USERNAME_REQUIRED', 'Username is required for this connector');
        await this.validateGenericGitCredential(row, username, token);
        capabilities = genericGitCapabilities();
      }
      const [updated] = await this.db
        .update(integrationConnectors)
        .set({
          username,
          capabilities,
          syncStatus: 'success',
          syncLastError: null,
          testedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, provider)))
        .returning();
      if (userId) {
        await this.auditService.log({
          action: `integrations.${provider}.connector.test`,
          userId,
          resourceType: 'integration-connector',
          resourceId: id,
          details: { name: row.name, success: true },
        });
      }
      this.emitConnector(id, 'tested', provider);
      return { ...this.toSafeConnector(updated), allowlistEntries: await this.listAllowlistRows(id) };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Connector health check failed';
      await this.db
        .update(integrationConnectors)
        .set({ syncStatus: 'error', syncLastError: message, testedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, provider)));
      this.emitConnector(id, 'tested', provider);
      throw error;
    }
  }

  async syncGitConnector(provider: 'github' | 'git', id: string, userId: string) {
    const result = await this.testGitConnector(provider, id, userId);
    const [updated] = await this.db
      .update(integrationConnectors)
      .set({ syncFinishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, provider)))
      .returning();
    this.emitConnector(id, 'synced', provider);
    return { ...this.toSafeConnector(updated), allowlistEntries: result.allowlistEntries };
  }

  async deleteGitConnector(provider: 'github' | 'git', id: string, userId: string) {
    const row = await this.getConnectorRow(id, provider);
    await this.db
      .delete(integrationConnectors)
      .where(and(eq(integrationConnectors.id, id), eq(integrationConnectors.provider, provider)));
    await this.auditService.log({
      action: `integrations.${provider}.connector.delete`,
      userId,
      resourceType: 'integration-connector',
      resourceId: id,
      details: { name: row.name, baseUrl: row.baseUrl },
    });
    this.emitConnector(id, 'deleted', provider);
  }

  private async validateGitHubToken(
    baseUrl: string,
    token: string
  ): Promise<{ capabilities: IntegrationConnectorCapabilities; username: string; scopes: string[] }> {
    let response: Response;
    try {
      response = await fetch(githubApiUrl(baseUrl, '/user'), {
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
        },
      });
    } catch {
      throw new AppError(400, 'GITHUB_CONNECTION_FAILED', 'GitHub could not be reached');
    }
    if (!response.ok) {
      throw new AppError(400, 'GITHUB_AUTHORIZATION_INVALID', 'GitHub rejected this access token');
    }
    const body = (await response.json().catch(() => null)) as { login?: unknown } | null;
    const username = typeof body?.login === 'string' ? body.login.trim() : '';
    if (!username) {
      throw new AppError(400, 'GITHUB_AUTHORIZATION_INVALID', 'GitHub did not return the authorized username');
    }
    const scopes = (response.headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((scope) => scope.trim().toLowerCase())
      .filter(Boolean);
    return { capabilities: githubTokenCapabilities(scopes), username, scopes };
  }

  async previewGitHubConnectorTest(input: GitHubConnectorPreviewTestInput) {
    const baseUrl = this.normalizeBaseUrl(input.baseUrl);
    const identity = await this.validateGitHubToken(baseUrl, input.token);
    return {
      success: true as const,
      baseUrl,
      username: identity.username,
      capabilities: identity.capabilities,
    };
  }

  async previewGitConnectorTest(input: GitConnectorPreviewTestInput) {
    const baseUrl = this.normalizeBaseUrl(input.baseUrl);
    await this.validateGenericGitAccess(baseUrl, input.repositoryUrl, input.username, input.token);
    return {
      success: true as const,
      baseUrl,
      capabilities: genericGitCapabilities(),
    };
  }

  getGitHubOAuthAvailability() {
    return { available: true };
  }

  async startGitHubOAuth(input: GitHubOAuthStartInput, userId: string): Promise<GitHubOAuthSession> {
    const clientId = getEnv().GITHUB_OAUTH_CLIENT_ID;
    const baseUrl = 'https://github.com';
    let response: Response;
    try {
      response = await fetch('https://github.com/login/device/code', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: clientId, scope: 'repo workflow read:org read:packages' }),
      });
    } catch {
      throw new AppError(502, 'GITHUB_OAUTH_START_FAILED', 'GitHub authorization could not be started');
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const deviceCode = typeof body?.device_code === 'string' ? body.device_code : '';
    const userCode = typeof body?.user_code === 'string' ? body.user_code : '';
    const verificationUri = typeof body?.verification_uri === 'string' ? body.verification_uri : '';
    const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in : 900;
    const interval = typeof body?.interval === 'number' ? Math.max(1, body.interval) : 5;
    if (!response.ok || !deviceCode || !userCode || !verificationUri) {
      throw new AppError(502, 'GITHUB_OAUTH_START_FAILED', 'GitHub returned an incomplete authorization response');
    }
    const [row] = await this.db
      .insert(integrationGitHubOAuthSessions)
      .values({
        userId,
        encryptedDeviceCode: this.encryptToken(deviceCode),
        userCode,
        verificationUri,
        connectorDraft: {
          ...input,
          baseUrl,
          repositoryMode: 'multi_repository',
          allowlistEntries: [],
        },
        pollIntervalSeconds: interval,
        expiresAt: new Date(Date.now() + expiresIn * 1000),
      })
      .returning();
    return this.toSafeGitHubOAuthSession(row);
  }

  async getGitHubOAuthStatus(id: string, userId: string): Promise<GitHubOAuthSession> {
    let row = await this.getGitHubOAuthSession(id, userId);
    if (row.status !== 'pending') return this.toSafeGitHubOAuthSession(row);
    if (row.expiresAt.getTime() <= Date.now()) {
      [row] = await this.db
        .update(integrationGitHubOAuthSessions)
        .set({ status: 'expired', updatedAt: new Date() })
        .where(and(eq(integrationGitHubOAuthSessions.id, id), eq(integrationGitHubOAuthSessions.userId, userId)))
        .returning();
      return this.toSafeGitHubOAuthSession(row);
    }
    if (row.lastPolledAt && Date.now() - row.lastPolledAt.getTime() < Math.max(1, row.pollIntervalSeconds) * 1000) {
      return this.toSafeGitHubOAuthSession(row);
    }
    const [claimed] = await this.db
      .update(integrationGitHubOAuthSessions)
      .set({ status: 'processing', lastPolledAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(integrationGitHubOAuthSessions.id, id),
          eq(integrationGitHubOAuthSessions.userId, userId),
          eq(integrationGitHubOAuthSessions.status, 'pending')
        )
      )
      .returning();
    if (!claimed) return this.toSafeGitHubOAuthSession(await this.getGitHubOAuthSession(id, userId));
    return this.pollClaimedGitHubOAuthSession(claimed, userId);
  }

  async cancelGitHubOAuth(id: string, userId: string): Promise<GitHubOAuthSession> {
    const [row] = await this.db
      .update(integrationGitHubOAuthSessions)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(
        and(
          eq(integrationGitHubOAuthSessions.id, id),
          eq(integrationGitHubOAuthSessions.userId, userId),
          inArray(integrationGitHubOAuthSessions.status, ['pending', 'processing'])
        )
      )
      .returning();
    return this.toSafeGitHubOAuthSession(row ?? (await this.getGitHubOAuthSession(id, userId)));
  }

  async getGitUserCredentialStatus(
    provider: 'github' | 'git',
    connectorId: string,
    userId: string
  ): Promise<GitUserCredentialStatus> {
    const connector = await this.getConnectorRow(connectorId, provider);
    const status = await this.gitLabUserCredentials.getStatus(userId, connectorId);
    return {
      provider,
      connectorId,
      connectorName: connector.name,
      baseUrl: connector.baseUrl,
      authorized: status.authorized,
      status: status.status,
      tokenMasked: status.tokenMasked,
      username: status.gitlabUsername,
      authorizationUrl:
        provider === 'github'
          ? 'https://github.com/settings/tokens/new?description=Gateway%20AI&scopes=repo,workflow,read:org,read:packages'
          : null,
    };
  }

  async authorizeGitUserCredential(
    provider: 'github' | 'git',
    connectorId: string,
    userId: string,
    input: GitUserCredentialAuthorizeInput
  ): Promise<GitUserCredentialStatus> {
    const connector = await this.getConnectorRow(connectorId, provider);
    let username = input.username?.trim() ?? '';
    let scopes: string[] = [];
    if (provider === 'github') {
      const identity = await this.validateGitHubToken(connector.baseUrl, input.token);
      username = identity.username;
      scopes = identity.scopes;
    } else {
      if (!username) throw new AppError(400, 'GIT_USERNAME_REQUIRED', 'Username is required for Git authorization');
      await this.validateGenericGitCredential(connector, username, input.token);
    }
    await this.gitLabUserCredentials.replace(userId, connectorId, input.token, {
      gitlabUserId: username,
      gitlabUsername: username,
      tokenScopes: scopes,
      tokenExpiresAt: null,
    });
    await this.auditService.log({
      action: `integrations.${provider}.user_credential.authorize`,
      userId,
      resourceType: 'integration-connector',
      resourceId: connectorId,
      details: { connectorName: connector.name, username },
    });
    return this.getGitUserCredentialStatus(provider, connectorId, userId);
  }

  async disconnectGitUserCredential(provider: 'github' | 'git', connectorId: string, userId: string) {
    const connector = await this.getConnectorRow(connectorId, provider);
    const disconnected = await this.gitLabUserCredentials.disconnect(userId, connectorId);
    if (disconnected) {
      await this.auditService.log({
        action: `integrations.${provider}.user_credential.disconnect`,
        userId,
        resourceType: 'integration-connector',
        resourceId: connectorId,
        details: { connectorName: connector.name },
      });
    }
    return { disconnected };
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

      this.emitConnector(id, 'synced', 'gitlab', { name: row.name, failureCount: 0 });
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
      .where(and(eq(integrationConnectors.provider, 'cloudflare'), eq(integrationConnectors.enabled, true)))
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

      this.emitConnector(id, 'synced', 'cloudflare', { name: row.name, failureCount: 0 });
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
      this.emitConnector(id, 'sync-failed', 'cloudflare', {
        name: row.name,
        failureCount,
        failureCode: this.connectorFailureCode(error),
      });
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
    const result = await context.provider.commitFiles(context.auth, {
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
    const lint = await context.provider.lintCiConfig(
      context.auth,
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
    const result = await context.provider.commitFiles(context.auth, {
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
      requiredScope: 'docker:registries:view',
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
    const archiveReadyPath = `${archivePath}.ready`;
    if (!('streamRepositoryArchive' in context.provider)) {
      throw new AppError(
        501,
        'CONNECTOR_VCS_PROVIDER_UNAVAILABLE',
        'The gitlab VCS provider cannot stream repository archives'
      );
    }
    const connectorSettings = this.gitLabSettings(context.connector);
    const cloneTimeoutSeconds = Math.max(10, connectorSettings.cloneTimeoutSeconds);
    const effectiveTtlSeconds = Math.min(input.ttlSeconds ?? cloneTimeoutSeconds, cloneTimeoutSeconds);
    const processTtlSeconds = effectiveTtlSeconds + cloneTimeoutSeconds;
    const command = [
      'sh',
      '-lc',
      [
        'set -eu',
        `while [ ! -f ${this.shellQuote(`/workspace/${archiveReadyPath}`)} ]; do sleep 0.2; done`,
        `mkdir -p ${this.shellQuote(`/workspace/${targetPath}`)}`,
        `tar -xzf ${this.shellQuote(`/workspace/${archivePath}`)} -C ${this.shellQuote(`/workspace/${targetPath}`)} --strip-components=1`,
        `rm -f ${this.shellQuote(`/workspace/${archivePath}`)} ${this.shellQuote(`/workspace/${archiveReadyPath}`)}`,
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
    let archiveBytes = 0;
    try {
      const archive = await context.provider.streamRepositoryArchive(
        context.auth,
        this.toProviderProject(context.project),
        input.ref,
        {
          maxBytes: connectorSettings.cloneMaxSizeMb * 1024 * 1024,
          timeoutMs: cloneTimeoutSeconds * 1000,
        }
      );
      const uploaded = await sandboxService.uploadArtifactStream(user, {
        processId: process.processId,
        path: archivePath,
        chunks: archive.chunks,
        maxBytes: connectorSettings.cloneMaxSizeMb * 1024 * 1024,
      });
      await sandboxService.uploadArtifact(user, {
        processId: process.processId,
        path: archiveReadyPath,
        contentBase64: '',
      });
      archiveBytes = uploaded.sizeBytes;
    } catch (error) {
      await sandboxService.killProcess(user, process.processId).catch(() => {});
      throw error;
    }
    await this.auditGitLabTool(user, context.connector, GITLAB_AUDIT_ACTIONS.repositoryClone, {
      project: context.project.fullPath,
      ref: input.ref ?? null,
      targetPath,
      archiveBytes,
      processId: process.processId,
    });
    return {
      processId: process.processId,
      jobId: process.jobId,
      path: targetPath,
      ref: input.ref ?? context.project.defaultBranch ?? null,
      archiveBytes,
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
      provider: 'gitlab',
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
    let tokenStatus: Awaited<ReturnType<CloudflareClient['verifyToken']>>;
    try {
      tokenStatus = await client.verifyToken();
    } catch (error) {
      if (!this.isCloudflarePermissionError(error)) throw error;
      throw new AppError(400, 'CLOUDFLARE_TOKEN_INVALID', 'Cloudflare API token is invalid', {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
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
    if (zones.length === 0) {
      throw new AppError(400, 'CLOUDFLARE_ZONE_NOT_FOUND', 'Cloudflare token has no active zones');
    }

    const manageableZones: CloudflareZoneRef[] = [];
    const dnsReadFailures: Array<{ zone: string; cause: string }> = [];
    for (const zone of zones) {
      try {
        await client.probeDnsRead(zone.id);
        manageableZones.push(zone);
      } catch (error) {
        if (!this.isCloudflarePermissionError(error)) throw error;
        dnsReadFailures.push({
          zone: zone.name,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const probeZone = manageableZones[0];
    if (!probeZone) {
      const firstFailure = dnsReadFailures[0];
      throw new AppError(
        400,
        'CLOUDFLARE_DNS_READ_REQUIRED',
        firstFailure
          ? `Cloudflare denied DNS access for ${firstFailure.zone}: ${firstFailure.cause}`
          : 'Cloudflare denied DNS access for every active zone',
        { failures: dnsReadFailures }
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
      zones: manageableZones,
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

  private async resolveGitHubAccount(
    user: User,
    connectorId: string
  ): Promise<{ connector: ConnectorRow; token: string }> {
    const connector = await this.getConnectorRow(connectorId, 'github');
    assertConnectorOperationAccess({
      actor: { userId: user.id, scopes: user.scopes },
      provider: 'github',
      connectorId: connector.id,
      connectorName: connector.name,
      operation: 'repository.list',
      requiredScope: 'integrations:github:view',
    });
    if (!connector.enabled) throw new AppError(409, 'CONNECTOR_DISABLED', `${connector.name} is disabled`);
    if (hasScope(user.scopes, 'integrations:github:system')) {
      if (!connector.encryptedToken) {
        throw new AppError(400, 'CONNECTOR_CREDENTIAL_MISSING', `${connector.name} has no credential`);
      }
      return { connector, token: this.decryptToken(connector.encryptedToken) };
    }
    const personal = await this.gitLabUserCredentials.resolveAuth(user.id, connector.id, connector.baseUrl);
    if (!personal) throw this.gitUserCredentialRequired('github', connector);
    return { connector, token: personal.auth.token };
  }

  private githubActionsName(value: string): string {
    const name = value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new AppError(
        400,
        'GITHUB_ACTIONS_NAME_INVALID',
        'GitHub Actions variable and secret names may contain only letters, numbers, and underscores and cannot start with a number'
      );
    }
    return name;
  }

  private repositoryRelativePath(value: string, allowEmpty: boolean): string {
    const normalized = value
      .trim()
      .replaceAll('\\', '/')
      .replace(/^\/+|\/+$/g, '');
    if (!normalized) {
      if (allowEmpty) return '';
      throw new AppError(400, 'INVALID_REPOSITORY_PATH', 'Repository path is required');
    }
    const parts = normalized.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..' || part.includes('\0')) || parts[0] === '.git') {
      throw new AppError(400, 'INVALID_REPOSITORY_PATH', 'Repository path must remain inside the checkout');
    }
    return parts.join('/');
  }

  private gitRefName(value: string): string {
    const ref = value.trim();
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(ref) ||
      ref.includes('..') ||
      ref.includes('//') ||
      ref.includes('@{') ||
      ref.endsWith('/') ||
      ref.endsWith('.') ||
      ref.endsWith('.lock')
    ) {
      throw new AppError(400, 'INVALID_GIT_REF', 'Git ref is invalid');
    }
    return ref;
  }

  private async resolveRepositoryPath(
    checkoutDir: string,
    relativePath: string,
    expected: 'file' | 'directory'
  ): Promise<string> {
    const canonicalCheckoutDir = await realpath(checkoutDir);
    const target = resolve(canonicalCheckoutDir, relativePath || '.');
    const checkoutRoot = `${canonicalCheckoutDir}${sep}`;
    if (target !== canonicalCheckoutDir && !target.startsWith(checkoutRoot)) {
      throw new AppError(400, 'INVALID_REPOSITORY_PATH', 'Repository path must remain inside the checkout');
    }
    const actual = await realpath(target).catch(() => null);
    if (!actual || (actual !== canonicalCheckoutDir && !actual.startsWith(checkoutRoot))) {
      throw new AppError(404, 'GIT_PATH_NOT_FOUND', 'Repository path was not found');
    }
    const stats = await lstat(actual);
    if (expected === 'file' && !stats.isFile())
      throw new AppError(400, 'GIT_PATH_NOT_FILE', 'Repository path is not a file');
    if (expected === 'directory' && !stats.isDirectory()) {
      throw new AppError(400, 'GIT_PATH_NOT_DIRECTORY', 'Repository path is not a directory');
    }
    return actual;
  }

  private async assertNoRepositorySymlink(checkoutDir: string, relativePath: string): Promise<void> {
    let current = checkoutDir;
    for (const part of relativePath.split('/')) {
      current = join(current, part);
      const stats = await lstat(current).catch(() => null);
      if (!stats) return;
      if (stats.isSymbolicLink()) {
        throw new AppError(400, 'GIT_PATH_SYMLINK', 'Repository writes cannot follow symbolic links');
      }
    }
  }

  private async withGenericGitCheckout<T>(
    user: User,
    input: { connectorId: string; repositoryUrl: string; ref?: string },
    callback: (context: GenericGitExecutionContext) => Promise<T>
  ): Promise<T> {
    const auth = await this.resolveGitRepository(user, 'git', input.connectorId, input.repositoryUrl);
    const temporaryRoot = await mkdtemp(join(tmpdir(), 'gateway-git-'));
    const checkoutDir = join(temporaryRoot, 'checkout');
    const askpassPath = join(temporaryRoot, 'askpass.sh');
    await writeFile(
      askpassPath,
      '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" "$GATEWAY_GIT_USERNAME" ;; *) printf "%s\\n" "$GATEWAY_GIT_SECRET" ;; esac\n',
      { mode: 0o700 }
    );
    await chmod(askpassPath, 0o700);
    const commandContext: GenericGitExecutionContext = {
      checkoutDir: temporaryRoot,
      askpassPath,
      username: auth.username,
      token: auth.token,
      repositoryUrl: auth.repositoryUrl,
    };
    const ref = input.ref?.trim() ? this.gitRefName(input.ref) : null;
    try {
      await this.runGit(
        [
          'clone',
          '--depth',
          '1',
          '--single-branch',
          ...(ref ? ['--branch', ref] : []),
          '--',
          auth.repositoryUrl,
          checkoutDir,
        ],
        commandContext
      );
      return await callback({ ...commandContext, checkoutDir });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  private async runGit(
    args: string[],
    context: GenericGitExecutionContext
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolveCommand, rejectCommand) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const child = spawn('git', ['-c', 'credential.helper=', ...args], {
        cwd: context.checkoutDir,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: context.askpassPath,
          GATEWAY_GIT_USERNAME: context.username,
          GATEWAY_GIT_SECRET: context.token,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), GIT_CHECKOUT_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdout.length < 1_048_576) stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < 32_768) stderr += chunk.toString('utf8');
      });
      child.once('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        rejectCommand(
          new AppError(
            502,
            error.message.includes('ENOENT') ? 'GIT_RUNTIME_UNAVAILABLE' : 'GIT_COMMAND_FAILED',
            error.message.includes('ENOENT') ? 'Git is not installed in the Gateway runtime' : 'Git operation failed'
          )
        );
      });
      child.once('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolveCommand({ stdout, stderr });
          return;
        }
        rejectCommand(
          new AppError(
            400,
            signal === 'SIGKILL' ? 'GIT_COMMAND_TIMEOUT' : 'GIT_COMMAND_FAILED',
            signal === 'SIGKILL' ? 'Git operation exceeded 30 seconds' : 'Git host rejected the repository operation'
          )
        );
      });
    });
  }

  private async resolveGitRepository(
    user: User,
    provider: 'github' | 'git',
    connectorId: string,
    rawRepositoryUrl: string
  ): Promise<{ connector: ConnectorRow; repositoryUrl: string; username: string; token: string }> {
    const connector = await this.getConnectorRow(connectorId, provider);
    assertConnectorOperationAccess({
      actor: { userId: user.id, scopes: user.scopes },
      provider,
      connectorId: connector.id,
      connectorName: connector.name,
      operation: 'repository.read',
      requiredScope: `integrations:${provider}:view`,
    });
    if (!connector.enabled) throw new AppError(409, 'CONNECTOR_DISABLED', `${connector.name} is disabled`);
    const repositoryUrl = this.normalizeRepositoryUrl(rawRepositoryUrl);
    if (new URL(repositoryUrl).host !== new URL(connector.baseUrl).host) {
      throw new AppError(403, 'REPOSITORY_HOST_MISMATCH', 'Repository host does not match the connector host');
    }
    const allowlist = await this.listAllowlistRows(connector.id);
    const allowed =
      connector.allowlistMode === 'all_visible' ||
      allowlist.some(
        (entry) => entry.entryType === 'project' && this.normalizeRepositoryUrl(entry.fullPath) === repositoryUrl
      );
    if (!allowed) {
      throw new AppError(403, 'REPOSITORY_NOT_ALLOWED', 'Repository is not included in this connector');
    }
    if (hasScope(user.scopes, `integrations:${provider}:system`)) {
      if (!connector.encryptedToken) {
        throw new AppError(400, 'CONNECTOR_CREDENTIAL_MISSING', `${connector.name} has no credential`);
      }
      return {
        connector,
        repositoryUrl,
        username: connector.username ?? (provider === 'github' ? 'x-access-token' : ''),
        token: this.decryptToken(connector.encryptedToken),
      };
    }
    const personal = await this.gitLabUserCredentials.resolveAuth(user.id, connector.id, connector.baseUrl);
    if (!personal) throw this.gitUserCredentialRequired(provider, connector);
    return {
      connector,
      repositoryUrl,
      username: personal.gitlabUsername,
      token: personal.auth.token,
    };
  }

  private normalizeRepositoryUrl(rawUrl: string): string {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== 'https:') throw new AppError(400, 'INVALID_REPOSITORY_URL', 'Repository URL must use HTTPS');
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  }

  private githubRepositoryIdentity(repositoryUrl: string): { owner: string; repository: string } {
    const url = new URL(repositoryUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 2) {
      throw new AppError(400, 'INVALID_GITHUB_REPOSITORY', 'GitHub repository URL must identify owner/repository');
    }
    return { owner: segments[0], repository: segments[1].replace(/\.git$/i, '') };
  }

  private async githubConnectorRequest(
    connector: ConnectorRow,
    token: string,
    path: string,
    init: RequestInit = {}
  ): Promise<Response> {
    try {
      return await fetch(githubApiUrl(connector.baseUrl, path), {
        ...init,
        headers: {
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          ...init.headers,
        },
      });
    } catch {
      throw new AppError(502, 'GITHUB_CONNECTION_FAILED', 'GitHub could not be reached');
    }
  }

  private githubRepositoryRequestError(status: number, body: unknown): AppError {
    const message =
      isPlainRecord(body) && typeof body.message === 'string' ? body.message : `GitHub request failed (${status})`;
    return new AppError(
      status === 404 ? 404 : status === 401 || status === 403 ? 403 : 400,
      'GITHUB_REPOSITORY_REQUEST_FAILED',
      message
    );
  }

  private gitUserCredentialRequired(provider: 'github' | 'git', connector: ConnectorRow): AppError {
    return new AppError(
      428,
      provider === 'github' ? 'GITHUB_CREDENTIAL_REQUIRED' : 'GIT_CREDENTIAL_REQUIRED',
      `Personal ${provider === 'github' ? 'GitHub' : 'Git'} authorization is required`,
      { provider, connectorId: connector.id, connectorName: connector.name, baseUrl: connector.baseUrl }
    );
  }

  private async validateGenericGitCredential(connector: ConnectorRow, username: string, token: string) {
    const [repository] = await this.listAllowlistRows(connector.id);
    if (!repository) throw new AppError(400, 'GIT_REPOSITORY_REQUIRED', 'Connector has no repository to validate');
    await this.validateGenericGitAccess(connector.baseUrl, repository.fullPath, username, token);
  }

  private async validateGenericGitAccess(baseUrl: string, repository: string, username: string, token: string) {
    const repositoryUrl = this.normalizeRepositoryUrl(repository);
    if (new URL(repositoryUrl).host !== new URL(baseUrl).host) {
      throw new AppError(403, 'REPOSITORY_HOST_MISMATCH', 'Repository host does not match the connector host');
    }
    const url = new URL(repositoryUrl);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/info/refs`;
    url.searchParams.set('service', 'git-upload-pack');
    const response = await fetch(url, {
      headers: { authorization: `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}` },
    }).catch(() => null);
    if (!response) throw new AppError(502, 'GIT_CONNECTION_FAILED', 'Git host could not be reached');
    if (!response.ok) throw new AppError(400, 'GIT_AUTHORIZATION_INVALID', 'Git host rejected this credential');
  }

  private toSafeGitHubOAuthSession(row: GitHubOAuthSessionRow): GitHubOAuthSession {
    return {
      id: row.id,
      status: row.status,
      userCode: row.userCode,
      verificationUri: row.verificationUri,
      pollIntervalSeconds: row.pollIntervalSeconds,
      expiresAt: row.expiresAt,
      connectorId: row.connectorId,
      errorMessage: row.errorMessage,
    };
  }

  private async getGitHubOAuthSession(id: string, userId: string): Promise<GitHubOAuthSessionRow> {
    const row = await this.db.query.integrationGitHubOAuthSessions.findFirst({
      where: and(eq(integrationGitHubOAuthSessions.id, id), eq(integrationGitHubOAuthSessions.userId, userId)),
    });
    if (!row) throw new AppError(404, 'GITHUB_OAUTH_SESSION_NOT_FOUND', 'GitHub authorization session not found');
    return row;
  }

  private async pollClaimedGitHubOAuthSession(row: GitHubOAuthSessionRow, userId: string): Promise<GitHubOAuthSession> {
    const clientId = getEnv().GITHUB_OAUTH_CLIENT_ID;
    let response: Response;
    try {
      response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          device_code: this.decryptToken(row.encryptedDeviceCode),
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
    } catch {
      return this.resetGitHubOAuthSession(row.id, userId, row.pollIntervalSeconds, 'GitHub authorization check failed');
    }
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    const error = typeof body?.error === 'string' ? body.error : '';
    if (error === 'authorization_pending') return this.resetGitHubOAuthSession(row.id, userId, row.pollIntervalSeconds);
    if (error === 'slow_down') return this.resetGitHubOAuthSession(row.id, userId, row.pollIntervalSeconds + 5);
    if (error === 'expired_token')
      return this.finishGitHubOAuthSession(row.id, userId, 'expired', null, 'Authorization expired');
    if (error === 'access_denied')
      return this.finishGitHubOAuthSession(row.id, userId, 'cancelled', null, 'Authorization denied');
    const accessToken = typeof body?.access_token === 'string' ? body.access_token : '';
    if (!response.ok || !accessToken) {
      return this.failGitHubOAuthSession(row.id, userId, 'GitHub authorization failed');
    }
    try {
      const current = await this.getGitHubOAuthSession(row.id, userId);
      if (current.status !== 'processing') return this.toSafeGitHubOAuthSession(current);
      const connector = await this.createGitConnector(
        'github',
        { ...row.connectorDraft, authMode: 'token', token: accessToken },
        userId,
        'oauth'
      );
      const completed = await this.finishGitHubOAuthSession(row.id, userId, 'complete', connector.id, null);
      if (completed.status !== 'complete') {
        await this.db.delete(integrationConnectors).where(eq(integrationConnectors.id, connector.id));
        this.emitConnector(connector.id, 'deleted');
      }
      return completed;
    } catch (cause) {
      return this.failGitHubOAuthSession(
        row.id,
        userId,
        cause instanceof Error ? cause.message : 'GitHub connector could not be created'
      );
    }
  }

  private async resetGitHubOAuthSession(
    id: string,
    userId: string,
    pollIntervalSeconds: number,
    errorMessage: string | null = null
  ): Promise<GitHubOAuthSession> {
    const [row] = await this.db
      .update(integrationGitHubOAuthSessions)
      .set({ status: 'pending', pollIntervalSeconds, errorMessage, updatedAt: new Date() })
      .where(and(eq(integrationGitHubOAuthSessions.id, id), eq(integrationGitHubOAuthSessions.status, 'processing')))
      .returning();
    return this.toSafeGitHubOAuthSession(row ?? (await this.getGitHubOAuthSession(id, userId)));
  }

  private async finishGitHubOAuthSession(
    id: string,
    userId: string,
    status: 'complete' | 'expired' | 'cancelled' | 'error',
    connectorId: string | null,
    errorMessage: string | null
  ): Promise<GitHubOAuthSession> {
    const [row] = await this.db
      .update(integrationGitHubOAuthSessions)
      .set({ status, connectorId, errorMessage, updatedAt: new Date() })
      .where(and(eq(integrationGitHubOAuthSessions.id, id), eq(integrationGitHubOAuthSessions.status, 'processing')))
      .returning();
    return this.toSafeGitHubOAuthSession(row ?? (await this.getGitHubOAuthSession(id, userId)));
  }

  private failGitHubOAuthSession(id: string, userId: string, message: string) {
    return this.finishGitHubOAuthSession(id, userId, 'error', null, message);
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

  private emitConnector(
    id: string,
    action: string,
    provider: IntegrationProvider = 'gitlab',
    extra: { name?: string; failureCount?: number; failureCode?: string } = {}
  ) {
    this.eventBus?.publish('integration.connector.changed', { id, provider, action, ...extra });
  }

  private connectorFailureCode(error: unknown): string {
    if (error instanceof AppError) return error.code;
    const message = error instanceof Error ? error.message : String(error ?? '');
    if (/401|authentication|unauthorized|token/i.test(message)) return 'authentication_failed';
    if (/403|forbidden|permission/i.test(message)) return 'authorization_failed';
    if (/429|rate.?limit/i.test(message)) return 'rate_limited';
    if (/timeout|network|unreachable|ECONN/i.test(message)) return 'provider_unreachable';
    return 'provider_error';
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
