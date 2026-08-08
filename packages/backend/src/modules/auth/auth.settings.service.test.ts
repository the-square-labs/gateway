import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { AuthSettingsService } from './auth.settings.service.js';

function createDb(initialSettings: Record<string, unknown> = {}) {
  const stored = new Map(Object.entries(initialSettings));
  const db: any = {
    query: {
      permissionGroups: {
        findFirst: vi.fn().mockResolvedValue({ id: 'viewer-group', name: 'viewer' }),
      },
    },
    select: vi.fn(),
    insert: vi.fn(() => ({
      values: vi.fn((values: { key: string; value: unknown }) => ({
        onConflictDoUpdate: vi.fn(async () => {
          stored.set(values.key, values.value);
        }),
      })),
    })),
    currentKey: null as string | null,
  };

  db.select.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn((condition: { queryChunks?: Array<{ value?: unknown }> }) => {
        db.currentKey =
          condition?.queryChunks?.find((chunk) => typeof chunk.value === 'string')?.value?.toString() ?? null;
        return {
          limit: vi.fn(async () =>
            db.currentKey && stored.has(db.currentKey) ? [{ key: db.currentKey, value: stored.get(db.currentKey) }] : []
          ),
        };
      }),
    })),
  }));

  return { db, stored };
}

describe('AuthSettingsService', () => {
  it('defaults OAuth extended callback compatibility to disabled', async () => {
    const { db } = createDb();
    const service = new AuthSettingsService(db);

    await expect(service.getConfig()).resolves.toMatchObject({
      oauthExtendedCallbackCompatibility: false,
    });
  });

  it('defaults the existing-session MFA grace period to three days', async () => {
    const { db } = createDb();
    const service = new AuthSettingsService(db);

    await expect(service.getConfig()).resolves.toMatchObject({
      mfaExistingSessionGracePeriodDays: 3,
    });
  });

  it('persists a valid existing-session MFA grace period', async () => {
    const { db } = createDb();
    const service = new AuthSettingsService(db);

    await service.updateConfig({ mfaExistingSessionGracePeriodDays: 5 });

    await expect(service.getConfig()).resolves.toMatchObject({
      mfaExistingSessionGracePeriodDays: 5,
    });
  });

  it('rejects an invalid existing-session MFA grace period', async () => {
    const { db } = createDb();
    const service = new AuthSettingsService(db);

    await expect(service.updateConfig({ mfaExistingSessionGracePeriodDays: 8 })).rejects.toMatchObject({
      code: 'INVALID_MFA_GRACE_PERIOD',
    });
  });

  it('persists OAuth extended callback compatibility updates', async () => {
    const { db } = createDb();
    const service = new AuthSettingsService(db);

    await service.updateConfig({ oauthExtendedCallbackCompatibility: true });

    await expect(service.getConfig()).resolves.toMatchObject({
      oauthExtendedCallbackCompatibility: true,
    });
    await expect(service.getOAuthExtendedCallbackCompatibility()).resolves.toBe(true);
  });

  it('does not count the reserved Gateway system user when disabling OIDC', async () => {
    const { db } = createDb({
      'auth:methods': { oidc: true, password: false, emailOtp: false, passkeyLogin: false },
    });
    let assignedUserCondition: unknown;
    db.select.mockImplementation((selection?: { count?: unknown }) => {
      if (selection?.count) {
        return {
          from: vi.fn(() => ({
            where: vi.fn(async (condition: unknown) => {
              assignedUserCondition = condition;
              return [{ count: 0 }];
            }),
          })),
        };
      }
      return {
        from: vi.fn(() => ({
          where: vi.fn((condition: { queryChunks?: Array<{ value?: unknown }> }) => {
            db.currentKey =
              condition?.queryChunks?.find((chunk) => typeof chunk.value === 'string')?.value?.toString() ?? null;
            return {
              limit: vi.fn(async () => [
                {
                  key: 'auth:methods',
                  value: { oidc: true, password: false, emailOtp: false, passkeyLogin: false },
                },
              ]),
            };
          }),
        })),
      };
    });

    const service = new AuthSettingsService(db);
    await service.updateConfig({ methods: { oidc: false, password: true } });

    const query = new PgDialect().sqlToQuery(assignedUserCondition as never);
    expect(query.sql).toContain('"users"."oidc_subject"');
    expect(query.params).toEqual(['oidc', 'system:gateway-setup']);
  });
});
