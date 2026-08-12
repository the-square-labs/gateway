import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '@/types.js';
import { __testOnly, InferenceTokenService } from './inference-token.service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN_ID = '22222222-2222-4222-8222-222222222222';

const USER: User = {
  id: USER_ID,
  oidcSubject: 'oidc-user',
  email: 'user@example.com',
  name: 'User',
  avatarUrl: null,
  groupId: 'group-1',
  groupName: 'inference-users',
  scopes: ['feat:ai:use'],
  isBlocked: false,
};

function liveUserDb(token: Record<string, unknown> | null, user: Partial<User> = {}) {
  const execute = vi.fn().mockResolvedValue(undefined);
  return {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ execute }),
      }),
    }),
    query: {
      inferenceTokens: { findFirst: vi.fn().mockResolvedValue(token) },
      users: {
        findFirst: vi.fn().mockResolvedValue({
          id: USER.id,
          oidcSubject: USER.oidcSubject,
          email: USER.email,
          name: USER.name,
          avatarUrl: USER.avatarUrl,
          groupId: USER.groupId,
          isBlocked: USER.isBlocked,
          additionalScopes: [],
          ...user,
        }),
      },
      permissionGroups: {
        findMany: vi
          .fn()
          .mockResolvedValue([
            { id: USER.groupId, parentId: null, name: USER.groupName, scopes: user.scopes ?? USER.scopes },
          ]),
      },
    },
  };
}

describe('InferenceTokenService', () => {
  it('returns a copy-once token while storing and auditing only non-secret material', async () => {
    const values = vi.fn().mockImplementation((inserted) => ({
      returning: vi.fn().mockResolvedValue([
        {
          id: TOKEN_ID,
          userId: USER_ID,
          name: inserted.name,
          tokenHash: inserted.tokenHash,
          tokenPrefix: inserted.tokenPrefix,
          lastUsedAt: null,
          revokedAt: null,
          createdAt: new Date('2026-07-24T00:00:00.000Z'),
        },
      ]),
    }));
    const db = { insert: vi.fn().mockReturnValue({ values }) };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const service = new InferenceTokenService(db as never, audit as never);

    const result = await service.createToken(USER_ID, { name: 'Codex laptop' });
    const stored = values.mock.calls[0][0];
    const auditEntry = audit.log.mock.calls[0][0];

    expect(result.token).toMatch(/^gwi_[0-9a-f]{64}$/);
    expect(stored.tokenHash).toBe(__testOnly.hashInferenceToken(result.token));
    expect(stored.tokenHash).not.toContain(result.token);
    expect(stored.tokenPrefix).toBe(result.token.slice(0, 12));
    expect(JSON.stringify(auditEntry)).not.toContain(result.token);
    expect(auditEntry).toMatchObject({ action: 'inference_token.create', resourceId: TOKEN_ID });
  });

  it('validates against the live owner and required inference scope', async () => {
    const token = { id: TOKEN_ID, userId: USER_ID, tokenPrefix: 'gwi_12345678' };
    const allowed = await new InferenceTokenService(
      liveUserDb(token) as never,
      { log: vi.fn() } as never
    ).validateToken('gwi_test');
    const blocked = await new InferenceTokenService(
      liveUserDb(token, { isBlocked: true }) as never,
      { log: vi.fn() } as never
    ).validateToken('gwi_test');
    const demoted = await new InferenceTokenService(
      liveUserDb(token, { scopes: ['nodes:details'] }) as never,
      { log: vi.fn() } as never
    ).validateToken('gwi_test');

    expect(allowed).toMatchObject({ user: { id: USER_ID }, tokenId: TOKEN_ID, tokenPrefix: 'gwi_12345678' });
    expect(blocked).toBeNull();
    expect(demoted).toBeNull();
  });

  it('rejects revoked, unknown, and wrong-prefix credentials', async () => {
    const service = new InferenceTokenService(liveUserDb(null) as never, { log: vi.fn() } as never);
    await expect(service.validateToken('gwi_revoked')).resolves.toBeNull();
    await expect(service.validateToken('gw_wrong_kind')).resolves.toBeNull();
  });

  it('soft-revokes owned tokens without putting secret material in audit data', async () => {
    const token = {
      id: TOKEN_ID,
      userId: USER_ID,
      name: 'CLI',
      tokenPrefix: 'gwi_12345678',
      revokedAt: null,
    };
    const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    const db = {
      query: { inferenceTokens: { findFirst: vi.fn().mockResolvedValue(token) } },
      update: vi.fn().mockReturnValue({ set }),
    };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };

    await new InferenceTokenService(db as never, audit as never).revokeToken(USER_ID, TOKEN_ID);

    expect(set.mock.calls[0][0].revokedAt).toBeInstanceOf(Date);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'inference_token.revoke', resourceId: TOKEN_ID })
    );
  });

  it('serializes managed token issuance per user, harness, and installation', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const returning = vi.fn().mockResolvedValue([
      {
        id: TOKEN_ID,
        userId: USER_ID,
        name: 'Codex · laptop',
        managedBy: 'gateway-cli',
        harness: 'codex',
        deviceName: 'laptop',
        installationId: '33333333-3333-4333-8333-333333333333',
        tokenHash: 'hash',
        tokenPrefix: 'gwi_12345678',
        lastUsedAt: null,
        revokedAt: null,
        createdAt: new Date('2026-07-28T00:00:00.000Z'),
      },
    ]);
    const tx = {
      execute,
      query: { inferenceTokens: { findFirst: vi.fn().mockResolvedValue(null) } },
      insert: vi.fn().mockReturnValue({ values: vi.fn().mockReturnValue({ returning }) }),
    };
    const db = { transaction: vi.fn(async (callback) => callback(tx)) };
    const audit = { log: vi.fn().mockResolvedValue(undefined) };
    const service = new InferenceTokenService(db as never, audit as never);

    const result = await service.createManagedToken(USER_ID, {
      harness: 'codex',
      deviceName: 'laptop',
      installationId: '33333333-3333-4333-8333-333333333333',
    });

    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      id: TOKEN_ID,
      prefix: 'gwi_12345678',
      token: expect.stringMatching(/^gwi_[0-9a-f]{64}$/),
      harness: 'codex',
      deviceName: 'laptop',
    });
    expect(JSON.stringify(audit.log.mock.calls[0][0])).not.toContain(result.token);
  });

  it('returns a stable conflict instead of silently replacing an active managed token', async () => {
    const tx = {
      execute: vi.fn().mockResolvedValue(undefined),
      query: { inferenceTokens: { findFirst: vi.fn().mockResolvedValue({ id: TOKEN_ID }) } },
    };
    const db = { transaction: vi.fn(async (callback) => callback(tx)) };
    const service = new InferenceTokenService(db as never, { log: vi.fn() } as never);

    await expect(
      service.createManagedToken(USER_ID, {
        harness: 'codex',
        deviceName: 'laptop',
        installationId: '33333333-3333-4333-8333-333333333333',
      })
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'INFERENCE_SETUP_TOKEN_EXISTS',
      details: { tokenId: TOKEN_ID },
    });
  });

  it('does not revoke a managed token owned by another user', async () => {
    const db = {
      query: { inferenceTokens: { findFirst: vi.fn().mockResolvedValue(null) } },
    };
    const service = new InferenceTokenService(db as never, { log: vi.fn() } as never);

    await expect(service.revokeManagedToken(USER_ID, TOKEN_ID)).rejects.toMatchObject({
      statusCode: 404,
      code: 'INFERENCE_TOKEN_NOT_FOUND',
    });
  });
});
