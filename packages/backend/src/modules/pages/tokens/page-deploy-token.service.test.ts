import { describe, expect, it, vi } from 'vitest';
import type { DrizzleClient } from '@/db/client.js';
import { hashPageDeployToken, PageDeployTokenService } from './page-deploy-token.service.js';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN_ID = '22222222-2222-4222-8222-222222222222';
const USER_ID = '33333333-3333-4333-8333-333333333333';

function createSelectDb(rows: unknown[][]) {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => rows.shift() ?? []),
        })),
      })),
    })),
  };
}

describe('PageDeployTokenService', () => {
  it('reveals a random token once while persisting and auditing only its hash and prefix', async () => {
    const insertedValues = vi.fn();
    const tokenRow = {
      id: TOKEN_ID,
      projectId: PROJECT_ID,
      name: 'CI',
      tokenPrefix: 'gwp_12345678',
      tokenHash: 'stored-hash',
      allowedTagPatterns: ['mr-*'],
      allowUserTag: true,
      expiresAt: null,
      createdAt: new Date('2026-08-17T10:00:00Z'),
    };
    const db = {
      ...createSelectDb([[{ id: PROJECT_ID }]]),
      insert: vi.fn(() => ({
        values: vi.fn((values) => {
          insertedValues(values);
          return {
            returning: vi.fn(async () => [
              { ...tokenRow, tokenPrefix: String((values as { tokenPrefix: string }).tokenPrefix) },
            ]),
          };
        }),
      })),
    };
    const auditService = { log: vi.fn(async () => {}) };
    const service = new PageDeployTokenService(db as unknown as DrizzleClient, auditService as never);

    const created = await service.create(
      PROJECT_ID,
      { name: 'CI', allowedTagPatterns: ['mr-*'], allowUserTag: true, expiresAt: null },
      USER_ID
    );

    expect(created.token).toMatch(/^gwp_[0-9a-f]{64}$/);
    const persisted = insertedValues.mock.calls[0]?.[0] as { tokenHash: string; tokenPrefix: string };
    expect(persisted.tokenHash).toBe(hashPageDeployToken(created.token));
    expect(persisted.tokenHash).not.toContain(created.token);
    expect(persisted.tokenPrefix).toBe(created.token.slice(0, 12));
    expect(JSON.stringify(auditService.log.mock.calls)).not.toContain(created.token);
  });

  it('validates only live tokens and updates last-used time without exposing the hash', async () => {
    const raw = `gwp_${'a'.repeat(64)}`;
    const tokenRow = {
      id: TOKEN_ID,
      projectId: PROJECT_ID,
      tokenPrefix: raw.slice(0, 12),
      allowedTagPatterns: ['mr-*'],
      allowUserTag: true,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const execute = vi.fn(async () => {});
    const db = {
      ...createSelectDb([[tokenRow]]),
      update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ execute })) })) })),
    };
    const service = new PageDeployTokenService(db as unknown as DrizzleClient, { log: vi.fn() } as never);

    await expect(service.validate(raw)).resolves.toEqual({
      tokenId: TOKEN_ID,
      tokenPrefix: raw.slice(0, 12),
      projectId: PROJECT_ID,
      allowedTagPatterns: ['mr-*'],
      allowUserTag: true,
    });
    expect(execute).toHaveBeenCalledOnce();
    await expect(service.validate('gwp_not-a-token')).resolves.toBeNull();
  });

  it('enforces user Tag publication and optional Tag patterns', () => {
    const service = new PageDeployTokenService({} as DrizzleClient, { log: vi.fn() } as never);
    const base = {
      tokenId: TOKEN_ID,
      tokenPrefix: 'gwp_12345678',
      projectId: PROJECT_ID,
      allowedTagPatterns: ['mr-*', 'staging'],
      allowUserTag: true,
    };

    expect(() => service.assertTagAllowed(base, 'mr-42')).not.toThrow();
    expect(() => service.assertTagAllowed(base, 'staging')).not.toThrow();
    expect(() => service.assertTagAllowed(base, 'production')).toThrowError(
      expect.objectContaining({ code: 'PAGE_DEPLOY_TOKEN_TAG_FORBIDDEN' })
    );
    expect(() => service.assertTagAllowed({ ...base, allowUserTag: false }, 'mr-42')).toThrowError(
      expect.objectContaining({ code: 'PAGE_DEPLOY_TOKEN_TAG_FORBIDDEN' })
    );
    expect(() => service.assertTagAllowed({ ...base, allowedTagPatterns: [] }, 'production')).not.toThrow();
    expect(() => service.assertTagAllowed(base, undefined)).not.toThrow();
  });

  it('rejects expired tokens even if their hash exists', async () => {
    const raw = `gwp_${'b'.repeat(64)}`;
    const db = createSelectDb([
      [
        {
          id: TOKEN_ID,
          projectId: PROJECT_ID,
          tokenPrefix: raw.slice(0, 12),
          allowedTagPatterns: [],
          allowUserTag: false,
          expiresAt: new Date(Date.now() - 1),
        },
      ],
    ]);
    const service = new PageDeployTokenService(db as unknown as DrizzleClient, { log: vi.fn() } as never);

    await expect(service.validate(raw)).resolves.toBeNull();
  });
});
