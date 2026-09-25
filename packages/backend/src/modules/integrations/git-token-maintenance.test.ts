import { describe, expect, it, vi } from 'vitest';
import { AppError } from '@/middleware/error-handler.js';
import {
  canSelfRotate,
  isRotationDue,
  previousLifetimeDays,
  rotationLifetimeCandidates,
  runGitTokenMaintenance,
} from './git-token-maintenance.js';
import { GitLabUserCredentialsService } from './gitlab-user-credentials.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const now = new Date('2030-06-01T00:00:00.000Z');
const inDays = (days: number) => new Date(now.getTime() + days * DAY_MS);

const connector = {
  id: 'gl-1',
  name: 'GitLab',
  provider: 'gitlab',
  enabled: true,
  authMode: 'token',
  baseUrl: 'https://gitlab.example.com',
  encryptedToken: 'enc(old-token)',
  tokenExpiresAt: null as Date | null,
};

interface Setup {
  connectors?: Array<Record<string, unknown>>;
  credentials?: Array<Record<string, unknown>>;
  provider?: Record<string, unknown>;
  /** Stored ciphertext the rotation re-reads under its lock (defaults to the listed one). */
  storedToken?: string | null;
  /** Rows the compare-and-swap write updates. */
  casRows?: number;
}

function context(setup: Setup = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const lockKeys: string[] = [];
  const connectors = setup.connectors ?? [];
  const txUpdateWhere = vi.fn();
  const tx = {
    execute: vi.fn(async (statement: unknown) => {
      lockKeys.push(JSON.stringify(statement));
    }),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [
            {
              encryptedToken:
                setup.storedToken === undefined
                  ? (connectors[0]?.encryptedToken ?? setup.credentials?.[0]?.encryptedToken)
                  : setup.storedToken,
            },
          ]),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updates.push({ cas: true, ...values });
        return {
          where: vi.fn((where: unknown) => {
            txUpdateWhere(where);
            return { returning: vi.fn(async () => Array.from({ length: setup.casRows ?? 1 }, () => ({ id: 'x' }))) };
          }),
        };
      }),
    })),
  };
  const database = {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn().mockResolvedValue(connectors) })) })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => {
        updates.push(values);
        return { where: vi.fn().mockResolvedValue(undefined) };
      }),
    })),
    transaction: vi.fn(async (fn: (inner: typeof tx) => unknown) => fn(tx)),
  };
  const credentials = {
    listValid: vi.fn().mockResolvedValue(setup.credentials ?? []),
    decryptToken: vi.fn((row: { encryptedToken: string }) => row.encryptedToken.replace(/^enc\(|\)$/g, '')),
    storeRotated: vi.fn().mockResolvedValue(true),
  };
  const auditService = { log: vi.fn().mockResolvedValue(true) };
  const emitConnector = vi.fn();
  return {
    database,
    tx,
    updates,
    lockKeys,
    credentials,
    auditService,
    emitConnector,
    ctx: {
      db: database as never,
      provider: setup.provider as never,
      credentials: credentials as never,
      auditService,
      encryptToken: (token: string) => `enc(${token})`,
      decryptToken: (token: string) => token.replace(/^enc\(|\)$/g, ''),
      emitConnector,
    },
  };
}

function rotatingProvider(overrides: Record<string, unknown> = {}) {
  return {
    describeToken: vi.fn().mockResolvedValue({
      scopes: ['api'],
      expiresAt: inDays(10),
      createdAt: new Date(now.getTime() - 355 * DAY_MS),
    }),
    rotateToken: vi.fn().mockResolvedValue({ token: 'new-token-1234', scopes: ['api'], expiresAt: inDays(365) }),
    ...overrides,
  };
}

describe('Git token rotation rules', () => {
  it('rotates only tokens that may rotate themselves, 14 days ahead', () => {
    expect(canSelfRotate(['api'])).toBe(true);
    expect(canSelfRotate(['read_api', 'self_rotate'])).toBe(true);
    expect(canSelfRotate(['read_api', 'read_repository'])).toBe(false);
    expect(isRotationDue(inDays(14), now)).toBe(true);
    expect(isRotationDue(inDays(15), now)).toBe(false);
    expect(isRotationDue(null, now)).toBe(false);
  });

  it('keeps the previous lifetime and steps down only as far as the instance requires', () => {
    const created = new Date(now.getTime() - 80 * DAY_MS);
    expect(previousLifetimeDays({ createdAt: created, expiresAt: inDays(10) })).toBe(90);
    expect(previousLifetimeDays({ createdAt: null, expiresAt: inDays(2) })).toBe(365);
    expect(rotationLifetimeCandidates({ createdAt: null, expiresAt: inDays(2) })).toEqual([365, 180, 90, 60, 30]);
    expect(rotationLifetimeCandidates({ createdAt: created, expiresAt: inDays(10) })).toEqual([90, 60, 30]);
    // Each rotation asks for the lifetime the token had, so a token the instance shortened keeps the
    // longest lifetime the instance accepted instead of dropping to 30 days.
    expect(
      rotationLifetimeCandidates({ createdAt: new Date(now.getTime() - 160 * DAY_MS), expiresAt: inDays(20) })
    ).toEqual([180, 90, 60, 30]);
  });
});

describe('runGitTokenMaintenance', () => {
  it('records the connector token expiry and rotates it under a lock with a compare-and-swap write', async () => {
    const provider = rotatingProvider();
    const { ctx, updates, lockKeys, auditService, emitConnector } = context({ connectors: [connector], provider });

    const result = await runGitTokenMaintenance(ctx, now);

    expect(provider.describeToken).toHaveBeenCalledWith({ baseUrl: connector.baseUrl, token: 'old-token' });
    expect(provider.rotateToken).toHaveBeenCalledTimes(1);
    expect(lockKeys[0]).toContain('gitlab-token-rotation:integration_connector:gl-1');
    expect(updates).toEqual([
      expect.objectContaining({ tokenExpiresAt: inDays(10) }),
      expect.objectContaining({
        cas: true,
        encryptedToken: 'enc(new-token-1234)',
        tokenLast4: '1234',
        tokenExpiresAt: inDays(365),
      }),
    ]);
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'connector.gitlab.token.rotate',
        userId: null,
        details: expect.objectContaining({ automatic: true }),
      })
    );
    expect(emitConnector).toHaveBeenCalledWith('gl-1', 'token-rotated');
    expect(result).toMatchObject({ described: 1, rotated: 1, failed: 0, alerts: [] });
  });

  it('never rotates when GitLab did not describe that exact token in this run', async () => {
    const provider = rotatingProvider({ describeToken: vi.fn().mockResolvedValue(null) });
    const credential = {
      id: 'cred-1',
      userId: 'user-1',
      connectorId: 'gl-1',
      gitlabUsername: 'alice',
      encryptedToken: 'enc(personal-token)',
      tokenScopes: ['api'],
      tokenExpiresAt: inDays(5),
    };
    const { ctx } = context({
      connectors: [{ ...connector, tokenExpiresAt: inDays(5) }],
      credentials: [credential],
      provider,
    });

    const result = await runGitTokenMaintenance(ctx, now);

    expect(provider.rotateToken).not.toHaveBeenCalled();
    expect(result).toMatchObject({ described: 0, rotated: 0, autoRotating: [] });
  });

  it('does not rotate a token stored in more than one place and asks for separate tokens', async () => {
    const provider = rotatingProvider();
    const credential = {
      id: 'cred-1',
      userId: 'user-1',
      connectorId: 'gl-1',
      gitlabUsername: 'alice',
      encryptedToken: 'enc(old-token)',
      tokenScopes: ['api'],
      tokenExpiresAt: inDays(10),
    };
    const { ctx } = context({
      // The same PAT under another spelling of the same GitLab is still one token.
      connectors: [{ ...connector, baseUrl: 'http://gitlab.internal:8080' }],
      credentials: [credential],
      provider,
    });

    const result = await runGitTokenMaintenance(ctx, now);

    expect(provider.describeToken).toHaveBeenCalledTimes(1);
    expect(provider.rotateToken).not.toHaveBeenCalled();
    expect(result.autoRotating).toEqual([]);
    expect(result.alerts).toEqual([
      expect.objectContaining({
        resourceType: 'integration_connector',
        resourceId: 'gl-1',
        reason: 'git:shared-token',
        message: expect.stringContaining('its own token'),
      }),
      expect.objectContaining({
        resourceType: 'gitlab_user_credential',
        resourceId: 'cred-1',
        reason: 'git:shared-token',
      }),
    ]);
  });

  it('lists a token that will rotate later so its 30-day alert is skipped', async () => {
    const provider = rotatingProvider({
      describeToken: vi.fn().mockResolvedValue({ scopes: ['api'], expiresAt: inDays(25), createdAt: null }),
    });
    const { ctx } = context({ connectors: [connector], provider });

    const result = await runGitTokenMaintenance(ctx, now);

    expect(provider.rotateToken).not.toHaveBeenCalled();
    expect(result.autoRotating).toEqual(['integration_connector:gl-1']);
  });

  it('leaves a token without the rotate scope, or a disabled connector, to the expiry alerts', async () => {
    const provider = rotatingProvider({
      describeToken: vi.fn().mockResolvedValue({ scopes: ['read_api'], expiresAt: inDays(3), createdAt: null }),
    });
    const { ctx } = context({ connectors: [connector], provider });

    const result = await runGitTokenMaintenance(ctx, now);

    expect(provider.rotateToken).not.toHaveBeenCalled();
    expect(result).toMatchObject({ described: 1, rotated: 0, autoRotating: [] });
  });

  it('steps down the lifetime when GitLab refuses the requested date', async () => {
    const provider = rotatingProvider({
      describeToken: vi.fn().mockResolvedValue({ scopes: ['api'], expiresAt: inDays(5), createdAt: null }),
      rotateToken: vi
        .fn()
        .mockRejectedValueOnce(new AppError(400, 'GITLAB_API_ERROR', 'expires_at too far'))
        .mockResolvedValueOnce({ token: 'shorter', scopes: ['api'], expiresAt: inDays(180) }),
    });
    const { ctx } = context({ connectors: [connector], provider });

    const result = await runGitTokenMaintenance(ctx, now);

    const requested = provider.rotateToken.mock.calls.map(([, expiresAt]) =>
      Math.round(((expiresAt as Date).getTime() - Date.now()) / DAY_MS)
    );
    expect(requested).toEqual([365, 180]);
    expect(result.rotated).toBe(1);
  });

  it('keeps the alerts for a project or group token that cannot rotate itself', async () => {
    const provider = rotatingProvider({
      rotateToken: vi.fn().mockRejectedValue(new AppError(405, 'GITLAB_API_ERROR', 'not a personal access token')),
    });
    const { ctx } = context({ connectors: [connector], provider });

    const result = await runGitTokenMaintenance(ctx, now);

    expect(result).toMatchObject({ rotated: 0, failed: 0, autoRotating: [], alerts: [] });
  });

  it('raises a critical re-authorize alert when a rotation of unknown outcome leaves the old token dead', async () => {
    const describeToken = vi
      .fn()
      .mockResolvedValueOnce({ scopes: ['api'], expiresAt: inDays(10), createdAt: null })
      .mockRejectedValueOnce(new AppError(401, 'GITLAB_API_ERROR', 'GitLab API request failed with 401'));
    const provider = rotatingProvider({
      describeToken,
      rotateToken: vi.fn().mockRejectedValue(new AppError(504, 'GITLAB_API_TIMEOUT', 'GitLab API request timed out')),
    });
    const { ctx } = context({ connectors: [connector], provider });

    const result = await runGitTokenMaintenance(ctx, now);

    expect(describeToken).toHaveBeenCalledTimes(2);
    expect(result.failed).toBe(1);
    expect(result.alerts).toEqual([
      expect.objectContaining({
        severity: 'critical',
        resourceId: 'gl-1',
        reason: 'git:rotation-lost',
        message: expect.stringContaining('Rotate the connector token'),
      }),
    ]);
  });

  it('does not claim the token is lost when GitLab is unreachable during the re-check', async () => {
    const describeToken = vi
      .fn()
      .mockResolvedValueOnce({ scopes: ['api'], expiresAt: inDays(10), createdAt: null })
      .mockRejectedValueOnce(new AppError(504, 'GITLAB_API_TIMEOUT', 'GitLab API request timed out'));
    const provider = rotatingProvider({
      describeToken,
      rotateToken: vi.fn().mockRejectedValue(new AppError(504, 'GITLAB_API_TIMEOUT', 'GitLab API request timed out')),
    });
    const { ctx } = context({ connectors: [connector], provider });

    const result = await runGitTokenMaintenance(ctx, now);

    expect(result).toMatchObject({ failed: 1, alerts: [], autoRotating: [] });
  });

  it('keeps the normal alerts when the old token still works after a failed rotation', async () => {
    const provider = rotatingProvider({
      rotateToken: vi.fn().mockRejectedValue(new AppError(502, 'GITLAB_API_UNAVAILABLE', 'down')),
    });
    const { ctx } = context({ connectors: [connector], provider });

    const result = await runGitTokenMaintenance(ctx, now);

    expect(result).toMatchObject({ failed: 1, alerts: [], autoRotating: [] });
  });

  it('keeps a token the user saved during the rotation and revokes the orphaned new one', async () => {
    const revokeToken = vi.fn().mockResolvedValue(undefined);
    const provider = rotatingProvider({ revokeToken });
    const { ctx } = context({ connectors: [connector], provider, casRows: 0 });

    const result = await runGitTokenMaintenance(ctx, now);

    expect(revokeToken).toHaveBeenCalledWith({ baseUrl: connector.baseUrl, token: 'new-token-1234' });
    expect(result).toMatchObject({ rotated: 0, failed: 0, alerts: [] });
  });

  it('treats a failed write after GitLab rotated as a lost token', async () => {
    const provider = rotatingProvider();
    const { ctx, tx } = context({ connectors: [connector], provider });
    tx.update.mockImplementation(() => {
      throw new Error('connection reset');
    });

    const result = await runGitTokenMaintenance(ctx, now);

    expect(result.alerts).toEqual([expect.objectContaining({ severity: 'critical', reason: 'git:rotation-lost' })]);
  });

  it('skips the rotation when the token changed before the lock was taken', async () => {
    const provider = rotatingProvider();
    const { ctx } = context({ connectors: [connector], provider, storedToken: 'enc(user-saved)' });

    const result = await runGitTokenMaintenance(ctx, now);

    expect(provider.rotateToken).not.toHaveBeenCalled();
    expect(result).toMatchObject({ rotated: 0, failed: 0, alerts: [] });
  });

  it('rotates a personal GitLab token only when the stored ciphertext is unchanged', async () => {
    const provider = rotatingProvider({
      rotateToken: vi.fn().mockResolvedValue({ token: 'personal-new', scopes: ['api'], expiresAt: inDays(365) }),
    });
    const credential = {
      id: 'cred-1',
      userId: 'user-1',
      connectorId: 'gl-1',
      gitlabUsername: 'alice',
      encryptedToken: 'enc(personal-token)',
      tokenScopes: ['api'],
      tokenExpiresAt: inDays(7),
    };
    const { ctx, credentials, auditService, tx } = context({
      connectors: [{ ...connector, encryptedToken: 'enc(connector-token)', tokenExpiresAt: inDays(300) }],
      credentials: [credential],
      provider: {
        ...provider,
        describeToken: vi.fn(async (auth: { token: string }) =>
          auth.token === 'personal-token'
            ? { scopes: ['api'], expiresAt: inDays(7), createdAt: null }
            : { scopes: ['api'], expiresAt: inDays(300), createdAt: null }
        ),
      },
      storedToken: 'enc(personal-token)',
    });

    const result = await runGitTokenMaintenance(ctx, now);

    expect(credentials.storeRotated).toHaveBeenCalledWith(
      'cred-1',
      'personal-new',
      { scopes: ['api'], expiresAt: inDays(365) },
      { expectedEncryptedToken: 'enc(personal-token)', executor: tx }
    );
    expect(auditService.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'connector.gitlab.user_credential.rotate', userId: 'user-1' })
    );
    expect(result.rotated).toBe(1);
    expect(result.autoRotating).toEqual(['integration_connector:gl-1']);
  });

  it('does nothing without a GitLab provider', async () => {
    const { ctx, database } = context({ connectors: [connector] });

    await expect(runGitTokenMaintenance(ctx, now)).resolves.toMatchObject({ described: 0, rotated: 0, failed: 0 });
    expect(database.select).not.toHaveBeenCalled();
  });
});

describe('GitLabUserCredentialsService with an expired token', () => {
  function service(row: Record<string, unknown>) {
    const database = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([row]) })) })),
      })),
    };
    const crypto = { decryptString: vi.fn(() => 'token') };
    return new GitLabUserCredentialsService(database as never, crypto as never);
  }

  const row = {
    id: 'cred-1',
    status: 'valid',
    encryptedToken: '{}',
    tokenLast4: 'abcd',
    gitlabUserId: '7',
    gitlabUsername: 'alice',
    tokenScopes: ['api'],
    tokenExpiresAt: new Date(Date.now() - DAY_MS),
    lastValidatedAt: new Date(),
  };

  it('refuses to use it with a clear error', async () => {
    await expect(service(row).resolveAuth('user-1', 'gl-1', 'https://gitlab.example.com')).rejects.toMatchObject({
      statusCode: 428,
      code: 'GIT_CREDENTIAL_EXPIRED',
      message: expect.stringContaining('expired on'),
    });
  });

  it('reports it as no longer authorized', async () => {
    await expect(service(row).getStatus('user-1', 'gl-1')).resolves.toMatchObject({
      authorized: false,
      status: 'invalid',
    });
  });

  it('still resolves a token that has not expired', async () => {
    const valid = { ...row, tokenExpiresAt: new Date(Date.now() + DAY_MS) };
    await expect(service(valid).resolveAuth('user-1', 'gl-1', 'https://gitlab.example.com')).resolves.toMatchObject({
      auth: { token: 'token' },
    });
  });
});

describe('GitLab connector system token expiry', () => {
  it('refuses an expired connector token and asks for rotation', async () => {
    const { IntegrationsCoreService } = await import('./integrations.service.core.js');
    class Probe extends IntegrationsCoreService {
      auth(row: unknown) {
        return this.systemAuthFor(row as never);
      }
    }
    const probe = new Probe({} as never, {} as never, { decryptString: vi.fn(() => 'token') } as never);
    const base = { ...connector, encryptedToken: '{}', authMode: 'token' };

    expect(() => probe.auth({ ...base, tokenExpiresAt: new Date(Date.now() - DAY_MS) })).toThrow(
      expect.objectContaining({ code: 'CONNECTOR_TOKEN_EXPIRED' })
    );
    expect(probe.auth({ ...base, tokenExpiresAt: new Date(Date.now() + DAY_MS) })).toEqual({
      baseUrl: connector.baseUrl,
      token: 'token',
    });
  });
});

describe('GitLabUserCredentialsService token checks', () => {
  function credentialService(row: Record<string, unknown>) {
    const updated: unknown[] = [];
    const database = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([row]) })) })),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn((where: unknown) => {
            updated.push(where);
            return { returning: vi.fn().mockResolvedValue([{ id: 'cred-1' }]) };
          }),
        })),
      })),
    };
    const crypto = { decryptString: vi.fn((value: string) => value) };
    return { service: new GitLabUserCredentialsService(database as never, crypto as never), updated, database };
  }

  const stored = { id: 'cred-1', status: 'valid', encryptedToken: JSON.stringify('glpat-new') };

  it('does not invalidate a credential whose token was rotated after the request read it', async () => {
    const { service, updated } = credentialService(stored);

    await expect(service.markInvalid('user-1', 'gl-1', { token: 'glpat-old' })).resolves.toBe(false);
    expect(updated).toEqual([]);
  });

  it('invalidates the credential that holds the rejected token', async () => {
    const { service, updated } = credentialService(stored);

    await expect(service.markInvalid('user-1', 'gl-1', { token: 'glpat-new' })).resolves.toBe(true);
    expect(updated).toHaveLength(1);
  });

  it('lists only credentials of users who are not blocked for maintenance', async () => {
    const where = vi.fn().mockResolvedValue([{ credential: stored }]);
    const innerJoin = vi.fn(() => ({ where }));
    const database = { select: vi.fn(() => ({ from: vi.fn(() => ({ innerJoin })) })) };
    const service = new GitLabUserCredentialsService(database as never, {} as never);

    await expect(service.listValid()).resolves.toEqual([stored]);
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const query = new PgDialect().sqlToQuery(where.mock.calls[0]![0]);
    expect(query.sql).toContain('"users"."is_blocked" = $');
    expect(query.params).toContain(false);
  });
});
