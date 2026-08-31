import { spawn } from 'node:child_process';
import { chmod, lstat, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { getEnv } from '@/config/env.js';
import {
  type CloudflareConnectorSettings,
  type IntegrationConnectorSettings,
  type IntegrationConnectorSettingsValue,
  integrationConnectors,
  integrationGitHubOAuthSessions,
} from '@/db/schema/index.js';
import { hasScope } from '@/lib/permissions.js';
import { AppError } from '@/middleware/error-handler.js';
import type { User } from '@/types.js';
import { assertConnectorOperationAccess } from './integration-permissions.js';
import type { GitConnectorCreateInput, GitHubConnectorCreateInput } from './integrations.schemas.js';
import {
  type AllowlistRow,
  type ConnectorRow,
  DEFAULT_CLOUDFLARE_CONNECTOR_SETTINGS,
  DEFAULT_GITLAB_CONNECTOR_SETTINGS,
  type GenericGitExecutionContext,
  GIT_CHECKOUT_TIMEOUT_MS,
  type GitHubOAuthCredential,
  type GitHubOAuthSession,
  type GitHubOAuthSessionRow,
  githubApiUrl,
  isPlainRecord,
  type ProjectRow,
  type ProjectRowInput,
  type RegistryRowInput,
} from './integrations.service.core.js';
import { IntegrationsPersistenceService } from './integrations.service.persistence.js';

export abstract class IntegrationsGitSupportService extends IntegrationsPersistenceService {
  abstract createGitConnector(
    provider: 'github' | 'git',
    input: GitConnectorCreateInput | GitHubConnectorCreateInput,
    userId: string,
    authMode?: 'token' | 'oauth',
    oauthCredential?: GitHubOAuthCredential
  ): Promise<{ id: string }>;

  abstract replaceGitHubConnectorAuthentication(
    id: string,
    input: { name: string; enabled: boolean },
    credential: GitHubOAuthCredential,
    userId: string
  ): Promise<{ id: string }>;

  protected async resolveGitHubAccount(
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
      return { connector, token: await this.resolveGitHubConnectorToken(connector) };
    }
    const personal = await this.gitLabUserCredentials.resolveAuth(user.id, connector.id, connector.baseUrl);
    if (!personal) throw this.gitUserCredentialRequired('github', connector);
    return { connector, token: personal.auth.token };
  }

  protected async resolveGitHubConnectorToken(connector: ConnectorRow): Promise<string> {
    if (!connector.encryptedToken) {
      throw new AppError(400, 'CONNECTOR_CREDENTIAL_MISSING', `${connector.name} has no credential`);
    }
    if (connector.authMode !== 'oauth' || !connector.tokenExpiresAt) {
      return this.decryptToken(connector.encryptedToken);
    }
    const refreshBefore = Date.now() + 5 * 60 * 1000;
    if (connector.tokenExpiresAt.getTime() > refreshBefore) {
      return this.decryptToken(connector.encryptedToken);
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`github-oauth-refresh:${connector.id}`}))`);
      const [current] = await tx
        .select()
        .from(integrationConnectors)
        .where(and(eq(integrationConnectors.id, connector.id), eq(integrationConnectors.provider, 'github')))
        .limit(1);
      if (!current?.encryptedToken) {
        throw new AppError(400, 'CONNECTOR_CREDENTIAL_MISSING', `${connector.name} has no credential`);
      }
      if (current.authMode !== 'oauth' || !current.tokenExpiresAt || current.tokenExpiresAt.getTime() > refreshBefore) {
        return this.decryptToken(current.encryptedToken);
      }
      if (
        !current.encryptedRefreshToken ||
        (current.refreshTokenExpiresAt && current.refreshTokenExpiresAt.getTime() <= Date.now())
      ) {
        throw new AppError(
          401,
          'GITHUB_OAUTH_REAUTHORIZATION_REQUIRED',
          'GitHub authorization expired and this connector must be reauthorized'
        );
      }

      const existingToken = this.decryptToken(current.encryptedToken);
      let response: Response;
      try {
        response = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: getEnv().GITHUB_OAUTH_CLIENT_ID,
            grant_type: 'refresh_token',
            refresh_token: this.decryptToken(current.encryptedRefreshToken),
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        if (current.tokenExpiresAt.getTime() > Date.now()) return existingToken;
        throw new AppError(502, 'GITHUB_OAUTH_REFRESH_FAILED', 'GitHub authorization could not be refreshed');
      }
      const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
      const accessToken = typeof body?.access_token === 'string' ? body.access_token : '';
      const refreshToken = typeof body?.refresh_token === 'string' ? body.refresh_token : '';
      const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in : 0;
      const refreshExpiresIn = typeof body?.refresh_token_expires_in === 'number' ? body.refresh_token_expires_in : 0;
      if (!response.ok || !accessToken || !refreshToken || expiresIn <= 0 || refreshExpiresIn <= 0) {
        throw new AppError(
          401,
          'GITHUB_OAUTH_REAUTHORIZATION_REQUIRED',
          'GitHub authorization could not be refreshed; reauthorize this connector'
        );
      }
      const now = Date.now();
      await tx
        .update(integrationConnectors)
        .set({
          encryptedToken: this.encryptToken(accessToken),
          encryptedRefreshToken: this.encryptToken(refreshToken),
          tokenLast4: this.tokenLast4(accessToken),
          tokenExpiresAt: new Date(now + expiresIn * 1000),
          refreshTokenExpiresAt: new Date(now + refreshExpiresIn * 1000),
          syncLastError: null,
          updatedAt: new Date(),
        })
        .where(eq(integrationConnectors.id, current.id));
      return accessToken;
    });
  }

  protected githubActionsName(value: string): string {
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

  protected repositoryRelativePath(value: string, allowEmpty: boolean): string {
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

  protected gitRefName(value: string): string {
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

  protected async resolveRepositoryPath(
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

  protected async assertNoRepositorySymlink(checkoutDir: string, relativePath: string): Promise<void> {
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

  protected async withGenericGitCheckout<T>(
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

  protected async runGit(
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

  protected async resolveGitRepository(
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
        token: await this.resolveGitHubConnectorToken(connector),
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

  protected normalizeRepositoryUrl(rawUrl: string): string {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== 'https:') throw new AppError(400, 'INVALID_REPOSITORY_URL', 'Repository URL must use HTTPS');
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/, '');
  }

  protected githubRepositoryIdentity(repositoryUrl: string): { owner: string; repository: string } {
    const url = new URL(repositoryUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 2) {
      throw new AppError(400, 'INVALID_GITHUB_REPOSITORY', 'GitHub repository URL must identify owner/repository');
    }
    return { owner: segments[0], repository: segments[1].replace(/\.git$/i, '') };
  }

  protected async githubConnectorRequest(
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

  protected githubRepositoryRequestError(status: number, body: unknown): AppError {
    const message =
      isPlainRecord(body) && typeof body.message === 'string' ? body.message : `GitHub request failed (${status})`;
    return new AppError(
      status === 404 ? 404 : status === 401 || status === 403 ? 403 : 400,
      'GITHUB_REPOSITORY_REQUEST_FAILED',
      message
    );
  }

  protected gitUserCredentialRequired(provider: 'github' | 'git', connector: ConnectorRow): AppError {
    return new AppError(
      428,
      provider === 'github' ? 'GITHUB_CREDENTIAL_REQUIRED' : 'GIT_CREDENTIAL_REQUIRED',
      `Personal ${provider === 'github' ? 'GitHub' : 'Git'} authorization is required`,
      { provider, connectorId: connector.id, connectorName: connector.name, baseUrl: connector.baseUrl }
    );
  }

  protected async validateGenericGitCredential(connector: ConnectorRow, username: string, token: string) {
    const [repository] = await this.listAllowlistRows(connector.id);
    if (!repository) throw new AppError(400, 'GIT_REPOSITORY_REQUIRED', 'Connector has no repository to validate');
    await this.validateGenericGitAccess(connector.baseUrl, repository.fullPath, username, token);
  }

  protected async validateGenericGitAccess(baseUrl: string, repository: string, username: string, token: string) {
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

  protected toSafeGitHubOAuthSession(row: GitHubOAuthSessionRow): GitHubOAuthSession {
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

  protected async getGitHubOAuthSession(id: string, userId: string): Promise<GitHubOAuthSessionRow> {
    const row = await this.db.query.integrationGitHubOAuthSessions.findFirst({
      where: and(eq(integrationGitHubOAuthSessions.id, id), eq(integrationGitHubOAuthSessions.userId, userId)),
    });
    if (!row) throw new AppError(404, 'GITHUB_OAUTH_SESSION_NOT_FOUND', 'GitHub authorization session not found');
    return row;
  }

  protected async pollClaimedGitHubOAuthSession(
    row: GitHubOAuthSessionRow,
    userId: string
  ): Promise<GitHubOAuthSession> {
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
    const refreshToken = typeof body?.refresh_token === 'string' ? body.refresh_token : null;
    const expiresIn = typeof body?.expires_in === 'number' ? body.expires_in : 0;
    const refreshExpiresIn = typeof body?.refresh_token_expires_in === 'number' ? body.refresh_token_expires_in : 0;
    const now = Date.now();
    const credential: GitHubOAuthCredential = {
      accessToken,
      refreshToken,
      tokenExpiresAt: expiresIn > 0 ? new Date(now + expiresIn * 1000) : null,
      refreshTokenExpiresAt: refreshExpiresIn > 0 ? new Date(now + refreshExpiresIn * 1000) : null,
    };
    try {
      const current = await this.getGitHubOAuthSession(row.id, userId);
      if (current.status !== 'processing') return this.toSafeGitHubOAuthSession(current);
      const connector = row.connectorDraft.targetConnectorId
        ? await this.replaceGitHubConnectorAuthentication(
            row.connectorDraft.targetConnectorId,
            { name: row.connectorDraft.name, enabled: row.connectorDraft.enabled },
            credential,
            userId
          )
        : await this.createGitConnector(
            'github',
            { ...row.connectorDraft, authMode: 'token', token: accessToken },
            userId,
            'oauth',
            credential
          );
      const completed = await this.finishGitHubOAuthSession(row.id, userId, 'complete', connector.id, null);
      if (completed.status !== 'complete' && !row.connectorDraft.targetConnectorId) {
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

  protected async resetGitHubOAuthSession(
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

  protected async finishGitHubOAuthSession(
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

  protected failGitHubOAuthSession(id: string, userId: string, message: string) {
    return this.finishGitHubOAuthSession(id, userId, 'error', null, message);
  }

  protected mergeSettings(
    patch: Partial<IntegrationConnectorSettings> | undefined,
    base: IntegrationConnectorSettings = DEFAULT_GITLAB_CONNECTOR_SETTINGS
  ): IntegrationConnectorSettings {
    return { ...DEFAULT_GITLAB_CONNECTOR_SETTINGS, ...base, ...patch };
  }

  protected gitLabSettings(row: ConnectorRow): IntegrationConnectorSettings {
    return this.mergeSettings(undefined, row.settings as IntegrationConnectorSettings);
  }

  protected mergeCloudflareSettings(
    patch: Partial<CloudflareConnectorSettings> | undefined,
    base: IntegrationConnectorSettingsValue = DEFAULT_CLOUDFLARE_CONNECTOR_SETTINGS
  ): CloudflareConnectorSettings {
    return { ...DEFAULT_CLOUDFLARE_CONNECTOR_SETTINGS, ...base, ...patch };
  }

  protected filterAllowedProjects<T extends Pick<ProjectRow, 'remoteId' | 'fullPath' | 'name'>>(
    row: ConnectorRow,
    allowlistEntries: AllowlistRow[],
    projects: T[]
  ): T[] {
    if (row.allowlistMode === 'all_visible') return projects;
    return projects.filter((project) => this.isGitLabProjectAllowed(project, allowlistEntries));
  }

  protected filterAllowedRegistries(
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
}
