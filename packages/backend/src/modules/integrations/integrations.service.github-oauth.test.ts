import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import type { ConnectorRow } from './integrations.service.core.js';
import { IntegrationsService } from './integrations.service.js';

vi.mock('@/config/env.js', () => ({
  getEnv: () => ({ GITHUB_OAUTH_CLIENT_ID: 'github-client-id' }),
}));

const connectorId = '11111111-1111-4111-8111-111111111111';

function encrypted(value: string) {
  return JSON.stringify({ value });
}

function oauthConnector(overrides: Partial<ConnectorRow> = {}): ConnectorRow {
  return {
    id: connectorId,
    provider: 'github',
    name: 'GitHub',
    baseUrl: 'https://github.com',
    enabled: true,
    authMode: 'oauth',
    username: 'knownout',
    encryptedToken: encrypted('old-access-token'),
    encryptedRefreshToken: encrypted('old-refresh-token'),
    tokenLast4: 'oken',
    tokenExpiresAt: new Date(Date.now() - 1_000),
    refreshTokenExpiresAt: new Date(Date.now() + 60_000),
    allowlistMode: 'all_visible',
    settings: { repositoryMode: 'multi_repository', autoSyncEnabled: true, autoSyncIntervalSeconds: 900 },
    capabilities: {},
    syncStatus: 'success',
    syncLastError: null,
    syncFailureCount: 0,
    syncStartedAt: null,
    syncFinishedAt: null,
    syncLastOverlapAt: null,
    syncNextRetryAt: null,
    testedAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

class TestIntegrationsService extends IntegrationsService {
  resolveToken(connector: ConnectorRow) {
    return this.resolveGitHubConnectorToken(connector);
  }
}

function createService(db: DrizzleClient) {
  return new TestIntegrationsService(
    db,
    { log: vi.fn().mockResolvedValue(undefined) } as never,
    {
      encryptString: vi.fn((value: string) => ({ value })),
      decryptString: vi.fn((value: { value: string }) => value.value),
    } as never
  );
}

describe('GitHub OAuth connector credentials', () => {
  it('rotates an expiring device-flow token and persists the new refresh pair', async () => {
    const connector = oauthConnector();
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([connector]) })),
        })),
      })),
      update: vi.fn(() => ({ set })),
    };
    const db = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<string>) => callback(tx)),
    } as unknown as DrizzleClient;
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 28_800,
            refresh_token_expires_in: 15_897_600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );

    try {
      await expect(createService(db).resolveToken(connector)).resolves.toBe('new-access-token');
      expect(tx.execute).toHaveBeenCalledOnce();
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          encryptedToken: encrypted('new-access-token'),
          encryptedRefreshToken: encrypted('new-refresh-token'),
          tokenLast4: 'oken',
          tokenExpiresAt: expect.any(Date),
          refreshTokenExpiresAt: expect.any(Date),
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('requires reauthorization when an expiring OAuth token has no usable refresh token', async () => {
    const connector = oauthConnector({ encryptedRefreshToken: null });
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([connector]) })),
        })),
      })),
    };
    const db = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => Promise<string>) => callback(tx)),
    } as unknown as DrizzleClient;

    await expect(createService(db).resolveToken(connector)).rejects.toMatchObject({
      statusCode: 401,
      code: 'GITHUB_OAUTH_REAUTHORIZATION_REQUIRED',
    });
  });

  it('returns a dependency conflict instead of leaking a database foreign-key error on delete', async () => {
    const connector = oauthConnector();
    let selectCall = 0;
    const deleteRow = vi.fn();
    const db = {
      select: vi.fn(() => {
        selectCall += 1;
        const rows = selectCall === 1 ? [connector] : [{ id: 'binding-1', targetKind: 'pages' }];
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) })),
          })),
        };
      }),
      delete: deleteRow,
    } as unknown as DrizzleClient;

    await expect(createService(db).deleteGitConnector('github', connectorId, 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'GIT_CONNECTOR_IN_USE',
      message: 'GitHub connector is used by source projects or workloads and cannot be deleted',
    });
    expect(deleteRow).not.toHaveBeenCalled();
  });

  it('maps a concurrent source-binding foreign-key race to the same dependency conflict', async () => {
    const connector = oauthConnector();
    let selectCall = 0;
    const db = {
      select: vi.fn(() => {
        selectCall += 1;
        const rows = selectCall === 1 ? [connector] : [];
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue(rows) })),
          })),
        };
      }),
      delete: vi.fn(() => ({
        where: vi.fn().mockRejectedValue({ code: '23503' }),
      })),
    } as unknown as DrizzleClient;

    await expect(createService(db).deleteGitConnector('github', connectorId, 'user-1')).rejects.toMatchObject({
      statusCode: 409,
      code: 'GIT_CONNECTOR_IN_USE',
    });
  });

  it('does not cancel a Device Flow session after token exchange has claimed it', async () => {
    const processing = {
      id: '22222222-2222-4222-8222-222222222222',
      userId: '33333333-3333-4333-8333-333333333333',
      encryptedDeviceCode: encrypted('device-code'),
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://github.com/login/device',
      connectorDraft: {
        targetConnectorId: connectorId,
        name: 'GitHub',
        baseUrl: 'https://github.com',
        enabled: true,
        repositoryMode: 'multi_repository',
      },
      status: 'processing' as const,
      pollIntervalSeconds: 5,
      lastPolledAt: new Date(),
      connectorId: null,
      errorMessage: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const db = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: vi.fn().mockResolvedValue([]) })),
        })),
      })),
      query: {
        integrationGitHubOAuthSessions: {
          findFirst: vi.fn().mockResolvedValue(processing),
        },
      },
    } as unknown as DrizzleClient;

    await expect(createService(db).cancelGitHubOAuth(processing.id, processing.userId)).resolves.toMatchObject({
      status: 'processing',
      connectorId: null,
    });
  });
});
