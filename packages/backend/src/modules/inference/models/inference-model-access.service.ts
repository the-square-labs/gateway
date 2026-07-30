import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import { inject, injectable } from 'tsyringe';
import { TOKENS } from '@/container.js';
import type { DrizzleClient } from '@/db/client.js';
import { inferenceModelAccessRules, inferenceModels } from '@/db/schema/index.js';
import type { User } from '@/types.js';

const ACCESS_CACHE_TTL_SECONDS = 60;

@injectable()
export class InferenceModelAccessService {
  constructor(
    @inject(TOKENS.DrizzleClient) private readonly db: DrizzleClient,
    @inject(TOKENS.RedisClient) private readonly redis: Redis
  ) {}

  async allowedModelIds(user: User): Promise<Set<string>> {
    if (user.isBlocked || !user.scopes.includes('inference:use')) return new Set();
    const key = this.cacheKey(user);
    const cached = await this.redis.get(key);
    if (cached) return new Set(JSON.parse(cached) as string[]);

    const models = await this.db.select().from(inferenceModels).where(eq(inferenceModels.enabled, true));
    if (models.length === 0) return new Set();
    const rules = await this.db
      .select()
      .from(inferenceModelAccessRules)
      .where(
        and(
          inArray(
            inferenceModelAccessRules.modelId,
            models.map((model) => model.id)
          ),
          inArray(inferenceModelAccessRules.subjectType, ['group', 'user'])
        )
      );
    const allowed = models.flatMap((model) => {
      const permitted = evaluateModelAccess(
        model.defaultAccessAllowed,
        rules.filter((rule) => rule.modelId === model.id),
        user.id,
        user.groupId
      );
      return permitted ? [model.id] : [];
    });
    await this.redis.set(key, JSON.stringify(allowed), 'EX', ACCESS_CACHE_TTL_SECONDS);
    return new Set(allowed);
  }

  async canAccess(user: User, modelId: string): Promise<boolean> {
    return (await this.allowedModelIds(user)).has(modelId);
  }

  async invalidate(): Promise<void> {
    const cursor = { value: '0' };
    do {
      const [next, keys] = await this.redis.scan(cursor.value, 'MATCH', 'inference:model-access:*', 'COUNT', 100);
      cursor.value = next;
      if (keys.length) await this.redis.del(...keys);
    } while (cursor.value !== '0');
  }

  private cacheKey(user: User): string {
    const signature = createHash('sha256')
      .update(`${user.id}:${user.groupId}:${[...user.scopes].sort().join(',')}:${user.isBlocked}`)
      .digest('hex');
    return `inference:model-access:${signature}`;
  }
}

export function evaluateModelAccess(
  defaultAllowed: boolean,
  rules: Array<{
    subjectType: 'group' | 'user';
    groupId: string | null;
    userId: string | null;
    effect: 'allow' | 'deny';
  }>,
  userId: string,
  groupId: string
): boolean {
  const userRule = rules.find((rule) => rule.subjectType === 'user' && rule.userId === userId);
  const groupRule = rules.find((rule) => rule.subjectType === 'group' && rule.groupId === groupId);
  const effect = userRule?.effect ?? groupRule?.effect;
  return effect ? effect === 'allow' : defaultAllowed;
}
