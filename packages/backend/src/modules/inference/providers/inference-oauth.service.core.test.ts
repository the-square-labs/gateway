import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { InferenceCoreClientError } from '../core/inference-core.client.js';
import { InferenceOAuthService } from './inference-oauth.service.js';
import { InferenceProviderRegistry } from './inference-provider.registry.js';

/** Passthrough vault: seal/open round-trips JSON so tests can inspect payloads. */
function passthroughVault() {
  return {
    seal: (payload: unknown) => ({
      encryptedPayload: JSON.stringify(payload),
      encryptedDek: 'dek',
      keyVersion: 1,
    }),
    open: <T>(blob: { encryptedPayload: string }) => JSON.parse(blob.encryptedPayload) as T,
  };
}

function insertChain(rows: unknown[], captures?: unknown[]) {
  return {
    values: vi.fn((values: unknown) => {
      captures?.push(values);
      return {
        onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
        returning: vi.fn().mockResolvedValue(rows),
      };
    }),
  };
}

function updateChain(rows: unknown[] = []) {
  const chain = {
    set: vi.fn(),
    where: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue(rows) }),
  };
  chain.set.mockReturnValue(chain);
  return chain;
}

const SESSION = {
  id: 'session-1',
  providerId: 'openai',
  userId: 'user-1',
  connectionName: 'ChatGPT main',
  flow: 'device',
  status: 'pending',
  stateHash: 'hash',
  encryptedPayload: JSON.stringify({ state: 'state-1', coreManaged: true, coreFlowId: 'flow-1' }),
  encryptedDek: 'dek',
  authorizationUrl: 'https://auth.openai.com/codex/device',
  completionMode: 'device_poll',
  userCode: 'OPEN-AI',
  pollIntervalSeconds: null,
  connectionId: null,
  errorCode: null,
  errorMessage: null,
  expiresAt: new Date(Date.now() + 600_000),
  createdAt: new Date(),
  updatedAt: new Date(),
};

function createService(options: { client?: Record<string, unknown>; session?: unknown } = {}) {
  const db = {
    transaction: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    select: vi.fn(),
    query: {
      inferenceOAuthSessions: {
        findFirst: vi.fn().mockResolvedValue(options.session === undefined ? SESSION : options.session),
      },
    },
  };
  const client = {
    coreCodexLoginStart: vi.fn().mockResolvedValue({
      flowId: 'flow-1',
      url: 'https://auth.openai.com/codex/device',
      instructions: 'Enter code: OPEN-AI',
      deviceCode: 'OPEN-AI',
    }),
    coreCodexLoginStatus: vi.fn().mockResolvedValue({ status: 'pending' }),
    coreCodexLoginCode: vi.fn().mockResolvedValue(undefined),
    coreCodexLoginCancel: vi.fn().mockResolvedValue(undefined),
    listCoreCodexAccounts: vi.fn().mockResolvedValue([]),
    coreOauthLoginStart: vi.fn().mockResolvedValue({
      url: 'https://auth.kimi.com/device?code=KIMI-1',
      instructions: 'Enter code: KIMI-1',
      deviceCode: 'KIMI-1',
    }),
    coreOauthLoginStatus: vi.fn().mockResolvedValue({ done: false, loggedIn: false }),
    coreOauthLoginCode: vi.fn().mockResolvedValue(undefined),
    coreOauthLoginCancel: vi.fn().mockResolvedValue(undefined),
    listCoreOauthAccounts: vi.fn().mockResolvedValue({ activeAccountId: null, accounts: [] }),
    ...options.client,
  };
  const bridge = {
    coreReady: vi.fn().mockResolvedValue(true),
    requireClient: vi.fn().mockResolvedValue(client),
  };
  const service = new InferenceOAuthService(
    db as never,
    passthroughVault() as never,
    new InferenceProviderRegistry(),
    vi.fn(),
    bridge as never
  );
  return { service, db, client, bridge };
}

const TERMS = { acceptTerms: true, termsVersion: 'opencodex-unofficial-connectors-2026-07' };

describe('inference oauth service — core-backed sessions', () => {
  it('starts a ChatGPT login through the core codex-auth flow', async () => {
    const { service, db, client } = createService();
    const captures: unknown[] = [];
    db.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ insert: vi.fn().mockReturnValue(insertChain([SESSION], captures)) })
    );

    const session = await service.start('user-1', {
      providerId: 'openai',
      connectionName: 'ChatGPT main',
      ...TERMS,
    });

    expect(client.coreCodexLoginStart).toHaveBeenCalledWith({ flow: 'device' });
    expect(session.completionMode).toBe('device_poll');
    expect(session.authorizationUrl).toBe('https://auth.openai.com/codex/device');
    expect(session.userCode).toBe('OPEN-AI');
    const inserted = captures[1] as Record<string, unknown>;
    expect(inserted.flow).toBe('device');
    expect(JSON.parse(inserted.encryptedPayload as string)).toMatchObject({
      coreManaged: true,
      coreFlowId: 'flow-1',
    });
  });

  it('starts a kimi device login with add-account detection and the core user code', async () => {
    const { service, db, client } = createService({
      client: {
        listCoreOauthAccounts: vi.fn().mockResolvedValue({
          activeAccountId: 'acc-1',
          accounts: [{ id: 'acc-1' }],
        }),
      },
    });
    const captures: unknown[] = [];
    const kimiSession = { ...SESSION, providerId: 'kimi', flow: 'device', completionMode: 'device_poll' };
    db.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ insert: vi.fn().mockReturnValue(insertChain([kimiSession], captures)) })
    );

    const session = await service.start('user-1', { providerId: 'kimi', connectionName: 'Kimi', ...TERMS });

    expect(client.coreOauthLoginStart).toHaveBeenCalledWith('kimi', { addAccount: true });
    expect(session.completionMode).toBe('device_poll');
    const inserted = captures[1] as Record<string, unknown>;
    expect(inserted.flow).toBe('device');
    expect(inserted.userCode).toBe('KIMI-1');
  });

  it('completes a codex session by creating a core-managed connection without credentials', async () => {
    const { service, db, client } = createService({
      client: {
        coreCodexLoginStatus: vi.fn().mockResolvedValue({
          status: 'done',
          accountId: 'chatgpt-9',
          email: 'u***@example.com',
        }),
      },
    });
    const tx = {
      query: { inferenceProviderConnections: { findFirst: vi.fn().mockResolvedValue(null) } },
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }),
        }),
      }),
      insert: vi.fn().mockReturnValue(insertChain([{ id: 'conn-new' }])),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    };
    db.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx));
    db.update.mockReturnValue(updateChain([{ ...SESSION, status: 'complete' }]));

    const result = await service.status('user-1', 'session-1');

    expect(client.coreCodexLoginStatus).toHaveBeenCalledWith('flow-1');
    expect(result.status).toBe('complete');
    expect(result.connectionId).toBe('conn-new');
    // No credential row may be written for a core-managed connection.
    expect(tx.insert).toHaveBeenCalledTimes(1);
  });

  it('reuses the existing connection row and drops its legacy credential on re-login', async () => {
    const { service, db } = createService({
      client: {
        coreCodexLoginStatus: vi.fn().mockResolvedValue({ status: 'done', accountId: 'chatgpt-9' }),
      },
    });
    const tx = {
      query: {
        inferenceProviderConnections: {
          findFirst: vi.fn().mockResolvedValue({ id: 'conn-existing', metadata: {}, accountLabel: null }),
        },
      },
      update: vi.fn().mockReturnValue(updateChain()),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    };
    db.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx));
    db.update.mockReturnValue(updateChain());

    const result = await service.status('user-1', 'session-1');

    expect(result.connectionId).toBe('conn-existing');
    expect(tx.delete).toHaveBeenCalled();
  });

  it('adopts an orphaned codex account that the core already added to its pool', async () => {
    const { service, db, client } = createService({
      client: {
        coreCodexLoginStatus: vi.fn().mockResolvedValue({
          status: 'error',
          error: 'Account is already in the pool (chatgpt-orphan-1).',
        }),
        listCoreCodexAccounts: vi.fn().mockResolvedValue([{ id: 'chatgpt-orphan-1', email: 'o***@example.com' }]),
      },
    });
    const inserted: unknown[] = [];
    const tx = {
      query: { inferenceProviderConnections: { findFirst: vi.fn().mockResolvedValue(null) } },
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }),
        }),
      }),
      insert: vi.fn().mockReturnValue(insertChain([{ id: 'conn-adopted' }], inserted)),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    };
    db.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx));
    db.update.mockReturnValue(updateChain([{ ...SESSION, status: 'complete' }]));

    const result = await service.status('user-1', 'session-1');

    expect(client.listCoreCodexAccounts).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ status: 'complete', connectionId: 'conn-adopted' });
    expect(inserted[0]).toMatchObject({
      accountExternalId: 'chatgpt-orphan-1',
      accountLabel: 'o***@example.com',
      metadata: { coreManaged: true, coreAccountId: 'chatgpt-orphan-1' },
    });
  });

  it('marks the session failed when the core reports a login error', async () => {
    const { service, db } = createService({
      client: {
        coreCodexLoginStatus: vi.fn().mockResolvedValue({ status: 'error', error: 'user declined' }),
      },
    });
    const chain = updateChain([{ ...SESSION, status: 'error', errorCode: 'oauth_exchange_failed' }]);
    db.update.mockReturnValue(chain);

    const result = await service.status('user-1', 'session-1');

    expect(result.status).toBe('error');
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'error', errorMessage: 'user declined' }));
  });

  it('submits pasted callback input to the core before polling', async () => {
    const { service, client } = createService();

    await service.complete('user-1', 'session-1', 'http://localhost:1455/auth/callback?code=abc');

    expect(client.coreCodexLoginCode).toHaveBeenCalledWith('flow-1', 'http://localhost:1455/auth/callback?code=abc');
    expect(client.coreCodexLoginStatus).toHaveBeenCalledWith('flow-1');
  });

  it('marks the session failed when the core rejects the pasted code', async () => {
    const { service, db } = createService({
      client: {
        coreCodexLoginCode: vi.fn().mockRejectedValue(new InferenceCoreClientError('login flow is not pending', 400)),
      },
    });
    const chain = updateChain();
    db.update.mockReturnValue(chain);

    await expect(service.complete('user-1', 'session-1', 'code')).rejects.toMatchObject({
      statusCode: 400,
      code: 'INFERENCE_OAUTH_CORE_FAILED',
    });
    expect(chain.set).toHaveBeenCalledWith(expect.objectContaining({ status: 'error' }));
  });

  it('cancels the core flow and the local session together', async () => {
    const { service, db, client } = createService();
    const chain = updateChain([{ ...SESSION, status: 'cancelled' }]);
    db.update.mockReturnValue(chain);

    const result = await service.cancel('user-1', 'session-1');

    expect(client.coreCodexLoginCancel).toHaveBeenCalledWith('flow-1');
    expect(result.status).toBe('cancelled');
  });

  it('routes generic oauth providers through the core login surface', async () => {
    const { service, db, client } = createService({
      session: {
        ...SESSION,
        providerId: 'anthropic',
        encryptedPayload: JSON.stringify({ state: 'state-1', coreManaged: true }),
      },
      client: {
        coreOauthLoginStatus: vi.fn().mockResolvedValue({
          done: true,
          loggedIn: true,
          activeAccountId: 'acc-7',
          email: 'a***@example.com',
        }),
      },
    });
    const tx = {
      query: { inferenceProviderConnections: { findFirst: vi.fn().mockResolvedValue(null) } },
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi
            .fn()
            .mockReturnValue({ orderBy: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue([]) }) }),
        }),
      }),
      insert: vi.fn().mockReturnValue(insertChain([{ id: 'conn-anthropic' }])),
      delete: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    };
    db.transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx));
    db.update.mockReturnValue(updateChain());

    const result = await service.complete('user-1', 'session-1', 'code#state');

    expect(client.coreOauthLoginCode).toHaveBeenCalledWith('anthropic', 'code#state');
    expect(result.status).toBe('complete');
    expect(result.connectionId).toBe('conn-anthropic');
  });

  it('refuses to start any OAuth flow while the core is not ready', async () => {
    const { service, bridge } = createService();
    bridge.coreReady.mockResolvedValue(false);

    await expect(
      service.start('user-1', { providerId: 'openai', connectionName: 'ChatGPT main', ...TERMS })
    ).rejects.toMatchObject({ statusCode: 409, code: 'INFERENCE_CORE_NOT_READY' });
  });
});
