import { createHash, randomInt } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { permissionGroups, users } from '@/db/schema/index.js';
import type { AuthMailService } from '@/modules/auth/auth-mail.service.js';
import { resolveLiveUser } from '@/modules/auth/live-session-user.js';
import type { CacheService } from '@/services/cache.service.js';
import type { User } from '@/types.js';
import { DEMO_ADMIN_GROUP_NAME, isDemoMode } from './demo-mode.js';

const DEMO_CHALLENGE_PREFIX = 'demo_auth:challenge:';
const DEMO_CHALLENGE_TTL_SECONDS = 10 * 60;
const MAX_DEMO_CHALLENGE_ATTEMPTS = 5;
const CONSUME_DEMO_CHALLENGE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return {0, ''} end
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then
  redis.call('DEL', KEYS[1])
  return {0, ''}
end
local challenge = cjson.decode(raw)
local attempts = tonumber(challenge.attempts) or 0
if attempts >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
  return {0, ''}
end
if challenge.secretHash == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return {1, raw}
end
attempts = attempts + 1
if attempts >= tonumber(ARGV[2]) then
  redis.call('DEL', KEYS[1])
else
  challenge.attempts = attempts
  redis.call('SET', KEYS[1], cjson.encode(challenge), 'PX', ttl)
end
return {0, ''}
`;

interface DemoAuthChallenge {
  email: string;
  userId?: string;
  secretHash: string;
  attempts: number;
}

interface DemoAuthIdentity {
  id: string;
  authMethod: string;
  groupName: string;
  isBlocked: boolean;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashSecret(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

@injectable()
export class DemoAuthService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    private readonly cache: CacheService,
    private readonly mail: AuthMailService
  ) {}

  async requestCode(rawEmail: string): Promise<string | null> {
    if (!isDemoMode()) return null;

    const email = normalizeEmail(rawEmail);
    const identity = await this.findIdentity(email);
    if (identity && !this.isEligibleIdentity(identity)) return null;
    if (!identity && !(await this.findDemoGroup())) return null;

    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const challengeId = nanoid(24);
    await this.cache.set<DemoAuthChallenge>(
      `${DEMO_CHALLENGE_PREFIX}${challengeId}`,
      { email, ...(identity ? { userId: identity.id } : {}), secretHash: hashSecret(code), attempts: 0 },
      DEMO_CHALLENGE_TTL_SECONDS
    );
    await this.mail.sendSecurityEmail(email, { kind: 'email_otp', code });
    return challengeId;
  }

  async verifyCode(challengeId: string, code: string): Promise<User | null> {
    if (!isDemoMode()) return null;

    const key = `${DEMO_CHALLENGE_PREFIX}${challengeId}`;
    const consumed = await this.cache
      .getClient()
      .eval(CONSUME_DEMO_CHALLENGE_SCRIPT, 1, key, hashSecret(code), MAX_DEMO_CHALLENGE_ATTEMPTS);
    if (!Array.isArray(consumed) || Number(consumed[0]) !== 1 || typeof consumed[1] !== 'string') return null;
    const challenge = JSON.parse(consumed[1]) as DemoAuthChallenge;
    const identity = challenge.userId ? { id: challenge.userId } : await this.findOrCreateIdentity(challenge.email);
    const user = identity ? await resolveLiveUser(this.db, identity.id) : null;
    if (!user || user.isBlocked) return null;
    if (user.groupName === DEMO_ADMIN_GROUP_NAME && user.authMethod === 'demo_email_otp') return user;
    if (user.groupName === 'system-admin' && user.scopes.includes('admin:system')) return user;
    return null;
  }

  private async findIdentity(email: string): Promise<DemoAuthIdentity | null> {
    const [identity] = await this.db
      .select({
        id: users.id,
        authMethod: users.authMethod,
        groupName: permissionGroups.name,
        isBlocked: users.isBlocked,
      })
      .from(users)
      .innerJoin(permissionGroups, eq(users.groupId, permissionGroups.id))
      .where(and(eq(users.email, email), isNull(users.deletedAt)))
      .limit(1);
    return identity ?? null;
  }

  private isEligibleIdentity(identity: DemoAuthIdentity): boolean {
    if (identity.isBlocked) return false;
    if (identity.groupName === DEMO_ADMIN_GROUP_NAME) return identity.authMethod === 'demo_email_otp';
    return identity.groupName === 'system-admin' && ['email_otp', 'demo_email_otp'].includes(identity.authMethod);
  }

  private async findDemoGroup() {
    const group = await this.db.query.permissionGroups.findFirst({
      where: eq(permissionGroups.name, DEMO_ADMIN_GROUP_NAME),
    });
    return group?.isBuiltin ? group : null;
  }

  private async findOrCreateIdentity(email: string): Promise<DemoAuthIdentity | null> {
    const existing = await this.findIdentity(email);
    if (existing) return this.isEligibleIdentity(existing) ? existing : null;

    const demoGroup = await this.findDemoGroup();
    if (!demoGroup) return null;

    await this.db
      .insert(users)
      .values({
        authMethod: 'demo_email_otp',
        email,
        name: email,
        groupId: demoGroup.id,
      })
      .onConflictDoNothing({ target: users.email });

    const created = await this.findIdentity(email);
    return created && this.isEligibleIdentity(created) ? created : null;
  }
}

export const __testOnly = {
  DEMO_CHALLENGE_PREFIX,
  DEMO_CHALLENGE_TTL_SECONDS,
};
