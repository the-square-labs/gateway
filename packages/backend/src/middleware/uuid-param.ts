import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '@/types.js';
import { AppError } from './error-handler.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Answer 404 for a path id that is not a UUID, before the route's own middleware (scope checks) and
 * queries run. Without it a literal segment such as `folders` reaches a `uuid` column and the database
 * rejects it with a 500.
 *
 * `requireUuidParam('id', 'CA_NOT_FOUND', 'CA not found')(requireScopeForResource(...))` guards a route and
 * then runs its middleware, so the route keeps a single middleware handler.
 */
export function requireUuidParam(param: string, code: string, message: string) {
  return (then?: MiddlewareHandler<AppEnv>): MiddlewareHandler<AppEnv> =>
    async (c, next) => {
      if (!UUID.test(c.req.param(param) ?? '')) throw new AppError(404, code, message);
      return then ? then(c, next) : next();
    };
}
