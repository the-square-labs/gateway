import { timingSafeEqual } from 'node:crypto';
import { nanoid } from 'nanoid';
import { injectable } from 'tsyringe';
import { getEnv } from '@/config/env.js';
import type { AuthMethod, PublicSession, SessionData, User } from '@/types.js';
import type { CacheService } from './cache.service.js';

const SESSION_PREFIX = 'session:';
const USER_SESSIONS_PREFIX = 'user_sessions:';

@injectable()
export class SessionService {
  constructor(private readonly cache: CacheService) {}

  async createSession(
    user: User,
    accessToken?: string,
    refreshToken?: string,
    metadata: { authMethod?: AuthMethod; ipAddress?: string; userAgent?: string; mfaSatisfiedAt?: number } = {}
  ): Promise<{ sessionId: string; expiresAt: number }> {
    const env = getEnv();
    const sessionId = nanoid(32);
    const expiresAt = Date.now() + env.SESSION_EXPIRY * 1000;

    const sessionData: SessionData = {
      userId: user.id,
      user,
      publicId: nanoid(18),
      authMethod: metadata.authMethod ?? user.authMethod ?? 'oidc',
      accessToken,
      refreshToken,
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      ipAddress: metadata.ipAddress,
      userAgent: metadata.userAgent,
      mfaSatisfiedAt: metadata.mfaSatisfiedAt,
      expiresAt,
    };

    await this.cache.set(`${SESSION_PREFIX}${sessionId}`, sessionData, env.SESSION_EXPIRY);

    await this.cache.sadd(`${USER_SESSIONS_PREFIX}${user.id}`, sessionId);
    await this.cache.expire(`${USER_SESSIONS_PREFIX}${user.id}`, env.SESSION_EXPIRY + 86400);

    return { sessionId, expiresAt };
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    const session = await this.cache.get<SessionData>(`${SESSION_PREFIX}${sessionId}`);

    if (!session) return null;

    if (session.expiresAt < Date.now()) {
      await this.destroySession(sessionId);
      return null;
    }

    // Sessions created before browser-session management was introduced do not
    // have a public identifier. Keep an authenticated browser visible rather
    // than silently filtering it from /me/sessions until it expires.
    if (!session.publicId) {
      session.publicId = nanoid(18);
      session.authMethod ??= session.user?.authMethod ?? 'oidc';
      const remainingTtl = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));
      await this.cache.set(`${SESSION_PREFIX}${sessionId}`, session, remainingTtl);
    }

    return session;
  }

  async updateSession(sessionId: string, updates: Partial<SessionData>): Promise<void> {
    const session = await this.getSession(sessionId);
    if (!session) return;

    const updatedSession: SessionData = {
      ...session,
      ...updates,
    };

    const remainingTtl = Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000));

    await this.cache.set(`${SESSION_PREFIX}${sessionId}`, updatedSession, remainingTtl);
  }

  async ensureCsrfToken(sessionId: string, session?: SessionData | null): Promise<string | null> {
    const resolved = session ?? (await this.getSession(sessionId));
    if (!resolved) return null;
    if (resolved.csrfToken) return resolved.csrfToken;

    const csrfToken = nanoid(32);
    await this.updateSession(sessionId, { csrfToken });
    return csrfToken;
  }

  async validateCsrfToken(
    sessionId: string,
    token: string | undefined,
    session?: SessionData | null
  ): Promise<boolean> {
    if (!token) return false;
    const csrfToken = await this.ensureCsrfToken(sessionId, session);
    if (!csrfToken) return false;

    const expected = Buffer.from(csrfToken);
    const received = Buffer.from(token);
    return expected.length === received.length && timingSafeEqual(expected, received);
  }

  async refreshSession(sessionId: string, session?: SessionData | null): Promise<boolean> {
    const resolved = session ?? (await this.getSession(sessionId));
    if (!resolved) return false;

    const env = getEnv();
    const halfTtl = (env.SESSION_EXPIRY * 1000) / 2;
    const remaining = resolved.expiresAt - Date.now();

    if (remaining > halfTtl) return false;

    const newExpiresAt = Date.now() + env.SESSION_EXPIRY * 1000;
    resolved.expiresAt = newExpiresAt;

    await this.cache.set(`${SESSION_PREFIX}${sessionId}`, resolved, env.SESSION_EXPIRY);

    return true;
  }

  async touchSession(sessionId: string, session?: SessionData | null): Promise<void> {
    const resolved = session ?? (await this.getSession(sessionId));
    if (!resolved || Date.now() - (resolved.lastSeenAt ?? resolved.createdAt) < 60_000) return;
    await this.updateSession(sessionId, { lastSeenAt: Date.now() });
  }

  async destroySession(sessionId: string): Promise<void> {
    const session = await this.cache.get<SessionData>(`${SESSION_PREFIX}${sessionId}`);

    if (session) {
      await this.cache.srem(`${USER_SESSIONS_PREFIX}${session.userId}`, sessionId);
    }

    await this.cache.delete(`${SESSION_PREFIX}${sessionId}`);
  }

  async destroyAllUserSessions(userId: string): Promise<void> {
    const sessionIds = await this.cache.smembers(`${USER_SESSIONS_PREFIX}${userId}`);

    for (const sessionId of sessionIds) {
      await this.cache.delete(`${SESSION_PREFIX}${sessionId}`);
    }

    await this.cache.delete(`${USER_SESSIONS_PREFIX}${userId}`);
  }

  async getUserSessions(userId: string): Promise<SessionData[]> {
    const sessionIds = await this.cache.smembers(`${USER_SESSIONS_PREFIX}${userId}`);
    const sessions: SessionData[] = [];

    for (const sessionId of sessionIds) {
      const session = await this.getSession(sessionId);
      if (session) {
        sessions.push(session);
      }
    }

    return sessions;
  }

  async listPublicUserSessions(userId: string, currentSessionId: string): Promise<PublicSession[]> {
    const sessions = await this.getUserSessions(userId);
    const currentSession = await this.getSession(currentSessionId);
    const currentPublicId = currentSession?.publicId;
    return sessions
      .filter((session) => Boolean(session.publicId))
      .map((session) => ({
        id: session.publicId!,
        authMethod: session.authMethod ?? session.user?.authMethod ?? 'oidc',
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt ?? session.createdAt,
        expiresAt: session.expiresAt,
        ipAddress: session.ipAddress ?? null,
        userAgent: session.userAgent ?? null,
        mfaSatisfiedAt: session.mfaSatisfiedAt ?? null,
        isCurrent: session.publicId === currentPublicId,
      }));
  }

  async revokeUserSessionByPublicId(
    userId: string,
    publicId: string,
    options: { excludeSessionId?: string } = {}
  ): Promise<boolean> {
    const sessionIds = await this.cache.smembers(`${USER_SESSIONS_PREFIX}${userId}`);
    for (const sessionId of sessionIds) {
      if (sessionId === options.excludeSessionId) continue;
      const session = await this.getSession(sessionId);
      if (session?.publicId !== publicId) continue;
      await this.destroySession(sessionId);
      return true;
    }
    return false;
  }

  async revokeOtherUserSessions(userId: string, currentSessionId: string): Promise<number> {
    const sessionIds = await this.cache.smembers(`${USER_SESSIONS_PREFIX}${userId}`);
    let revoked = 0;
    for (const sessionId of sessionIds) {
      if (sessionId === currentSessionId) continue;
      await this.destroySession(sessionId);
      revoked += 1;
    }
    return revoked;
  }

  async validateSession(sessionId: string): Promise<User | null> {
    const session = await this.getSession(sessionId);
    return session?.user || null;
  }
}
