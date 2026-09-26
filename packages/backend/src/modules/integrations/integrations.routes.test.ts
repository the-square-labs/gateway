import 'reflect-metadata';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { container, TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { boundScopes } from '@/lib/permissions.js';
import { errorHandler } from '@/middleware/error-handler.js';
import { TokensService } from '@/modules/tokens/tokens.service.js';
import { SessionService } from '@/services/session.service.js';
import type { AppEnv, SessionData, User } from '@/types.js';
import { integrationsRoutes } from './integrations.routes.js';
import { clearGitHubScopeTargetCache } from './integrations.service.git-repositories.js';
import { IntegrationsService } from './integrations.service.js';

const USER: User = {
  id: '11111111-1111-4111-8111-111111111111',
  oidcSubject: 'oidc-user',
  email: 'admin@example.com',
  name: 'Admin',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'admin',
  scopes: [],
  isBlocked: false,
};

const SESSION: SessionData = {
  userId: USER.id,
  user: USER,
  accessToken: 'oidc-access-token',
  createdAt: Date.now(),
  expiresAt: Date.now() + 60_000,
  csrfToken: 'csrf-token',
};

function createApp() {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler);
  app.route('/api/integrations', integrationsRoutes);
  return app;
}

function registerServices(scopes: string[], service: Partial<IntegrationsService>) {
  container.registerInstance(TokensService, {
    validateToken: vi.fn().mockResolvedValue({
      user: { ...USER, scopes },
      scopes,
      tokenId: 'token-1',
      tokenPrefix: 'gw_abc1234',
    }),
  } as unknown as TokensService);
  container.registerInstance(IntegrationsService, service as IntegrationsService);
}

function authHeaders() {
  return {
    Authorization: 'Bearer gw_valid',
    'Content-Type': 'application/json',
  };
}

function registerBrowserSession(service: Partial<IntegrationsService>, scopes = ['ai:workspace:use']) {
  container.registerInstance(SessionService, {
    getSession: vi.fn().mockResolvedValue(SESSION),
    validateCsrfToken: vi.fn().mockResolvedValue(true),
    updateSession: vi.fn().mockResolvedValue(undefined),
    refreshSession: vi.fn().mockResolvedValue(false),
  } as unknown as SessionService);
  container.registerInstance(TOKENS.DrizzleClient, {
    query: {
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: USER.id,
          oidcSubject: USER.oidcSubject,
          email: USER.email,
          name: USER.name,
          avatarUrl: USER.avatarUrl,
          groupId: USER.groupId,
          additionalScopes: [],
          isBlocked: USER.isBlocked,
        }),
      },
      permissionGroups: {
        findMany: vi.fn().mockResolvedValue([{ id: USER.groupId, parentId: null, name: USER.groupName, scopes }]),
      },
    },
  } as unknown as DrizzleClient);
  container.registerInstance(IntegrationsService, service as IntegrationsService);
}

function sessionHeaders() {
  return {
    Cookie: 'session_id=session-1',
    'X-CSRF-Token': 'csrf-token',
    'Content-Type': 'application/json',
  };
}

afterEach(() => {
  container.reset();
});

describe('integrations routes', () => {
  it('forwards username for generic Git token connectors', async () => {
    const createGitConnector = vi.fn().mockResolvedValue({ id: 'git-1', hasToken: true });
    registerServices(['integrations:git:manage'], { createGitConnector });

    const response = await createApp().request('/api/integrations/git/connectors', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        name: 'Source',
        baseUrl: 'https://git.example.com',
        username: 'deploy-user',
        token: 'secret-token',
        allowlistEntries: [
          {
            entryType: 'project',
            remoteId: 'https://git.example.com/team/app.git',
            fullPath: 'https://git.example.com/team/app.git',
            name: 'app',
            webUrl: 'https://git.example.com/team/app.git',
          },
        ],
      }),
    });

    expect(response.status).toBe(201);
    expect(createGitConnector).toHaveBeenCalledWith(
      'git',
      expect.objectContaining({ username: 'deploy-user', token: 'secret-token' }),
      USER.id
    );
  });

  it('previews a generic Git credential before the connector is saved', async () => {
    const previewGitConnectorTest = vi.fn().mockResolvedValue({
      success: true,
      baseUrl: 'https://git.example.com',
      capabilities: { projectsView: true, repoRead: true, repoWrite: true },
    });
    registerServices(['integrations:git:manage'], { previewGitConnectorTest });

    const input = {
      baseUrl: 'https://git.example.com',
      repositoryUrl: 'https://git.example.com/team/app.git',
      username: 'deploy-user',
      token: 'secret-token',
    };
    const response = await createApp().request('/api/integrations/git/connectors/preview-test', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(input),
    });

    expect(response.status).toBe(200);
    expect(previewGitConnectorTest).toHaveBeenCalledWith(input);
  });

  it('creates account-wide GitHub token connectors without repository scope', async () => {
    const createGitConnector = vi.fn().mockResolvedValue({ id: 'github-1', allowlistMode: 'all_visible' });
    registerServices(['integrations:github:manage'], { createGitConnector });

    const response = await createApp().request('/api/integrations/github/connectors', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        name: 'GitHub',
        baseUrl: 'https://github.com',
        token: 'github-pat',
        repositoryUrl: 'https://github.com/should/not-be-used',
      }),
    });

    expect(response.status).toBe(201);
    expect(createGitConnector).toHaveBeenCalledWith(
      'github',
      { name: 'GitHub', baseUrl: 'https://github.com', enabled: true, authMode: 'token', token: 'github-pat' },
      USER.id
    );
  });

  it('starts GitHub Device Flow without accepting a token in the request', async () => {
    const startGitHubOAuth = vi.fn().mockResolvedValue({
      id: 'oauth-1',
      status: 'pending',
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
    });
    registerServices(['integrations:github:manage'], { startGitHubOAuth });

    const response = await createApp().request('/api/integrations/github/oauth/sessions', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        name: 'GitHub',
      }),
    });

    expect(response.status).toBe(201);
    expect(startGitHubOAuth).toHaveBeenCalledWith({ name: 'GitHub', enabled: true }, USER.id);
    expect(await response.json()).toMatchObject({ data: { userCode: 'ABCD-EFGH' } });
  });

  it('starts GitHub Device Flow for an existing connector without changing its identity', async () => {
    const startGitHubOAuth = vi.fn().mockResolvedValue({ id: 'oauth-1', status: 'pending' });
    registerServices(['integrations:github:manage'], { startGitHubOAuth });

    const response = await createApp().request('/api/integrations/github/oauth/sessions', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        connectorId: '11111111-1111-4111-8111-111111111111',
        name: 'GitHub',
        enabled: true,
      }),
    });

    expect(response.status).toBe(201);
    expect(startGitHubOAuth).toHaveBeenCalledWith(
      {
        connectorId: '11111111-1111-4111-8111-111111111111',
        name: 'GitHub',
        enabled: true,
      },
      USER.id
    );
  });

  it('authorizes a user-owned generic Git credential through the session-only flow', async () => {
    const authorizeGitUserCredential = vi.fn().mockResolvedValue({ authorized: true, tokenMasked: '****oken' });
    registerBrowserSession({ authorizeGitUserCredential });

    const response = await createApp().request('/api/integrations/git/connectors/connector-1/user-credential', {
      method: 'POST',
      headers: sessionHeaders(),
      body: JSON.stringify({ username: 'deploy-user', token: 'secret-token' }),
    });

    expect(response.status).toBe(200);
    expect(authorizeGitUserCredential).toHaveBeenCalledWith('git', 'connector-1', USER.id, {
      username: 'deploy-user',
      token: 'secret-token',
    });
    expect(await response.json()).toEqual({ data: { authorized: true, tokenMasked: '****oken' } });
  });

  it('requires GitLab manage scope to create connectors', async () => {
    const createGitLabConnector = vi.fn();
    registerServices(['integrations:gitlab:view'], { createGitLabConnector });

    const response = await createApp().request('/api/integrations/gitlab/connectors', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Main', baseUrl: 'https://gitlab.example.com', token: 'glpat-secret' }),
    });

    expect(response.status).toBe(403);
    expect(createGitLabConnector).not.toHaveBeenCalled();
  });

  it('creates connectors with GitLab manage scope', async () => {
    const createGitLabConnector = vi.fn().mockResolvedValue({ id: 'connector-1', tokenMasked: '****cret' });
    registerServices(['integrations:gitlab:manage'], { createGitLabConnector });

    const response = await createApp().request('/api/integrations/gitlab/connectors', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Main', baseUrl: 'https://gitlab.example.com', token: 'glpat-secret' }),
    });

    expect(response.status).toBe(201);
    expect(createGitLabConnector).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Main', baseUrl: 'https://gitlab.example.com', token: 'glpat-secret' }),
      USER.id
    );
    expect(await response.json()).toEqual({ data: { id: 'connector-1', tokenMasked: '****cret' } });
  });

  it('lists and gets connectors with GitLab view scope without raw tokens', async () => {
    const listGitLabConnectors = vi.fn().mockResolvedValue([{ id: 'connector-1', tokenMasked: '****cret' }]);
    const getGitLabConnector = vi.fn().mockResolvedValue({
      id: 'connector-1',
      tokenMasked: '****cret',
      hasToken: true,
      allowlistEntries: [],
    });
    registerServices(['integrations:gitlab:view'], { listGitLabConnectors, getGitLabConnector });

    const listResponse = await createApp().request('/api/integrations/gitlab/connectors', {
      headers: authHeaders(),
    });
    const getResponse = await createApp().request('/api/integrations/gitlab/connectors/connector-1', {
      headers: authHeaders(),
    });

    expect(listResponse.status).toBe(200);
    expect(getResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({ data: [{ id: 'connector-1', tokenMasked: '****cret' }] });
    expect(await getResponse.json()).toEqual({
      data: { id: 'connector-1', tokenMasked: '****cret', hasToken: true, allowlistEntries: [] },
    });
  });

  it('updates connectors with GitLab manage scope using PATCH', async () => {
    const updateGitLabConnector = vi.fn().mockResolvedValue({ id: 'connector-1', name: 'Renamed' });
    registerServices(['integrations:gitlab:manage'], { updateGitLabConnector });

    const response = await createApp().request('/api/integrations/gitlab/connectors/connector-1', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Renamed', settings: { autoSyncIntervalSeconds: 300 } }),
    });

    expect(response.status).toBe(200);
    expect(updateGitLabConnector).toHaveBeenCalledWith(
      'connector-1',
      expect.objectContaining({ name: 'Renamed', settings: { autoSyncIntervalSeconds: 300 } }),
      USER.id
    );
  });

  it('rejects invalid connector URLs before calling the service', async () => {
    const createGitLabConnector = vi.fn();
    registerServices(['integrations:gitlab:manage'], { createGitLabConnector });

    const response = await createApp().request('/api/integrations/gitlab/connectors', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Main', baseUrl: 'not a url', token: 'glpat-secret' }),
    });

    expect(response.status).toBe(400);
    expect(createGitLabConnector).not.toHaveBeenCalled();
  });

  it('rotates connector tokens without returning a raw token', async () => {
    const rotateGitLabConnectorToken = vi.fn().mockResolvedValue({
      id: 'connector-1',
      tokenMasked: '****cret',
      hasToken: true,
    });
    registerServices(['integrations:gitlab:manage'], { rotateGitLabConnectorToken });

    const response = await createApp().request('/api/integrations/gitlab/connectors/connector-1/token', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ token: 'glpat-secret' }),
    });

    expect(response.status).toBe(200);
    expect(rotateGitLabConnectorToken).toHaveBeenCalledWith('connector-1', 'glpat-secret', USER.id);
    expect(await response.json()).toEqual({
      data: { id: 'connector-1', tokenMasked: '****cret', hasToken: true },
    });
  });

  it('rejects personal GitLab credential access through API tokens', async () => {
    const getGitLabUserCredentialStatus = vi.fn();
    const authorizeGitLabUserCredential = vi.fn();
    const disconnectGitLabUserCredential = vi.fn();
    registerServices(['integrations:gitlab:view'], {
      getGitLabUserCredentialStatus,
      authorizeGitLabUserCredential,
      disconnectGitLabUserCredential,
    });
    const app = createApp();

    const statusResponse = await app.request(
      '/api/integrations/gitlab/connectors/11111111-1111-4111-8111-111111111111/user-credential',
      { headers: authHeaders() }
    );
    const authorizeResponse = await app.request(
      '/api/integrations/gitlab/connectors/11111111-1111-4111-8111-111111111111/user-credential',
      {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ token: 'glpat-personal-secret' }),
      }
    );
    const disconnectResponse = await app.request(
      '/api/integrations/gitlab/connectors/11111111-1111-4111-8111-111111111111/user-credential',
      { method: 'DELETE', headers: authHeaders() }
    );

    expect([statusResponse.status, authorizeResponse.status, disconnectResponse.status]).toEqual([403, 403, 403]);
    expect(getGitLabUserCredentialStatus).not.toHaveBeenCalled();
    expect(authorizeGitLabUserCredential).not.toHaveBeenCalled();
    expect(disconnectGitLabUserCredential).not.toHaveBeenCalled();
  });

  it('allows the owning browser session to manage its personal GitLab credential', async () => {
    const status = {
      connectorId: '11111111-1111-4111-8111-111111111111',
      connectorName: 'Main GitLab',
      authorized: false,
      status: 'missing',
    };
    const getGitLabUserCredentialStatus = vi.fn().mockResolvedValue(status);
    const authorizeGitLabUserCredential = vi.fn().mockResolvedValue({
      ...status,
      authorized: true,
      status: 'valid',
      tokenMasked: '****cret',
    });
    const disconnectGitLabUserCredential = vi.fn().mockResolvedValue({ disconnected: true });
    registerBrowserSession({
      getGitLabUserCredentialStatus,
      authorizeGitLabUserCredential,
      disconnectGitLabUserCredential,
    });
    const app = createApp();
    const path = '/api/integrations/gitlab/connectors/11111111-1111-4111-8111-111111111111/user-credential';

    const statusResponse = await app.request(path, { headers: sessionHeaders() });
    const authorizeResponse = await app.request(path, {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({ token: 'glpat-personal-secret' }),
    });
    const disconnectResponse = await app.request(path, { method: 'DELETE', headers: sessionHeaders() });

    expect([statusResponse.status, authorizeResponse.status, disconnectResponse.status]).toEqual([200, 200, 200]);
    expect(getGitLabUserCredentialStatus).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', USER.id);
    expect(authorizeGitLabUserCredential).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      { token: 'glpat-personal-secret' },
      USER.id
    );
    expect(disconnectGitLabUserCredential).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', USER.id);
  });

  it('rejects personal GitLab credential access without AI use scope', async () => {
    const getGitLabUserCredentialStatus = vi.fn();
    const authorizeGitLabUserCredential = vi.fn();
    const disconnectGitLabUserCredential = vi.fn();
    registerBrowserSession(
      {
        getGitLabUserCredentialStatus,
        authorizeGitLabUserCredential,
        disconnectGitLabUserCredential,
      },
      []
    );
    const app = createApp();
    const path = '/api/integrations/gitlab/connectors/11111111-1111-4111-8111-111111111111/user-credential';

    const statusResponse = await app.request(path, { headers: sessionHeaders() });
    const authorizeResponse = await app.request(path, {
      method: 'PUT',
      headers: sessionHeaders(),
      body: JSON.stringify({ token: 'glpat-personal-secret' }),
    });
    const disconnectResponse = await app.request(path, { method: 'DELETE', headers: sessionHeaders() });

    expect([statusResponse.status, authorizeResponse.status, disconnectResponse.status]).toEqual([403, 403, 403]);
    expect(getGitLabUserCredentialStatus).not.toHaveBeenCalled();
    expect(authorizeGitLabUserCredential).not.toHaveBeenCalled();
    expect(disconnectGitLabUserCredential).not.toHaveBeenCalled();
  });

  it('tests syncs deletes and searches allowlist through manage scope', async () => {
    const deleteGitLabConnector = vi.fn().mockResolvedValue(undefined);
    const testGitLabConnector = vi.fn().mockResolvedValue({ id: 'connector-1', syncStatus: 'idle' });
    const syncGitLabConnector = vi.fn().mockResolvedValue({ status: 'success', projectCount: 1, registryCount: 1 });
    const searchGitLabAllowlist = vi
      .fn()
      .mockResolvedValue([{ entryType: 'project', remoteId: '1', fullPath: 'group/project', name: 'project' }]);
    const listGitLabAllowlistOptions = vi
      .fn()
      .mockResolvedValue([{ entryType: 'project', remoteId: '2', fullPath: 'group/other', name: 'other' }]);
    const refreshGitLabAllowlistOptions = vi
      .fn()
      .mockResolvedValue([{ entryType: 'project', remoteId: '3', fullPath: 'group/new', name: 'new' }]);
    registerServices(['integrations:gitlab:manage'], {
      deleteGitLabConnector,
      testGitLabConnector,
      syncGitLabConnector,
      searchGitLabAllowlist,
      listGitLabAllowlistOptions,
      refreshGitLabAllowlistOptions,
    });

    const app = createApp();
    const testResponse = await app.request('/api/integrations/gitlab/connectors/connector-1/test', {
      method: 'POST',
      headers: authHeaders(),
    });
    const syncResponse = await app.request('/api/integrations/gitlab/connectors/connector-1/sync', {
      method: 'POST',
      headers: authHeaders(),
    });
    const searchResponse = await app.request(
      '/api/integrations/gitlab/connectors/connector-1/allowlist/search?q=group',
      {
        headers: authHeaders(),
      }
    );
    const optionsResponse = await app.request('/api/integrations/gitlab/connectors/connector-1/allowlist/options', {
      headers: authHeaders(),
    });
    const refreshOptionsResponse = await app.request(
      '/api/integrations/gitlab/connectors/connector-1/allowlist/options/refresh',
      {
        method: 'POST',
        headers: authHeaders(),
      }
    );
    const deleteResponse = await app.request('/api/integrations/gitlab/connectors/connector-1', {
      method: 'DELETE',
      headers: authHeaders(),
    });

    expect(testResponse.status).toBe(200);
    expect(syncResponse.status).toBe(200);
    expect(searchResponse.status).toBe(200);
    expect(optionsResponse.status).toBe(200);
    expect(refreshOptionsResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(testGitLabConnector).toHaveBeenCalledWith('connector-1', USER.id);
    expect(syncGitLabConnector).toHaveBeenCalledWith('connector-1', USER.id);
    expect(searchGitLabAllowlist).toHaveBeenCalledWith('connector-1', 'group');
    expect(listGitLabAllowlistOptions).toHaveBeenCalledWith('connector-1');
    expect(refreshGitLabAllowlistOptions).toHaveBeenCalledWith('connector-1', USER.id);
    expect(deleteGitLabConnector).toHaveBeenCalledWith('connector-1', USER.id);
  });

  it('previews allowlist search before saving a connector through manage scope', async () => {
    const searchGitLabAllowlistPreview = vi
      .fn()
      .mockResolvedValue([{ entryType: 'project', remoteId: '1', fullPath: 'group/project', name: 'project' }]);
    registerServices(['integrations:gitlab:manage'], { searchGitLabAllowlistPreview });

    const response = await createApp().request('/api/integrations/gitlab/allowlist/preview-search', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ baseUrl: 'https://gitlab.example.com', token: 'glpat-secret', q: 'group' }),
    });

    expect(response.status).toBe(200);
    expect(searchGitLabAllowlistPreview).toHaveBeenCalledWith({
      baseUrl: 'https://gitlab.example.com',
      token: 'glpat-secret',
      q: 'group',
    });
    expect(await response.json()).toEqual({
      data: [{ entryType: 'project', remoteId: '1', fullPath: 'group/project', name: 'project' }],
    });
  });

  it('previews connection tests before saving a connector through manage scope', async () => {
    const testGitLabConnectorPreview = vi.fn().mockResolvedValue({
      capabilities: { api: true, projects: true },
      allowlistEntries: [{ entryType: 'project', remoteId: '1', fullPath: 'group/project', name: 'project' }],
    });
    registerServices(['integrations:gitlab:manage'], { testGitLabConnectorPreview });

    const response = await createApp().request('/api/integrations/gitlab/connectors/preview-test', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ baseUrl: 'https://gitlab.example.com', token: 'glpat-secret' }),
    });

    expect(response.status).toBe(200);
    expect(testGitLabConnectorPreview).toHaveBeenCalledWith({
      baseUrl: 'https://gitlab.example.com',
      token: 'glpat-secret',
    });
    expect(await response.json()).toEqual({
      data: {
        capabilities: { api: true, projects: true },
        allowlistEntries: [{ entryType: 'project', remoteId: '1', fullPath: 'group/project', name: 'project' }],
      },
    });
  });

  it('creates previews tests syncs rotates and deletes Cloudflare connectors through manage scope', async () => {
    const createCloudflareConnector = vi.fn().mockResolvedValue({ id: 'cf-1', tokenMasked: '****cret' });
    const testCloudflareConnectorPreview = vi.fn().mockResolvedValue({
      capabilities: { apiReachable: true, tokenActive: true, zonesRead: true, dnsRead: true, dnsEdit: true },
      zones: [{ remoteId: 'zone-1', name: 'example.com' }],
    });
    const testCloudflareConnector = vi.fn().mockResolvedValue({ id: 'cf-1', syncStatus: 'idle' });
    const syncCloudflareConnector = vi.fn().mockResolvedValue({ status: 'success', zoneCount: 1 });
    const rotateCloudflareConnectorToken = vi.fn().mockResolvedValue({ id: 'cf-1', tokenMasked: '****cret' });
    const deleteCloudflareConnector = vi.fn().mockResolvedValue(undefined);
    registerServices(['integrations:cloudflare:manage'], {
      createCloudflareConnector,
      testCloudflareConnectorPreview,
      testCloudflareConnector,
      syncCloudflareConnector,
      rotateCloudflareConnectorToken,
      deleteCloudflareConnector,
    });

    const app = createApp();
    const createResponse = await app.request('/api/integrations/cloudflare/connectors', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Cloudflare', token: 'cf-secret' }),
    });
    const previewResponse = await app.request('/api/integrations/cloudflare/connectors/preview-test', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ token: 'cf-secret' }),
    });
    const testResponse = await app.request('/api/integrations/cloudflare/connectors/cf-1/test', {
      method: 'POST',
      headers: authHeaders(),
    });
    const syncResponse = await app.request('/api/integrations/cloudflare/connectors/cf-1/sync', {
      method: 'POST',
      headers: authHeaders(),
    });
    const rotateResponse = await app.request('/api/integrations/cloudflare/connectors/cf-1/token', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ token: 'cf-secret-2' }),
    });
    const deleteResponse = await app.request('/api/integrations/cloudflare/connectors/cf-1', {
      method: 'DELETE',
      headers: authHeaders(),
    });

    expect(createResponse.status).toBe(201);
    expect(previewResponse.status).toBe(200);
    expect(testResponse.status).toBe(200);
    expect(syncResponse.status).toBe(200);
    expect(rotateResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(createCloudflareConnector).toHaveBeenCalledWith(expect.objectContaining({ name: 'Cloudflare' }), USER.id);
    expect(testCloudflareConnectorPreview).toHaveBeenCalledWith({ token: 'cf-secret' });
    expect(testCloudflareConnector).toHaveBeenCalledWith('cf-1', USER.id);
    expect(syncCloudflareConnector).toHaveBeenCalledWith('cf-1', USER.id);
    expect(rotateCloudflareConnectorToken).toHaveBeenCalledWith('cf-1', 'cf-secret-2', USER.id);
    expect(deleteCloudflareConnector).toHaveBeenCalledWith('cf-1', USER.id);
  });

  it('allows Cloudflare viewers to list connectors and zones without manage scope', async () => {
    const listCloudflareConnectors = vi.fn().mockResolvedValue([{ id: 'cf-1', tokenMasked: '****cret' }]);
    const getCloudflareConnector = vi.fn().mockResolvedValue({ id: 'cf-1', tokenMasked: '****cret' });
    const listCloudflareZones = vi.fn().mockResolvedValue([{ remoteId: 'zone-1', name: 'example.com' }]);
    const createCloudflareConnector = vi.fn();
    registerServices(['integrations:cloudflare:view'], {
      listCloudflareConnectors,
      getCloudflareConnector,
      listCloudflareZones,
      createCloudflareConnector,
    });

    const app = createApp();
    const listResponse = await app.request('/api/integrations/cloudflare/connectors', { headers: authHeaders() });
    const getResponse = await app.request('/api/integrations/cloudflare/connectors/cf-1', { headers: authHeaders() });
    const zonesResponse = await app.request('/api/integrations/cloudflare/connectors/cf-1/zones', {
      headers: authHeaders(),
    });
    const createResponse = await app.request('/api/integrations/cloudflare/connectors', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ name: 'Cloudflare', token: 'cf-secret' }),
    });

    expect(listResponse.status).toBe(200);
    expect(getResponse.status).toBe(200);
    expect(zonesResponse.status).toBe(200);
    expect(createResponse.status).toBe(403);
    expect(listCloudflareConnectors).toHaveBeenCalled();
    expect(getCloudflareConnector).toHaveBeenCalledWith('cf-1');
    expect(listCloudflareZones).toHaveBeenCalledWith('cf-1');
    expect(createCloudflareConnector).not.toHaveBeenCalled();
  });

  it('syncs Cloudflare with its sync scope and Git providers with manage (which absorbed :sync)', async () => {
    const syncCloudflareConnector = vi.fn().mockResolvedValue({ status: 'success', zoneCount: 1 });
    const syncGitConnector = vi.fn().mockResolvedValue({ id: 'git-1', allowlistEntries: [] });
    const syncGitLabConnector = vi.fn().mockResolvedValue({ status: 'success', projectCount: 1 });
    const testCloudflareConnector = vi.fn();
    const deleteGitConnector = vi.fn();
    registerServices(
      ['integrations:cloudflare:sync', 'integrations:github:sync', 'integrations:git:sync', 'integrations:gitlab:sync'],
      { syncCloudflareConnector, syncGitConnector, syncGitLabConnector, testCloudflareConnector, deleteGitConnector }
    );

    const app = createApp();
    const post = (path: string) => app.request(`/api/integrations/${path}`, { method: 'POST', headers: authHeaders() });

    expect((await post('cloudflare/connectors/cf-1/sync')).status).toBe(200);
    // The removed Git provider :sync scopes no longer grant anything on their own.
    expect((await post('github/connectors/gh-1/sync')).status).toBe(403);
    expect((await post('git/connectors/git-1/sync')).status).toBe(403);
    expect((await post('gitlab/connectors/gl-1/sync')).status).toBe(403);
    expect((await post('cloudflare/connectors/cf-1/test')).status).toBe(403);
    expect(
      (await app.request('/api/integrations/git/connectors/git-1', { method: 'DELETE', headers: authHeaders() })).status
    ).toBe(403);

    expect(syncCloudflareConnector).toHaveBeenCalledWith('cf-1', USER.id);
    expect(syncGitConnector).not.toHaveBeenCalled();
    expect(syncGitLabConnector).not.toHaveBeenCalled();
    expect(testCloudflareConnector).not.toHaveBeenCalled();
    expect(deleteGitConnector).not.toHaveBeenCalled();
  });

  it('syncs every Git provider with its manage scope', async () => {
    const syncGitConnector = vi.fn().mockResolvedValue({ id: 'git-1', allowlistEntries: [] });
    const syncGitLabConnector = vi.fn().mockResolvedValue({ status: 'success', projectCount: 1 });
    registerServices(['integrations:github:manage', 'integrations:git:manage', 'integrations:gitlab:manage'], {
      syncGitConnector,
      syncGitLabConnector,
    });

    const app = createApp();
    const post = (path: string) => app.request(`/api/integrations/${path}`, { method: 'POST', headers: authHeaders() });

    expect((await post('github/connectors/gh-1/sync')).status).toBe(200);
    expect((await post('git/connectors/git-1/sync')).status).toBe(200);
    expect((await post('gitlab/connectors/gl-1/sync')).status).toBe(200);
    expect(syncGitConnector).toHaveBeenCalledWith('github', 'gh-1', USER.id);
    expect(syncGitConnector).toHaveBeenCalledWith('git', 'git-1', USER.id);
    expect(syncGitLabConnector).toHaveBeenCalledWith('gl-1', USER.id);
  });

  it('keeps accepting the provider manage scope on sync routes', async () => {
    const syncGitConnector = vi.fn().mockResolvedValue({ id: 'gh-1', allowlistEntries: [] });
    registerServices(['integrations:github:manage'], { syncGitConnector });

    const response = await createApp().request('/api/integrations/github/connectors/gh-1/sync', {
      method: 'POST',
      headers: authHeaders(),
    });

    expect(response.status).toBe(200);
    expect(syncGitConnector).toHaveBeenCalledWith('github', 'gh-1', USER.id);
  });
});

describe('Git scope restrictions on connector routes', () => {
  const GITLAB = '44444444-4444-4444-8444-444444444444';
  const OTHER = '55555555-5555-4555-8555-555555555555';

  it('lists only connectors the caller holds a Git scope on and keeps connector management on the connector', async () => {
    const listGitLabConnectors = vi.fn().mockResolvedValue([
      { id: GITLAB, name: 'Main' },
      { id: OTHER, name: 'Other' },
    ]);
    const listGitConnectors = vi.fn().mockResolvedValue([
      { id: GITLAB, name: 'GitHub', allowlistEntries: [{ fullPath: 'acme/app' }] },
      { id: OTHER, name: 'Other GitHub', allowlistEntries: [{ fullPath: 'globex/app' }] },
    ]);
    const syncGitLabConnector = vi.fn().mockResolvedValue({ status: 'success' });
    registerServices(
      [
        `integrations:gitlab:repo:read:${GITLAB}/group/7`,
        `integrations:gitlab:manage:${OTHER}`,
        `integrations:github:use:${GITLAB}/repo/123`,
      ],
      { listGitLabConnectors, listGitConnectors, syncGitLabConnector }
    );
    const app = createApp();

    const gitlab = await app.request('/api/integrations/gitlab/connectors', { headers: authHeaders() });
    expect(gitlab.status).toBe(200);
    const gitlabBody = (await gitlab.json()) as { data: { id: string }[] };
    expect(gitlabBody.data.map((row) => row.id)).toEqual([GITLAB, OTHER]);

    const github = await app.request('/api/integrations/github/connectors', { headers: authHeaders() });
    // Seen only through a repository grant: no allowlist details.
    const githubBody = (await github.json()) as { data: unknown[] };
    expect(githubBody.data).toEqual([{ id: GITLAB, name: 'GitHub', allowlistEntries: [] }]);

    const post = (id: string) =>
      app.request(`/api/integrations/gitlab/connectors/${id}/sync`, { method: 'POST', headers: authHeaders() });
    expect((await post(OTHER)).status).toBe(200);
    // A group grant never manages the connection.
    expect((await post(GITLAB)).status).toBe(403);
    expect(syncGitLabConnector).toHaveBeenCalledTimes(1);
    const details = await app.request(`/api/integrations/gitlab/connectors/${GITLAB}`, { headers: authHeaders() });
    expect(details.status).toBe(403);
  });
});

describe('Git scope picker endpoints', () => {
  const CONNECTOR = '33333333-3333-4333-8333-333333333333';
  const OTHER = '55555555-5555-4555-8555-555555555555';

  function githubService() {
    const request = vi.fn(async (_connector: unknown, _token: string, path: string) => {
      if (path.startsWith('/user/repos')) {
        return new Response(
          JSON.stringify([
            { id: 123, full_name: 'acme/app', owner: { id: 7, login: 'acme', type: 'Organization' } },
            { id: 124, full_name: 'globex/other', owner: { id: 8, login: 'globex', type: 'User' } },
          ]),
          { status: 200 }
        );
      }
      if (path.startsWith('/user/orgs')) {
        return new Response(JSON.stringify([{ id: 9, login: 'initech' }]), { status: 200 });
      }
      if (path === '/user/7') return new Response(JSON.stringify({ login: 'acme' }), { status: 200 });
      if (path === '/repositories/123') {
        return new Response(JSON.stringify({ full_name: 'acme/app', owner: { id: 7 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 });
    });
    const service = Object.assign(Object.create(IntegrationsService.prototype), {
      getConnectorRow: vi.fn(async (id: string) => ({
        id,
        provider: 'github',
        name: 'GitHub',
        enabled: true,
        baseUrl: 'https://github.com',
        encryptedToken: 'encrypted',
      })),
      resolveGitHubConnectorToken: vi.fn().mockResolvedValue('connector-token'),
      githubConnectorRequest: request,
    });
    return { service: service as IntegrationsService, request };
  }

  function get(path: string) {
    return createApp().request(`/api/integrations/${path}`, { headers: authHeaders() });
  }

  afterEach(() => clearGitHubScopeTargetCache());

  it('searches GitHub owners and repositories the caller may view, with a cached catalog', async () => {
    const { service, request } = githubService();
    registerServices(['integrations:github:view'], service);

    const all = await get(`github/${CONNECTOR}/scope-targets?search=&limit=50`);
    expect(all.status).toBe(200);
    expect(await all.json()).toEqual({
      owners: [
        { id: '7', login: 'acme', type: 'Organization' },
        { id: '8', login: 'globex', type: 'User' },
        { id: '9', login: 'initech', type: 'Organization' },
      ],
      repos: [
        { id: '123', fullName: 'acme/app' },
        { id: '124', fullName: 'globex/other' },
      ],
    });
    const searched = await get(`github/${CONNECTOR}/scope-targets?search=ACME&limit=1`);
    expect(await searched.json()).toEqual({
      owners: [{ id: '7', login: 'acme', type: 'Organization' }],
      repos: [{ id: '123', fullName: 'acme/app' }],
    });
    // One catalog load (repositories and organizations) serves both searches.
    expect(request.mock.calls.filter(([, , path]) => String(path).startsWith('/user/repos'))).toHaveLength(1);
  });

  it.each([
    [[`integrations:github:use:${CONNECTOR}/owner/7`], ['7'], ['123']],
    [[`integrations:github:repo:read:${CONNECTOR}/repo/124`], [], ['124']],
    [[`integrations:github:view:${CONNECTOR}`], ['7', '8', '9'], ['123', '124']],
  ])('limits GitHub picker results to %j', async (scopes, owners, repos) => {
    const { service } = githubService();
    registerServices(scopes, service);

    const response = await get(`github/${CONNECTOR}/scope-targets`);
    const body = (await response.json()) as { owners: { id: string }[]; repos: { id: string }[] };
    expect(body.owners.map((owner) => owner.id)).toEqual(owners);
    expect(body.repos.map((repo) => repo.id)).toEqual(repos);
  });

  it('limits a token to what both it and its owner cover', async () => {
    const { service } = githubService();
    const owner = [`integrations:github:view:${CONNECTOR}/repo/123`];
    container.registerInstance(TokensService, {
      validateToken: vi.fn().mockResolvedValue({
        user: { ...USER, scopes: owner, accountScopes: owner },
        // The token names the whole owner 7; its owner holds one repository of it.
        scopes: boundScopes([`integrations:github:view:${CONNECTOR}/owner/7`], owner),
        tokenId: 'token-1',
        tokenPrefix: 'gw_abc1234',
      }),
    } as unknown as TokensService);
    container.registerInstance(IntegrationsService, service);

    const body = (await (await get(`github/${CONNECTOR}/scope-targets`)).json()) as {
      owners: { id: string }[];
      repos: { id: string }[];
    };
    expect(body.owners).toEqual([]);
    expect(body.repos.map((repo) => repo.id)).toEqual(['123']);
  });

  it('refuses callers without a GitHub grant on the connector and validates the request', async () => {
    const { service, request } = githubService();
    registerServices([`integrations:github:view:${OTHER}`, 'integrations:gitlab:view'], service);

    expect((await get(`github/${CONNECTOR}/scope-targets`)).status).toBe(403);
    expect((await get(`github/not-a-uuid/scope-targets`)).status).toBe(400);
    expect((await get(`git/${CONNECTOR}/scope-targets`)).status).toBe(400);
    expect((await get(`github/${OTHER}/scope-targets?limit=500`)).status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it('resolves stored GitHub qualifiers without revealing targets the caller cannot view', async () => {
    const { service } = githubService();
    registerServices([`integrations:github:view:${CONNECTOR}/owner/7`], service);

    const response = await get(`github/${CONNECTOR}/scope-targets/resolve?ids=owner/7,repo/123,repo/124,owner/8`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [
        { qualifier: 'owner/7', label: 'acme', missing: false },
        { qualifier: 'repo/123', label: 'acme/app', missing: false },
        { qualifier: 'repo/124', label: 'repo/124', missing: false },
        { qualifier: 'owner/8', label: 'owner/8', missing: false },
      ],
    });

    registerServices([`integrations:github:view:${CONNECTOR}`], githubService().service);
    const missing = await get(`github/${CONNECTOR}/scope-targets/resolve?ids=repo/999`);
    expect(await missing.json()).toEqual({ items: [{ qualifier: 'repo/999', label: 'repo/999', missing: true }] });
    expect((await get(`github/${CONNECTOR}/scope-targets/resolve?ids=group/1`)).status).toBe(400);
  });

  it('documents both picker endpoints in OpenAPI', () => {
    const document = integrationsRoutes.getOpenAPIDocument({
      openapi: '3.0.0',
      info: { title: 'test', version: '1' },
    }) as { paths: Record<string, { get?: { parameters?: { name: string }[] } }> };
    const search = document.paths['/{provider}/{connectorId}/scope-targets']?.get;
    const resolve = document.paths['/{provider}/{connectorId}/scope-targets/resolve']?.get;
    expect(search?.parameters?.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining(['provider', 'connectorId', 'search', 'limit'])
    );
    expect(resolve?.parameters?.map((parameter) => parameter.name)).toEqual(
      expect.arrayContaining(['provider', 'connectorId', 'ids'])
    );
  });
});
