import type Redis from 'ioredis';
export type RedisKeyValueType = 'string' | 'hash' | 'list' | 'set' | 'zset';
export declare function scanRedisKeys(
  client: Redis,
  cursor: number,
  limit: number,
  search?: string,
  type?: string
): Promise<{
  cursor: number;
  done: boolean;
  keys: {
    key: string;
    type: string;
    ttlSeconds: number;
  }[];
}>;
export declare function getRedisKey(
  client: Redis,
  key: string,
  options?: {
    offset?: number;
    limit?: number;
    maxStringBytes?: number;
  }
): Promise<{
  key: string;
  type: string;
  ttlSeconds: number;
  value: unknown;
  page: Record<string, unknown> | undefined;
}>;
export declare function setRedisKey(
  client: Redis,
  key: string,
  valueType: RedisKeyValueType,
  value: unknown,
  ttlSeconds: number | undefined
): Promise<void>;
