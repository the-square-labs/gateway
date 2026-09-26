import { createHash, randomUUID } from 'node:crypto';
import type { Context, Next } from 'hono';
import { container } from '@/container.js';
import { createChildLogger } from '@/lib/logger.js';
import { CacheService, type RedisClient } from '@/services/cache.service.js';
import type { AppEnv } from '@/types.js';

const logger = createChildLogger('Idempotency');

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';
export const IDEMPOTENCY_REPLAYED_HEADER = 'Idempotency-Replayed';
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;
/** Completed results are replayed for this long. */
export const IDEMPOTENCY_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
/** In-progress marker lifetime; a heartbeat extends it while the first request still runs. */
export const IDEMPOTENCY_IN_PROGRESS_TTL_MS = 2 * 60 * 1000;
export const IDEMPOTENCY_RETRY_AFTER_SECONDS = 2;
/** Bodies above this size are not fingerprinted, so the request runs without idempotency. */
export const IDEMPOTENCY_FINGERPRINT_MAX_BYTES = 1024 * 1024;
/** Responses above this size are not stored; the key is released instead. */
export const IDEMPOTENCY_STORED_RESPONSE_MAX_BYTES = 1024 * 1024;

const IN_PROGRESS_HEARTBEAT_MS = 30_000;
const REDIS_TIMEOUT_MS = 1000;
const REDIS_KEY_PREFIX = 'idempotency:v1:';
const RESERVE_ATTEMPTS = 3;
const IDEMPOTENT_METHODS = new Set(['POST', 'PUT', 'PATCH']);
/** Deterministic client errors a retry would reproduce; 401/403 and 5xx are never stored. */
const STORABLE_CLIENT_ERROR_STATUSES = new Set([400, 404, 409, 422]);
const REPLAYED_RESPONSE_HEADERS = ['content-type', 'location', 'etag', 'last-modified'];
const IDEMPOTENCY_KEY_PATTERN = /^[\x20-\x7e]{1,255}$/;

/**
 * Authenticated API routes where the header is ignored: protocols with their own retry semantics,
 * streamed or chunked uploads, and routes that never pass through the authenticated API middleware.
 */
const IDEMPOTENCY_EXCLUDED_PATHS: readonly RegExp[] = [
  // Remote MCP is JSON-RPC over one endpoint; tool calls take an idempotencyKey argument instead.
  /^\/api\/mcp(?:\/|$)/,
  // Inference data plane: provider SDK semantics and streamed responses.
  /^\/api\/inference\/(?:(?:anthropic|codex)\/v1|v1)(?:\/|$)/,
  // Pages deploy API: the upload session carries its own idempotency key.
  /^\/api\/pages-deploy(?:\/|$)/,
  // Streamed request bodies.
  /^\/api\/object-storage\/[^/]+\/objects\/upload$/,
  /^\/api\/docker\/nodes\/[^/]+\/containers\/archive$/,
  /^\/api\/(?:docker\/nodes\/[^/]+\/(?:containers|volumes)\/[^/]+|nodes\/[^/]+)\/files\/uploads\/[^/]+\/chunks$/,
  // Public, setup, OAuth protocol and ingest endpoints, which authenticate on their own.
  /^\/api\/(?:webhooks|public|setup|oauth|logging\/ingest|inference\/setup)(?:\/|$)/,
];

export const IDEMPOTENCY_REDIS_SCRIPTS = {
  complete: `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) return 1 end return 0`,
  release: `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`,
  extend: `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`,
} as const;

export interface IdempotencyScope {
  /** Authenticated principal: the user, or the API/OAuth token id. */
  principal: string;
  method: string;
  path: string;
  key: string;
}

export interface IdempotencyLease<T> {
  complete(payload: T): Promise<void>;
  release(): Promise<void>;
}

export type IdempotencyBeginResult<T> =
  | { kind: 'proceed'; lease: IdempotencyLease<T> }
  | { kind: 'replay'; payload: T }
  | { kind: 'mismatch' }
  | { kind: 'in_progress'; retryAfterSeconds: number }
  | { kind: 'unavailable' };

interface InProgressRecord {
  v: 1;
  state: 'in_progress';
  fingerprint: string;
  owner: string;
  startedAt: number;
}

interface CompletedRecord {
  v: 1;
  state: 'completed';
  fingerprint: string;
  completedAt: number;
  payload: unknown;
}

export interface StoredHttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
}

let unavailableLogged = false;

function reportUnavailable(error: unknown): void {
  if (unavailableLogged) return;
  unavailableLogged = true;
  logger.warn('Idempotency store unavailable; requests run without idempotency until Redis recovers', {
    error: error instanceof Error ? error.message : String(error),
  });
}

function reportAvailable(): void {
  if (!unavailableLogged) return;
  unavailableLogged = false;
  logger.info('Idempotency store available again');
}

export function resetIdempotencyStateForTests(): void {
  unavailableLogged = false;
}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Redis idempotency operation timed out')), REDIS_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function isValidIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && IDEMPOTENCY_KEY_PATTERN.test(value);
}

export function isIdempotencyEligibleRequest(method: string, path: string): boolean {
  if (!IDEMPOTENT_METHODS.has(method.toUpperCase())) return false;
  if (!path.startsWith('/api/')) return false;
  return !IDEMPOTENCY_EXCLUDED_PATHS.some((pattern) => pattern.test(path));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** JSON with object keys sorted, so key order does not change a fingerprint. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object' && (value as object).constructor === Object) {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

export function idempotencyFingerprint(parts: unknown): string {
  return sha256(canonicalJson(parts));
}

export function idempotencyRedisKey(scope: IdempotencyScope): string {
  return `${REDIS_KEY_PREFIX}${sha256(JSON.stringify([scope.principal, scope.method.toUpperCase(), scope.path, scope.key]))}`;
}

function parseRecord(raw: string): InProgressRecord | CompletedRecord | null {
  try {
    const record = JSON.parse(raw) as Partial<InProgressRecord | CompletedRecord>;
    if (record?.v !== 1 || typeof record.fingerprint !== 'string') return null;
    if (record.state === 'in_progress' || record.state === 'completed') {
      return record as InProgressRecord | CompletedRecord;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveRedis(): RedisClient {
  return container.resolve(CacheService).getClient();
}

function createLease<T>(
  redis: RedisClient,
  redisKey: string,
  marker: string,
  fingerprint: string
): IdempotencyLease<T> {
  let settled = false;
  const heartbeat = setInterval(() => {
    withTimeout(
      redis.eval(IDEMPOTENCY_REDIS_SCRIPTS.extend, 1, redisKey, marker, String(IDEMPOTENCY_IN_PROGRESS_TTL_MS))
    ).catch(() => undefined);
  }, IN_PROGRESS_HEARTBEAT_MS);
  heartbeat.unref?.();

  const settle = () => {
    if (settled) return false;
    settled = true;
    clearInterval(heartbeat);
    return true;
  };

  return {
    async complete(payload: T) {
      if (!settle()) return;
      const record: CompletedRecord = { v: 1, state: 'completed', fingerprint, completedAt: Date.now(), payload };
      try {
        await withTimeout(
          redis.eval(
            IDEMPOTENCY_REDIS_SCRIPTS.complete,
            1,
            redisKey,
            marker,
            JSON.stringify(record),
            String(IDEMPOTENCY_RESULT_TTL_MS)
          )
        );
      } catch (error) {
        reportUnavailable(error);
      }
    },
    async release() {
      if (!settle()) return;
      try {
        await withTimeout(redis.eval(IDEMPOTENCY_REDIS_SCRIPTS.release, 1, redisKey, marker));
      } catch (error) {
        reportUnavailable(error);
      }
    },
  };
}

/**
 * Reserve an idempotency key, or report what an earlier request with the same key did.
 * Redis failures return `unavailable`: callers then run without idempotency instead of failing.
 */
export async function beginIdempotentOperation<T>(
  scope: IdempotencyScope,
  fingerprint: string
): Promise<IdempotencyBeginResult<T>> {
  let redis: RedisClient;
  try {
    redis = resolveRedis();
  } catch (error) {
    reportUnavailable(error);
    return { kind: 'unavailable' };
  }

  const redisKey = idempotencyRedisKey(scope);
  const marker = JSON.stringify({
    v: 1,
    state: 'in_progress',
    fingerprint,
    owner: randomUUID(),
    startedAt: Date.now(),
  } satisfies InProgressRecord);

  try {
    for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt += 1) {
      const reserved = await withTimeout(redis.set(redisKey, marker, 'PX', IDEMPOTENCY_IN_PROGRESS_TTL_MS, 'NX'));
      if (reserved === 'OK') {
        reportAvailable();
        return { kind: 'proceed', lease: createLease<T>(redis, redisKey, marker, fingerprint) };
      }
      const existing = await withTimeout(redis.get(redisKey));
      // The earlier record expired between SET NX and GET: try to reserve again.
      if (existing === null) continue;
      reportAvailable();
      const record = parseRecord(existing);
      if (!record) {
        logger.warn('Ignoring an unreadable idempotency record', { redisKey });
        return { kind: 'unavailable' };
      }
      if (record.fingerprint !== fingerprint) return { kind: 'mismatch' };
      if (record.state === 'in_progress') {
        return { kind: 'in_progress', retryAfterSeconds: IDEMPOTENCY_RETRY_AFTER_SECONDS };
      }
      return { kind: 'replay', payload: record.payload as T };
    }
    return { kind: 'in_progress', retryAfterSeconds: IDEMPOTENCY_RETRY_AFTER_SECONDS };
  } catch (error) {
    reportUnavailable(error);
    return { kind: 'unavailable' };
  }
}

/** The authenticated principal a key belongs to: the API/OAuth token, or the (impersonated) user. */
export function idempotencyPrincipal(c: Context<AppEnv>): string | null {
  const authType = c.get('authType');
  if (authType === 'api-token' || authType === 'oauth-token') {
    const tokenId = c.get('authTokenId');
    return tokenId ? `${authType}:${tokenId}` : null;
  }
  const user = c.get('user');
  if (!user) return null;
  const impersonation = c.get('impersonation');
  return impersonation ? `user:${user.id}:impersonated-by:${impersonation.actor.id}` : `user:${user.id}`;
}

function mediaType(value: string | null | undefined): string {
  return value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function isJsonMediaType(type: string): boolean {
  return type === 'application/json' || type.endsWith('+json');
}

/**
 * Read the body for fingerprinting. Only JSON, plain text, and empty bodies qualify: reading
 * multipart or binary bodies here would break handlers that parse or stream them. Hono caches
 * the text, so the handler's own `c.req.json()` still works. `null` means "run without idempotency".
 */
async function readFingerprintBody(c: Context<AppEnv>): Promise<string | null> {
  const contentLength = c.req.header('content-length');
  if (contentLength !== undefined && Number(contentLength) > IDEMPOTENCY_FINGERPRINT_MAX_BYTES) return null;
  const type = mediaType(c.req.header('content-type'));
  if (type && !isJsonMediaType(type) && type !== 'text/plain') return null;
  if (!c.req.raw.body) return '';
  const text = await c.req.text();
  if (Buffer.byteLength(text) > IDEMPOTENCY_FINGERPRINT_MAX_BYTES) return null;
  if (!isJsonMediaType(type) || !text.trim()) return text;
  try {
    return canonicalJson(JSON.parse(text));
  } catch {
    return text;
  }
}

function canonicalQuery(url: string): Array<[string, string]> {
  return [...new URL(url).searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) =>
    leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey < rightKey ? -1 : 1
  );
}

function isStorableResponse(response: Response): boolean {
  const status = response.status;
  if (!(status >= 200 && status < 300) && !STORABLE_CLIENT_ERROR_STATUSES.has(status)) return false;
  if (response.body === null) return true;
  // Streams, SSE, and downloads are never buffered or replayed.
  return isJsonMediaType(mediaType(response.headers.get('content-type')));
}

function replayResponse(stored: StoredHttpResponse): Response {
  const headers = new Headers(stored.headers);
  headers.set(IDEMPOTENCY_REPLAYED_HEADER, 'true');
  const body = Buffer.from(stored.bodyBase64, 'base64');
  const bodyless = stored.status === 204 || stored.status === 205 || stored.status === 304;
  return new Response(bodyless || body.byteLength === 0 ? null : body, { status: stored.status, headers });
}

async function recordResponse(c: Context<AppEnv>, lease: IdempotencyLease<StoredHttpResponse>): Promise<void> {
  try {
    const response = c.res;
    if (!isStorableResponse(response)) {
      await lease.release();
      return;
    }
    const body = Buffer.from(await response.clone().arrayBuffer());
    if (body.byteLength > IDEMPOTENCY_STORED_RESPONSE_MAX_BYTES) {
      logger.warn('Response too large to store for Idempotency-Key replay; key released', {
        path: c.req.path,
        bytes: body.byteLength,
      });
      await lease.release();
      return;
    }
    const headers: Record<string, string> = {};
    for (const name of REPLAYED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    await lease.complete({ status: response.status, headers, bodyBase64: body.toString('base64') });
  } catch (error) {
    logger.warn('Failed to record response for Idempotency-Key replay', {
      error: error instanceof Error ? error.message : String(error),
    });
    await lease.release();
  }
}

const idempotencyHandledContexts = new WeakSet<object>();

/**
 * `Idempotency-Key` support for authenticated mutating API requests. It runs right after
 * authentication (so the key is scoped to the principal) and around the rest of the chain.
 */
export async function runWithIdempotency(c: Context<AppEnv>, next: Next): Promise<Response | undefined> {
  const key = c.req.header(IDEMPOTENCY_KEY_HEADER);
  // Nested routers can authenticate the same request twice; only the outer pass applies the key.
  if (key === undefined || idempotencyHandledContexts.has(c)) {
    await next();
    return undefined;
  }
  idempotencyHandledContexts.add(c);

  const method = c.req.method.toUpperCase();
  const path = c.req.path;
  if (!isIdempotencyEligibleRequest(method, path)) {
    await next();
    return undefined;
  }
  if (!isValidIdempotencyKey(key)) {
    return c.json(
      {
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: `Idempotency-Key must be 1-${IDEMPOTENCY_KEY_MAX_LENGTH} printable ASCII characters`,
      },
      400
    );
  }
  const principal = idempotencyPrincipal(c);
  const body = principal ? await readFingerprintBody(c) : null;
  if (!principal || body === null) {
    await next();
    return undefined;
  }

  const fingerprint = idempotencyFingerprint({ query: canonicalQuery(c.req.url), body });
  const begin = await beginIdempotentOperation<StoredHttpResponse>({ principal, method, path, key }, fingerprint);
  switch (begin.kind) {
    case 'unavailable':
      await next();
      return undefined;
    case 'mismatch':
      return c.json(
        {
          code: 'IDEMPOTENCY_KEY_REUSED',
          message: 'This Idempotency-Key was already used with a different request; use a new key for a new request',
        },
        422
      );
    case 'in_progress':
      c.header('Retry-After', String(begin.retryAfterSeconds));
      return c.json(
        {
          code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
          message: 'A request with this Idempotency-Key is still running; retry after the Retry-After delay',
        },
        409
      );
    case 'replay':
      return replayResponse(begin.payload);
    case 'proceed':
      try {
        await next();
      } catch (error) {
        await begin.lease.release();
        throw error;
      }
      await recordResponse(c, begin.lease);
      return undefined;
  }
}
