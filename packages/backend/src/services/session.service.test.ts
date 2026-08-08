import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { SessionData, User } from '@/types.js';
import { SessionService } from './session.service.js';

class MemoryCache {
  readonly values = new Map<string, unknown>();
  readonly sets = new Map<string, Set<string>>();

  async get<T>(key: string): Promise<T | null> {
    return (this.values.get(key) as T | undefined) ?? null;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async srem(key: string, member: string): Promise<void> {
    this.sets.get(key)?.delete(member);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

describe('SessionService', () => {
  it('sets and clears the MFA grace deadline on every active user session', async () => {
    const cache = new MemoryCache();
    const service = new SessionService(cache as never);
    const expiresAt = Date.now() + 60_000;
    const firstSessionId = 'browser-session-1';
    const secondSessionId = 'browser-session-2';
    const userId = 'user-1';
    const firstSession = {
      userId,
      user: { id: userId },
      createdAt: Date.now() - 60_000,
      expiresAt,
    } as SessionData;
    const secondSession = {
      userId,
      user: { id: userId },
      createdAt: Date.now() - 30_000,
      expiresAt,
    } as SessionData;
    cache.values.set(`session:${firstSessionId}`, firstSession);
    cache.values.set(`session:${secondSessionId}`, secondSession);
    cache.sets.set(`user_sessions:${userId}`, new Set([firstSessionId, secondSessionId]));

    await service.setUserSessionsMfaGraceExpiresAt(userId, 1_700_000_000_000);

    await expect(service.getSession(firstSessionId)).resolves.toMatchObject({
      mfaGraceExpiresAt: 1_700_000_000_000,
    });
    await expect(service.getSession(secondSessionId)).resolves.toMatchObject({
      mfaGraceExpiresAt: 1_700_000_000_000,
    });

    await service.clearUserSessionsMfaGraceExpiresAt(userId);

    expect((await service.getSession(firstSessionId))?.mfaGraceExpiresAt).toBeUndefined();
    expect((await service.getSession(secondSessionId))?.mfaGraceExpiresAt).toBeUndefined();
  });

  it('upgrades a legacy session without a cached user so it stays visible and revocable', async () => {
    const cache = new MemoryCache();
    const service = new SessionService(cache as never);
    const user: User = {
      id: 'user-1',
      oidcSubject: 'oidc-user-1',
      authMethod: 'oidc',
      email: 'user@example.com',
      name: 'OIDC User',
      avatarUrl: null,
      groupId: 'group-1',
      groupName: 'viewer',
      scopes: [],
      isBlocked: false,
    };
    const sessionId = 'legacy-oidc-session';
    const legacySession = {
      userId: user.id,
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      createdAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
    } as SessionData;
    cache.values.set(`session:${sessionId}`, legacySession);
    cache.sets.set(`user_sessions:${user.id}`, new Set([sessionId]));

    const sessions = await service.listPublicUserSessions(user.id, sessionId);

    expect(sessions).toEqual([
      expect.objectContaining({
        authMethod: 'oidc',
        isCurrent: true,
        id: expect.any(String),
      }),
    ]);
    expect((await cache.get<SessionData>(`session:${sessionId}`))?.publicId).toEqual(sessions[0].id);
  });
});
